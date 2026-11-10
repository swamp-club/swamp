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

import { z } from "zod";
import type { CeilingDocument } from "../domain/access/ceiling.ts";

export const LINK_REQUEST_TIMEOUT_MS = 15_000;
/** swamp-club refuses a longer reason, and refuses an unsafe one */
export const MAX_REFUSAL_REASON = 200;

export const REQUIRES_PLAN_MESSAGE =
  "swamp-club offers links only to a collective on an active trial or a paid plan";

export interface ServeLinkClientConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** what went wrong talking to swamp-club, by what the caller should do about it */
export class ServeLinkError extends Error {
  constructor(
    readonly kind:
      | "not_enabled"
      | "requires_plan"
      | "no_instance"
      | "refused"
      | "not_found"
      | "conflict"
      | "rate_limited"
      | "unavailable"
      | "unauthorized",
    message: string,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ServeLinkError";
  }
}

export interface StartLinkRequest {
  readonly integration: { readonly id: string; readonly name: string };
  readonly external: {
    readonly platform: string;
    readonly team_id: string;
    readonly user_id: string;
    readonly display: string;
    readonly workspace: string;
    readonly email?: string;
  };
  readonly requireEmailMatch: boolean;
  readonly ceiling: CeilingDocument;
  readonly ceilingDigest: string;
}

export interface StartedLink {
  readonly requestId: string;
  readonly consentUrl: string;
  readonly digest: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface LinkIdentity {
  readonly sub: string;
  readonly email: string;
  readonly username: string;
  readonly collectives: readonly string[];
  readonly groups: readonly string[];
}

export type LinkStatus =
  | { readonly status: "pending" | "denied" | "refused" | "expired" }
  | {
    readonly status: "approved";
    readonly digest: string;
    readonly identity?: LinkIdentity;
  };

export type ReportOutcome =
  | { readonly kind: "recorded"; readonly linkId: string }
  | { readonly kind: "refused" }
  | {
    readonly kind: "terminal";
    readonly code: "not_approved" | "person_unavailable" | "already_recorded";
  };

/** swamp-club's own cap on a people read */
export const MAX_PEOPLE_LINK_IDS = 200;

const LinkIdSchema = z.string().min(1).max(200);

const ChangesSchema = z.object({
  ended: z.array(LinkIdSchema).max(1000),
  cursor: z.string().min(1).max(1000),
  more: z.boolean(),
});

export type LinkChanges = z.infer<typeof ChangesSchema>;

const IdentitySchema = z.object({
  sub: z.string().min(1).max(200),
  email: z.string().max(320),
  username: z.string().max(200),
  collectives: z.array(z.string().max(200)).max(200),
  groups: z.array(z.string().max(200)).max(500),
});

const PersonViewSchema = z.discriminatedUnion("state", [
  z.object({
    linkId: LinkIdSchema,
    state: z.literal("active"),
    identity: IdentitySchema,
  }),
  z.object({ linkId: LinkIdSchema, state: z.literal("suspended") }),
  z.object({
    linkId: LinkIdSchema,
    state: z.literal("ended"),
    endedReason: z.string().max(64),
  }),
]);

export type LinkPersonView = z.infer<typeof PersonViewSchema>;

const PeopleSchema = z.object({
  people: z.array(PersonViewSchema).max(MAX_PEOPLE_LINK_IDS),
});

const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

function isUnsafe(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high);
}

/**
 * the strings swamp-club shows a person must be short and free of control or
 * invisible characters, so a reason is cut and cleaned rather than refused
 */
export function displaySafeReason(
  reason: string,
  fallback = "refused",
): string {
  const cleaned = Array.from(reason, (char) => isUnsafe(char) ? " " : char)
    .join("").replace(/\s+/g, " ").trim();
  return (cleaned.length > 0 ? cleaned : fallback).slice(
    0,
    MAX_REFUSAL_REASON,
  );
}

/** the anti-corruption layer for swamp-club's link API; it never logs a body */
export class ServeLinkClient {
  readonly #config: ServeLinkClientConfig;

  constructor(config: ServeLinkClientConfig) {
    this.#config = config;
  }

  async capabilities(signal?: AbortSignal): Promise<{ version: number }> {
    const { status, body } = await this.#call(
      "GET",
      "capabilities",
      undefined,
      signal,
    );
    if (status === 404) {
      throw new ServeLinkError(
        "not_enabled",
        "swamp-club does not offer links to this serve's collective",
      );
    }
    this.#throwFor(status, body);
    return body as { version: number };
  }

  async start(
    request: StartLinkRequest,
    signal?: AbortSignal,
  ): Promise<StartedLink> {
    const { status, body } = await this.#call("POST", "", request, signal);
    if (status === 404) {
      throw new ServeLinkError(
        "not_enabled",
        "swamp-club does not offer links to this serve's collective",
      );
    }
    if (status === 409 && bodyError(body) === "no_instance") {
      throw new ServeLinkError(
        "no_instance",
        "swamp-club has no registered instance for this serve; it registers in oauth mode with a club API key",
        "no_instance",
      );
    }
    if (status === 400 || status === 409) {
      throw new ServeLinkError(
        "refused",
        `swamp-club refused the link: ${bodyError(body) ?? status}`,
        bodyError(body),
      );
    }
    this.#throwFor(status, body);
    const started = body as StartedLink;
    if (
      typeof started.requestId !== "string" ||
      typeof started.consentUrl !== "string" ||
      typeof started.digest !== "string"
    ) {
      throw new ServeLinkError(
        "unavailable",
        "swamp-club answered a start without its fields",
      );
    }
    return started;
  }

  async status(requestId: string, signal?: AbortSignal): Promise<LinkStatus> {
    const { status, body } = await this.#call(
      "GET",
      encodeURIComponent(requestId),
      undefined,
      signal,
    );
    if (status === 404) {
      throw new ServeLinkError(
        "not_found",
        "swamp-club has no such link request",
      );
    }
    this.#throwFor(status, body);
    return body as LinkStatus;
  }

  async report(
    requestId: string,
    outcome: { outcome: "recorded" } | { outcome: "refused"; reason: string },
    signal?: AbortSignal,
  ): Promise<ReportOutcome> {
    const payload = outcome.outcome === "refused"
      ? { outcome: "refused", reason: displaySafeReason(outcome.reason) }
      : outcome;
    const { status, body } = await this.#call(
      "POST",
      `${encodeURIComponent(requestId)}/report`,
      payload,
      signal,
    );
    if (status === 409) {
      const code = bodyError(body);
      if (
        code === "not_approved" || code === "person_unavailable" ||
        code === "already_recorded"
      ) return { kind: "terminal", code };
    }
    if (status === 404) {
      throw new ServeLinkError(
        "not_found",
        "swamp-club has no such link request",
      );
    }
    this.#throwFor(status, body);
    const ack = body as { linkId?: unknown };
    return typeof ack.linkId === "string"
      ? { kind: "recorded", linkId: ack.linkId }
      : { kind: "refused" };
  }

  /** a cursor swamp-club no longer reads answers invalid_cursor; the caller starts over */
  async changes(
    since: string | undefined,
    signal?: AbortSignal,
  ): Promise<LinkChanges | "invalid_cursor"> {
    const { status, body } = await this.#call(
      "GET",
      `changes${
        since !== undefined ? `?since=${encodeURIComponent(since)}` : ""
      }`,
      undefined,
      signal,
    );
    if (status === 400 && bodyError(body) === "invalid_cursor") {
      return "invalid_cursor";
    }
    this.#throwFor(status, body);
    const parsed = ChangesSchema.safeParse(body);
    if (!parsed.success) {
      throw new ServeLinkError(
        "unavailable",
        "swamp-club's link changes reply was not understood",
      );
    }
    return parsed.data;
  }

  /** IDs swamp-club doesn't hold for this client are left out of the reply */
  async people(
    linkIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<LinkPersonView[]> {
    if (linkIds.length > MAX_PEOPLE_LINK_IDS) {
      throw new RangeError(
        `A people read takes at most ${MAX_PEOPLE_LINK_IDS} link IDs`,
      );
    }
    const { status, body } = await this.#call(
      "POST",
      "people",
      { linkIds },
      signal,
    );
    this.#throwFor(status, body);
    const parsed = PeopleSchema.safeParse(body);
    if (!parsed.success) {
      throw new ServeLinkError(
        "unavailable",
        "swamp-club's people reply was not understood",
      );
    }
    const asked = new Set(linkIds);
    return parsed.data.people.filter((view) => asked.has(view.linkId));
  }

  /** a link swamp-club no longer knows is as ended as one it just ended */
  async end(linkId: string, signal?: AbortSignal): Promise<void> {
    const { status, body } = await this.#call(
      "POST",
      `${encodeURIComponent(linkId)}/end`,
      {},
      signal,
    );
    if (status === 404) return;
    this.#throwFor(status, body);
  }

  #throwFor(status: number, body: unknown): void {
    if (status >= 200 && status < 300) return;
    if (status === 403 && bodyError(body) === "links_require_plan") {
      throw new ServeLinkError(
        "requires_plan",
        planMessage(body),
        "links_require_plan",
      );
    }
    if (status === 401 || status === 403) {
      throw new ServeLinkError(
        "unauthorized",
        `swamp-club refused this serve's client (${bodyError(body) ?? status})`,
        bodyError(body),
      );
    }
    if (status === 429) {
      throw new ServeLinkError(
        "rate_limited",
        "swamp-club is rate limiting this serve",
      );
    }
    throw new ServeLinkError(
      "unavailable",
      `swamp-club answered ${status}${
        bodyError(body) ? ` (${bodyError(body)})` : ""
      }`,
      bodyError(body),
    );
  }

  async #call(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${
      this.#config.baseUrl.replace(/\/+$/, "")
    }/api/v1/serve/links${path ? `/${path}` : ""}`;
    const timeout = AbortSignal.timeout(
      this.#config.timeoutMs ?? LINK_REQUEST_TIMEOUT_MS,
    );
    const authorization = `Basic ${
      btoa(`${this.#config.clientId}:${this.#config.clientSecret}`)
    }`;
    let resp: Response;
    try {
      resp = await (this.#config.fetch ?? fetch)(url, {
        method,
        headers: {
          authorization,
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new ServeLinkError(
        "unavailable",
        `swamp-club could not be reached: ${
          error instanceof Error ? error.name : "error"
        }`,
      );
    }
    const text = await resp.text().catch(() => "");
    let body: unknown = {};
    try {
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return { status: resp.status, body };
  }
}

// the app shows this message to a person, so it is cleaned like a refusal reason
function planMessage(body: unknown): string {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string"
    ? displaySafeReason(message, REQUIRES_PLAN_MESSAGE)
    : REQUIRES_PLAN_MESSAGE;
}

function bodyError(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error.slice(0, 64) : undefined;
}
