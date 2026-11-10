// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import {
  type CeilingDocument,
  DELEGATION_ROUTE_PREFIX,
  type LinkPersonBody,
  type LinkStartedBody,
  type RefreshRefusalReason,
} from "./http_protocol.ts";
import { SwampHttpError } from "./http_errors.ts";
import {
  errorFrom,
  type HttpClientOptions,
  type HttpReply,
  HttpTransport,
  refusedBeforeActing,
  refuseInBrowser,
} from "./http_transport.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SwampIntegrationClientOptions extends HttpClientOptions {
  /** the integration credential an operator registered, `swi1.<id>.<secret>` */
  credential: string;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface StartLinkInput {
  external: {
    platform: string;
    teamId: string;
    userId: string;
    display: string;
    workspace: string;
    email?: string;
  };
  ceiling: CeilingDocument;
}

/** an access token with the deadline this process should refresh it by */
export interface DelegatedTokenSet {
  delegationId: string;
  accessToken: string;
  /** when serve says the access token ends, on serve's clock */
  accessTokenExpiresAt: string;
  /** when the access token ends on this process's clock */
  accessTokenDeadlineMs: number;
  /** how long the access token was issued for, in milliseconds */
  accessTokenLifetimeMs: number;
  refreshToken: string;
  /** when the delegation itself ends */
  expiresAt?: string;
}

export type RedeemOutcome =
  | { kind: "pending"; intervalSeconds: number }
  | { kind: "issued"; tokens: DelegatedTokenSet; person: LinkPersonBody }
  | { kind: "refused"; reason: string }
  | { kind: "ended"; cause: string }
  | { kind: "already_redeemed" };

export type RefreshOutcome =
  | {
    kind: "refreshed";
    accessToken: string;
    accessTokenExpiresAt: string;
    accessTokenDeadlineMs: number;
    accessTokenLifetimeMs: number;
    /** sent only by an older serve that still rotates it */
    refreshToken?: string;
    expiresAt?: string;
  }
  | {
    kind: "link_ended";
    reason: Exclude<
      RefreshRefusalReason,
      "mismatch" | "not_admitted" | "suspended" | "links_unavailable"
    >;
  }
  | { kind: "not_admitted" }
  /** refused for now, the link kept: the person is suspended, or swamp-club can't vouch for it */
  | { kind: "suspended"; reason: "suspended" | "links_unavailable" }
  /** the refresh token isn't this link's current one; the link is untouched */
  | { kind: "mismatch" };

/**
 * measures the token's life against serve's own clock, so a skewed clock here
 * moves nothing; the local deadline is that life from when the reply arrived
 */
export function accessTokenTiming(
  reply: Pick<HttpReply, "serverDateMs" | "receivedAtMs">,
  accessTokenExpiresAt: string,
  expiresInSeconds?: number,
): { lifetimeMs: number; deadlineMs: number } {
  const expires = Date.parse(accessTokenExpiresAt);
  const lifetimeMs = reply.serverDateMs !== undefined
    ? expires - reply.serverDateMs
    : expiresInSeconds !== undefined
    ? expiresInSeconds * 1000
    : expires - reply.receivedAtMs;
  // an unreadable expiry counts as already due
  const bounded = Number.isFinite(lifetimeMs) ? Math.max(0, lifetimeMs) : 0;
  return { lifetimeMs: bounded, deadlineMs: reply.receivedAtMs + bounded };
}

const ROUTE = {
  links: "delegations/links",
  redeem: "delegations/redeem",
  refresh: "delegations/refresh",
  end: "delegations/end",
} as const;

/** serve's link and token routes, authenticated with the integration credential */
export class SwampIntegrationClient {
  readonly #credential: string;
  readonly #transport: HttpTransport;
  // a lost refresh reply is resent only once serve has shown it keeps the
  // refresh token: an older serve that rotates would end the link on a resend
  #serveKeepsToken = false;

  constructor(url: string, options: SwampIntegrationClientOptions) {
    refuseInBrowser("SwampIntegrationClient");
    this.#credential = options.credential;
    this.#transport = new HttpTransport(url, DEFAULT_TIMEOUT_MS, options);
  }

  /** starts a link; show consentUrl only to the person it names */
  async startLink(
    input: StartLinkInput,
    options: CallOptions = {},
  ): Promise<LinkStartedBody> {
    const reply = await this.#post(
      "links",
      {
        external: {
          platform: input.external.platform,
          team_id: input.external.teamId,
          user_id: input.external.userId,
          display: input.external.display,
          workspace: input.external.workspace,
          ...(input.external.email !== undefined
            ? { email: input.external.email }
            : {}),
        },
        ceiling: input.ceiling,
      },
      options,
      refusedBeforeActing,
    );
    if (reply.status !== 201) throw errorFrom(reply, ROUTE.links);
    return reply.body as unknown as LinkStartedBody;
  }

  /**
   * polls a link, and once the person consents returns its tokens, once only;
   * a lost reply here loses them, and the person links again
   */
  async redeemLink(
    link: { pendingId: string; redeemSecret: string },
    options: CallOptions = {},
  ): Promise<RedeemOutcome> {
    const reply = await this.#post(
      "redeem",
      { pendingId: link.pendingId, redeemSecret: link.redeemSecret },
      options,
      refusedBeforeActing,
    );
    const body = reply.body;
    if (reply.status === 202 && body.status === "pending") {
      return { kind: "pending", intervalSeconds: Number(body.interval) };
    }
    if (reply.status === 409 && reply.code === "already_redeemed") {
      return { kind: "already_redeemed" };
    }
    if (reply.status === 200 && body.status === "refused") {
      return { kind: "refused", reason: String(body.reason) };
    }
    if (reply.status === 200 && body.status === "ended") {
      return { kind: "ended", cause: String(body.cause) };
    }
    if (reply.status === 200 && body.status === "issued") {
      const expiresAt = String(body.accessTokenExpiresAt);
      const timing = accessTokenTiming(reply, expiresAt);
      return {
        kind: "issued",
        tokens: {
          delegationId: String(body.delegationId),
          accessToken: String(body.accessToken),
          accessTokenExpiresAt: expiresAt,
          accessTokenDeadlineMs: timing.deadlineMs,
          accessTokenLifetimeMs: timing.lifetimeMs,
          refreshToken: String(body.refreshToken),
          ...(typeof body.expiresAt === "string"
            ? { expiresAt: body.expiresAt }
            : {}),
        },
        person: (body.person ?? {}) as LinkPersonBody,
      };
    }
    throw errorFrom(reply, ROUTE.redeem);
  }

  /**
   * a new access token; the refresh token stays the same, so racing or
   * repeated refreshes are harmless
   */
  async refresh(
    refreshToken: string,
    options: CallOptions = {},
  ): Promise<RefreshOutcome> {
    const reply = await this.#post(
      "refresh",
      { refreshToken },
      options,
      (r) =>
        (r.status === 0 && this.#serveKeepsToken) || r.code === "not_saved" ||
        refusedBeforeActing(r),
    );
    const body = reply.body;
    if (reply.status === 200) {
      this.#serveKeepsToken = typeof body.refreshToken !== "string";
      const expiresAt = String(body.accessTokenExpiresAt);
      const timing = accessTokenTiming(
        reply,
        expiresAt,
        typeof body.expiresIn === "number" ? body.expiresIn : undefined,
      );
      return {
        kind: "refreshed",
        accessToken: String(body.accessToken),
        accessTokenExpiresAt: expiresAt,
        accessTokenDeadlineMs: timing.deadlineMs,
        accessTokenLifetimeMs: timing.lifetimeMs,
        ...(typeof body.refreshToken === "string"
          ? { refreshToken: body.refreshToken }
          : {}),
        ...(typeof body.expiresAt === "string"
          ? { expiresAt: body.expiresAt }
          : {}),
      };
    }
    if (reply.status === 401 && reply.code === "invalid_grant") {
      if (typeof body.reason !== "string") {
        return { kind: "link_ended", reason: "unknown" };
      }
      this.#serveKeepsToken = true;
      const reason = body.reason as RefreshRefusalReason;
      if (reason === "not_admitted") return { kind: "not_admitted" };
      if (reason === "mismatch") return { kind: "mismatch" };
      if (reason === "suspended" || reason === "links_unavailable") {
        return { kind: "suspended", reason };
      }
      return { kind: "link_ended", reason };
    }
    throw errorFrom(reply, ROUTE.refresh);
  }

  /** ends the link, with either its access or its refresh token */
  async endLink(token: string, options: CallOptions = {}): Promise<void> {
    const reply = await this.#post(
      "end",
      { token },
      options,
      (r) => r.status === 0 || refusedBeforeActing(r),
    );
    if (reply.status === 200) return;
    if (reply.status === 401 && reply.code === "invalid_grant") {
      throw new SwampHttpError({
        status: 401,
        code: "link_ended",
        message: "The link has already ended or the token was refused",
        route: ROUTE.end,
      });
    }
    throw errorFrom(reply, ROUTE.end);
  }

  #post(
    name: keyof typeof ROUTE,
    body: unknown,
    options: CallOptions,
    retry: (reply: HttpReply) => boolean,
  ): Promise<HttpReply> {
    return this.#transport.post(
      `${DELEGATION_ROUTE_PREFIX}${name}`,
      this.#credential,
      body,
      {
        route: ROUTE[name],
        retry,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  toJSON(): Record<string, unknown> {
    return { client: "SwampIntegrationClient", credential: "[redacted]" };
  }

  [Symbol.for("Deno.customInspect")](): string {
    return "SwampIntegrationClient { credential: [redacted] }";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "SwampIntegrationClient { credential: [redacted] }";
  }
}
