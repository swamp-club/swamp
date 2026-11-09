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

import type { TokenAdmissionChecker } from "./token_admission.ts";
import { z } from "zod";
import { Ceiling } from "../domain/access/ceiling.ts";
import {
  accessTokenHeld,
  canonicalExternalKey,
  DELEGATED_ACCESS_LIFE_MS,
  delegationStanding,
  issueDelegationTokens,
  refreshDelegation,
  type RefreshOutcome,
  type RefreshRefusalReason,
  startDelegation,
} from "../domain/access/delegation.ts";
import type { DelegationDirectory } from "../domain/access/delegation_directory.ts";
import {
  delegatedSecretMatches,
  issueDelegatedSecret,
  parseDelegatedSecret,
} from "../domain/access/delegated_token.ts";
import type { IntegrationDirectory } from "../domain/access/integration_directory.ts";
import { verifyIntegrationCredential } from "../domain/access/integration_credential.ts";
import {
  type DelegationRecord,
  ExternalIdentitySchema,
} from "../domain/models/access/delegation_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { DelegationCapability } from "./delegation_capability_check.ts";
import {
  type DelegationAuditEvent,
  endLocally,
} from "./delegation_link_service.ts";
import {
  type DelegationStore,
  DelegationWriteFailed,
} from "./delegation_store.ts";
import { type FollowerGate, followerHttpForward } from "./follower_requests.ts";
import {
  bearerToken,
  httpFailure,
  tooManyRequests,
} from "./http_caller_auth.ts";
import type { LeaderLink } from "./leader_link.ts";
import { limitFailedAttempts } from "./rate_limiter.ts";
import { type ServeLinkClient, ServeLinkError } from "./serve_link_client.ts";
import { hasJsonContentType } from "./signal_http.ts";
import { readBodyWithLimit } from "./webhook.ts";

const logger = getSwampLogger(["serve", "delegation-routes"]);

export const DELEGATION_ROUTE_PREFIX = "/api/v1/delegations/";
export const MAX_DELEGATION_BODY_BYTES = 16 * 1024;
/** pending links per integration, so one app cannot crowd out every other */
export const MAX_PENDING_LINKS_PER_INTEGRATION = 50;

const ROUTES = {
  links: "delegation.start",
  redeem: "delegation.redeem",
  refresh: "delegation.refresh",
  end: "delegation.end",
} as const;

type RouteName = keyof typeof ROUTES;

export function matchDelegationRoute(pathname: string): RouteName | undefined {
  if (!pathname.startsWith(DELEGATION_ROUTE_PREFIX)) return undefined;
  const name = pathname.slice(DELEGATION_ROUTE_PREFIX.length);
  return name in ROUTES ? name as RouteName : undefined;
}

export interface DelegationAuditRecord
  extends Omit<DelegationAuditEvent, "action"> {
  readonly action:
    | DelegationAuditEvent["action"]
    | "link_started"
    | "tokens_issued"
    | "refreshed";
}

export interface DelegationRouteDeps {
  readonly integrations: Pick<
    IntegrationDirectory,
    "credentialOf" | "standingOf"
  >;
  readonly directory: Pick<DelegationDirectory, "all" | "supersededBy">;
  readonly store: DelegationStore;
  readonly client: () => ServeLinkClient | undefined;
  readonly capability: () => Promise<DelegationCapability>;
  readonly followerGate?: FollowerGate;
  readonly leaderLink?: LeaderLink;
  readonly audit?: (event: DelegationAuditRecord) => void;
  readonly now?: () => number;
  /** null outside OAuth mode */
  readonly admission: TokenAdmissionChecker | null;
}

const StartBodySchema = z.object({
  external: z.object({
    platform: z.string(),
    team_id: z.string(),
    user_id: z.string(),
    display: z.string(),
    workspace: z.string(),
    email: z.string().optional(),
  }),
  ceiling: z.unknown(),
});

const RedeemBodySchema = z.object({
  pendingId: z.string().uuid(),
  redeemSecret: z.string().max(200),
});

const TokenBodySchema = z.object({ token: z.string().max(200) });
const RefreshBodySchema = z.object({ refreshToken: z.string().max(200) });

/** every code these routes answer with, beside a forwarding node's 503s */
export const DELEGATION_ROUTE_CODES = [
  "already_redeemed",
  "ceiling_too_wide",
  "club_busy",
  "club_refused",
  "club_unavailable",
  "email_required",
  "internal_error",
  "invalid_ceiling",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "links_not_enabled",
  "links_unavailable",
  "method_not_allowed",
  "no_instance",
  "not_found",
  "not_saved",
  "payload_too_large",
  "rate_limited",
  "team_not_ready",
  "team_unknown",
  "too_many_pending",
  "unsupported_media_type",
] as const;

export type DelegationRouteCode = typeof DELEGATION_ROUTE_CODES[number];

export interface DelegationFailureBody {
  readonly code: DelegationRouteCode;
  readonly message: string;
  /** on a refused refresh only */
  readonly reason?: RefreshRefusalReason;
}

export interface LinkStartedBody {
  readonly pendingId: string;
  readonly redeemSecret: string;
  readonly consentUrl: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface LinkPersonBody {
  readonly username?: string;
  readonly email?: string;
}

export interface TokensIssuedBody {
  readonly status: "issued";
  readonly delegationId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly expiresAt?: string;
  readonly person: LinkPersonBody;
}

export type RedeemBody =
  | { readonly status: "pending"; readonly interval: number }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "ended"; readonly cause: string }
  | TokensIssuedBody;

/** the refresh token is kept, so a refresh answers only a new access token */
export interface RefreshedBody {
  readonly status: "refreshed";
  readonly delegationId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly expiresIn: number;
  readonly expiresAt?: string;
  readonly person: LinkPersonBody;
}

export interface EndedBody {
  readonly ended: true;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    // tokens travel in these bodies, so nothing in between may keep one
    headers: { "cache-control": "no-store" },
  });
}

/**
 * the app proves itself with its integration credential on every route; a
 * follower checks it against its own directory, then forwards before reading
 * the body, so the leader alone decides and writes
 */
export async function handleDelegationRequest(
  req: Request,
  route: RouteName,
  sourceIp: string,
  deps: DelegationRouteDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return httpFailure(405, "method_not_allowed", "Use POST");
  }
  const credential = bearerToken(req);
  if (credential === null) {
    return httpFailure(
      401,
      "invalid_client",
      "The integration credential is required",
    );
  }
  const guarded = await limitFailedAttempts(
    `integration-credential|address:${sourceIp}`,
    () => verifyIntegrationCredential(credential, deps.integrations),
  );
  if (guarded.limited) return tooManyRequests(guarded.retryAfterSeconds);
  const auth = guarded.result;
  if (!auth.ok) {
    return httpFailure(
      401,
      "invalid_client",
      "The integration credential was refused",
    );
  }
  const forwarded = followerHttpForward(ROUTES[route], req, {
    followerGate: deps.followerGate,
    leaderLink: deps.leaderLink,
  });
  if (forwarded !== undefined) return await forwarded;

  if (!hasJsonContentType(req)) {
    return httpFailure(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
    );
  }
  const bytes = await readBodyWithLimit(req, MAX_DELEGATION_BODY_BYTES);
  if (bytes === null) {
    return httpFailure(413, "payload_too_large", "Request body is too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return httpFailure(400, "invalid_request", "Invalid JSON");
  }
  const integration = {
    id: auth.integrationId,
    requireEmailMatch: auth.requireEmailMatch,
  };
  try {
    switch (route) {
      case "links":
        return await start(body, integration, sourceIp, deps);
      case "redeem":
        return await redeem(body, integration.id, sourceIp, deps);
      case "refresh":
        return await refresh(body, integration.id, sourceIp, deps);
      case "end":
        return await end(body, integration.id, deps);
    }
  } catch (error) {
    if (error instanceof DelegationWriteFailed) {
      return httpFailure(
        503,
        "not_saved",
        "The change was not published yet and no new token was issued; retry shortly",
      );
    }
    logger.error`Delegation ${route} failed: ${error}`;
    return httpFailure(500, "internal_error", "The request failed");
  }
}

function clubFailure(error: ServeLinkError): Response {
  switch (error.kind) {
    case "not_enabled":
      return httpFailure(
        409,
        "links_not_enabled",
        "swamp-club does not offer links to this serve's collective",
      );
    case "no_instance":
      return httpFailure(
        409,
        "no_instance",
        "swamp-club has no registered instance for this serve",
      );
    case "refused":
      return httpFailure(
        400,
        "club_refused",
        `swamp-club refused the link (${error.code ?? "invalid"})`,
      );
    case "rate_limited":
      return httpFailure(
        503,
        "club_busy",
        "swamp-club is rate limiting this serve; retry shortly",
      );
    default:
      return httpFailure(
        502,
        "club_unavailable",
        "swamp-club could not be reached or refused this serve",
      );
  }
}

async function start(
  body: unknown,
  integration: { id: string; requireEmailMatch: boolean },
  sourceIp: string,
  deps: DelegationRouteDeps,
): Promise<Response> {
  const parsed = StartBodySchema.safeParse(body);
  if (!parsed.success) {
    return httpFailure(
      400,
      "invalid_request",
      "external and ceiling are required",
    );
  }
  const raw = parsed.data.external;
  const external = ExternalIdentitySchema.safeParse({
    platform: raw.platform,
    teamId: raw.team_id,
    userId: raw.user_id,
    display: raw.display,
    workspace: raw.workspace,
    ...(raw.email !== undefined ? { email: raw.email } : {}),
  });
  if (!external.success) {
    return httpFailure(
      400,
      "invalid_request",
      `external is invalid: ${external.error.issues[0]?.path.join(".")}`,
    );
  }
  if (integration.requireEmailMatch && external.data.email === undefined) {
    return httpFailure(
      400,
      "email_required",
      "This integration requires the person's email, so swamp-club can check it",
    );
  }
  let ceiling: Ceiling;
  try {
    ceiling = Ceiling.parse(parsed.data.ceiling);
  } catch (error) {
    return httpFailure(
      400,
      "invalid_ceiling",
      error instanceof Error ? error.message : String(error),
    );
  }
  const live = deps.integrations.standingOf(integration.id);
  if (live.kind !== "active" || !ceiling.isWithin(live.ceiling)) {
    return httpFailure(
      400,
      "ceiling_too_wide",
      "The requested ceiling must be within the integration's ceiling",
    );
  }
  const team = await deps.capability().catch(() => null);
  if (team === null) {
    return httpFailure(
      503,
      "team_unknown",
      "This serve could not read which nodes are live; retry shortly",
    );
  }
  if (!team.ok) {
    return httpFailure(
      409,
      "team_not_ready",
      `Every serve node must be upgraded before links are made; not yet: ${
        team.instances.join(", ")
      }`,
    );
  }
  const all = deps.directory.all();
  const pending = all.filter((r) =>
    r.integrationId === integration.id &&
    (r.phase === "awaiting_consent" || r.phase === "reporting")
  );
  if (pending.length >= MAX_PENDING_LINKS_PER_INTEGRATION) {
    return httpFailure(
      429,
      "too_many_pending",
      "Too many links are waiting for consent for this integration",
    );
  }
  const client = deps.client();
  if (client === undefined) {
    return httpFailure(
      503,
      "links_unavailable",
      "This serve links people only in oauth mode with its swamp-club client",
    );
  }
  const name = deps.integrations.credentialOf(integration.id)?.name ??
    integration.id;
  const ceilingDigest = await ceiling.digest();
  let started;
  try {
    await client.capabilities();
    started = await client.start({
      integration: { id: integration.id, name },
      external: {
        platform: external.data.platform,
        team_id: external.data.teamId,
        user_id: external.data.userId,
        display: external.data.display,
        workspace: external.data.workspace,
        ...(external.data.email !== undefined
          ? { email: external.data.email }
          : {}),
      },
      requireEmailMatch: integration.requireEmailMatch,
      ceiling: ceiling.toDocument(),
      ceilingDigest,
    });
  } catch (error) {
    if (error instanceof ServeLinkError) return clubFailure(error);
    throw error;
  }
  const now = deps.now?.() ?? Date.now();
  const id = crypto.randomUUID();
  const redeem = await issueDelegatedSecret("redeem", id);
  const record = startDelegation({
    id,
    integrationId: integration.id,
    external: external.data,
    ceiling,
    ceilingDigest,
    redeemHash: redeem.hash,
    requestId: started.requestId,
    digest: started.digest,
    consentExpiresAt: new Date(now + started.expiresIn * 1000).toISOString(),
    pollIntervalSeconds: Math.max(
      1,
      Math.min(3600, Math.round(started.interval)),
    ),
  }, now);
  await deps.store.create(record);
  // a second start for the same person replaces the first, whose consent URL
  // may be lost; if swamp-club approves the old one anyway, nothing issues
  const key = canonicalExternalKey(integration.id, record.external);
  for (const old of pending) {
    if (canonicalExternalKey(old.integrationId, old.external) !== key) continue;
    await endLocally(deps.store, old.id, "replaced", now, deps.audit);
  }
  deps.audit?.({
    action: "link_started",
    record,
    outcome: "started",
    detail: `from=${sourceIp}`,
  });
  return json(
    {
      pendingId: id,
      redeemSecret: redeem.value,
      consentUrl: started.consentUrl,
      expiresIn: started.expiresIn,
      interval: record.club.pollIntervalSeconds,
    } satisfies LinkStartedBody,
    201,
  );
}

function personBody(record: DelegationRecord): LinkPersonBody {
  return { username: record.person?.username, email: record.person?.email };
}

function tokensBody(
  record: DelegationRecord,
  tokens: {
    access: { value: string };
    refresh: { value: string };
    accessExpiresAt: string;
  },
): TokensIssuedBody {
  return {
    status: "issued",
    delegationId: record.id,
    accessToken: tokens.access.value,
    accessTokenExpiresAt: tokens.accessExpiresAt,
    refreshToken: tokens.refresh.value,
    expiresAt: record.expiresAt,
    person: personBody(record),
  };
}

async function redeem(
  body: unknown,
  integrationId: string,
  sourceIp: string,
  deps: DelegationRouteDeps,
): Promise<Response> {
  const parsed = RedeemBodySchema.safeParse(body);
  if (!parsed.success) {
    return httpFailure(
      400,
      "invalid_request",
      "pendingId and redeemSecret are required",
    );
  }
  const { pendingId, redeemSecret } = parsed.data;
  const guarded = await limitFailedAttempts(
    `delegation-redeem:${integrationId}|address:${sourceIp}`,
    async () => {
      const record = await deps.store.readOrNull(pendingId);
      const ok = record !== null && record.integrationId === integrationId &&
        await delegatedSecretMatches(redeemSecret, record.redeemHash);
      return { ok, record };
    },
  );
  if (guarded.limited) return tooManyRequests(guarded.retryAfterSeconds);
  const record = guarded.result.record;
  if (!guarded.result.ok || record === null) {
    return httpFailure(404, "not_found", "No such pending link");
  }
  switch (record.phase) {
    case "awaiting_consent":
    case "reporting":
      return json(
        {
          status: "pending",
          interval: record.club.pollIntervalSeconds,
        } satisfies RedeemBody,
        202,
      );
    case "refused":
      return json(
        {
          status: "refused",
          reason: record.refusal?.reason ?? "refused",
        } satisfies RedeemBody,
      );
    case "issued":
      return httpFailure(
        409,
        "already_redeemed",
        "This link's tokens were already issued",
      );
    case "ended":
      return json(
        {
          status: "ended",
          cause: record.ended?.cause ?? "ended",
        } satisfies RedeemBody,
      );
    case "consented":
      break;
  }
  const team = await deps.capability().catch(() => null);
  if (team === null) {
    return httpFailure(
      503,
      "team_unknown",
      "This serve could not read which nodes are live; retry shortly",
    );
  }
  if (!team.ok) {
    return httpFailure(
      409,
      "team_not_ready",
      `Every serve node must be upgraded first; not yet: ${
        team.instances.join(", ")
      }`,
    );
  }
  const now = deps.now?.() ?? Date.now();
  const issued = await deps.store.transition(pendingId, async (current) => {
    if (current?.phase !== "consented") {
      return { write: null, value: null };
    }
    const result = await issueDelegationTokens(current, now);
    return { write: result.record, value: result };
  });
  if (issued === null) {
    return httpFailure(
      409,
      "already_redeemed",
      "This link's tokens were already issued",
    );
  }
  deps.audit?.({
    action: "tokens_issued",
    record: issued.record,
    outcome: "issued",
  });
  return json(tokensBody(issued.record, issued.tokens));
}

async function refresh(
  body: unknown,
  integrationId: string,
  sourceIp: string,
  deps: DelegationRouteDeps,
): Promise<Response> {
  const parsed = RefreshBodySchema.safeParse(body);
  const secret = parsed.success
    ? parseDelegatedSecret(parsed.data.refreshToken)
    : null;
  if (!parsed.success || secret === null || secret.kind !== "refresh") {
    return httpFailure(400, "invalid_request", "refreshToken is required");
  }
  const id = secret.delegationId;
  const guarded = await limitFailedAttempts(
    `delegation-refresh:${integrationId}|address:${sourceIp}`,
    async () => {
      const known = await deps.store.readOrNull(id);
      if (known === null || known.integrationId !== integrationId) {
        return { ok: false, refusal: "unknown" as const };
      }
      // an ended link is an answer, not a guess, so it is no failed attempt
      if (known.tokens === undefined) {
        return { ok: true, refusal: "not_issued" as const };
      }
      const matches = await delegatedSecretMatches(
        parsed.data.refreshToken,
        known.tokens.refreshHash,
      );
      return matches
        ? { ok: true }
        : { ok: false, refusal: "mismatch" as const };
    },
  );
  if (guarded.limited) return tooManyRequests(guarded.retryAfterSeconds);
  if (guarded.result.refusal !== undefined) {
    return refreshRefused(guarded.result.refusal);
  }
  const team = await deps.capability().catch(() => null);
  if (team === null || !team.ok) {
    // nothing changes: the app retries the same token
    return httpFailure(
      503,
      "team_not_ready",
      "Tokens can't be refreshed until every serve node is upgraded; retry later",
    );
  }
  const now = deps.now?.() ?? Date.now();
  const outcome = await deps.store.transition<RefreshOutcome>(
    id,
    async (current) => {
      if (current === null) {
        return {
          write: null,
          value: { kind: "refused" as const, reason: "unknown" },
        };
      }
      // a denial, not an end: the link refreshes again once the person is
      // admitted again
      if (
        deps.admission !== null && current.person !== undefined &&
        !deps.admission.delegation(current.person).admitted
      ) {
        return {
          write: null,
          value: { kind: "refused" as const, reason: "not_admitted" },
        };
      }
      const standing = delegationStanding(
        current,
        now,
        deps.directory.supersededBy(id),
      );
      const result = await refreshDelegation(
        current,
        parsed.data.refreshToken,
        now,
        standing,
      );
      return result.kind === "refused"
        ? { write: null, value: result }
        : { write: result.record, value: result };
    },
  );
  if (outcome.kind === "refused") return refreshRefused(outcome.reason);
  deps.audit?.({
    action: "refreshed",
    record: outcome.record,
    outcome: "refreshed",
  });
  return json(
    {
      status: "refreshed",
      delegationId: outcome.record.id,
      accessToken: outcome.access.value,
      accessTokenExpiresAt: outcome.accessExpiresAt,
      expiresIn: Math.round(DELEGATED_ACCESS_LIFE_MS / 1000),
      expiresAt: outcome.record.expiresAt,
      person: personBody(outcome.record),
    } satisfies RefreshedBody,
  );
}

function refreshRefused(reason: RefreshRefusalReason): Response {
  return Response.json(
    {
      code: "invalid_grant",
      message: `The link can't be refreshed (${reason})`,
      reason,
    } satisfies DelegationFailureBody,
    { status: 401 },
  );
}

async function end(
  body: unknown,
  integrationId: string,
  deps: DelegationRouteDeps,
): Promise<Response> {
  const parsed = TokenBodySchema.safeParse(body);
  const secret = parsed.success
    ? parseDelegatedSecret(parsed.data.token)
    : null;
  if (!parsed.success || secret === null || secret.kind === "redeem") {
    return httpFailure(
      400,
      "invalid_request",
      "token (an access or refresh token) is required",
    );
  }
  const record = await deps.store.readOrNull(secret.delegationId);
  const matches = record !== null &&
    (secret.kind === "access"
      ? await accessTokenHeld(record, parsed.data.token)
      : await delegatedSecretMatches(
        parsed.data.token,
        record.tokens?.refreshHash,
      ));
  if (record === null || record.integrationId !== integrationId || !matches) {
    return httpFailure(401, "invalid_grant", "The token was refused");
  }
  await endLocally(
    deps.store,
    record.id,
    "app_ended",
    deps.now?.() ?? Date.now(),
    deps.audit,
  );
  return json({ ended: true } satisfies EndedBody);
}
