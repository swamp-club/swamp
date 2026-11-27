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
import {
  formatUntrustedIssues,
  parseUntrusted,
} from "../../domain/untrusted_parse.ts";
import {
  Fingerprint,
  FingerprintSchema,
} from "../../domain/serve/fingerprint.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";
import { joinIdOf, joinTokenNameOf } from "../../domain/serve/join_token.ts";
import {
  MemberCredential,
  MemberCredentialError,
} from "../../domain/serve/member_credential.ts";
import { CHECK_IN_INTERVAL_SECONDS } from "../../domain/serve/serve_member.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import {
  checkIpBurst,
  failedAttemptKey,
  limitFailedAttempts,
} from "../rate_limiter.ts";
import { readBodyWithLimit } from "../webhook.ts";
import type { ForwardOptions } from "../leader_link.ts";
import type { FederationAudit } from "./federation_audit.ts";
import type { FederationHub } from "./federation_hub.ts";

const logger = getSwampLogger(["serve", "federation"]);

export const FEDERATION_JOIN_PATH = "/federation/v1/join";
export const FEDERATION_CHECK_IN_PATH = "/federation/v1/check-in";

/** span routes, passed to traceHttpRequests only on a serve that built a hub */
export const FEDERATION_HUB_ROUTES: ReadonlySet<string> = new Set([
  FEDERATION_JOIN_PATH,
  FEDERATION_CHECK_IN_PATH,
]);

export const FEDERATION_PROTOCOL_VERSION = 1;
export const MAX_FEDERATION_BODY_BYTES = 64 * 1024;
export const MAX_CAPABILITIES = 64;
const MAX_ISSUES_SHOWN = 3;

/** carried only by successful join and check-in replies */
export interface HubIdentity {
  readonly name: string;
  readonly swampVersion: string;
  readonly protocolVersion: typeof FEDERATION_PROTOCOL_VERSION;
}

export function hubIdentity(hub: Pick<FederationHub, "hubName">): HubIdentity {
  return {
    name: hub.hubName,
    swampVersion: VERSION,
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
  };
}

export function isFederationHubPath(pathname: string): boolean {
  return FEDERATION_HUB_ROUTES.has(pathname);
}

// one body for each kind, whatever the reason, so a reply never tells the reasons apart
const INVALID_JOIN_TOKEN = {
  error: "invalid_join_token",
  message: "The join token is not valid",
} as const;
const INVALID_CREDENTIAL = {
  error: "unauthorized",
  message: "The member credential is not valid",
} as const;

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function badRequest(message: string): Response {
  return json(400, { error: "invalid_request", message });
}

function tooLarge(): Response {
  return json(413, {
    error: "payload_too_large",
    message: `The request body exceeds ${MAX_FEDERATION_BODY_BYTES} bytes`,
  });
}

function rateLimited(retryAfterSeconds: number): Response {
  return json(429, {
    error: "rate_limited",
    message: "Too many requests; retry later",
  }, { "retry-after": String(retryAfterSeconds) });
}

function failed(error: unknown): Response {
  logger.warn("A federation request failed: {error}", {
    error: error instanceof Error ? error.message : String(error),
  });
  return json(500, {
    error: "internal_error",
    message: "The hub could not complete the request",
  });
}

// names the field path and the rule broken; an unknown key's name is caller text, so it is left out
function describeIssues(
  field: string,
  issues: readonly z.core.$ZodIssue[],
): string {
  return formatUntrustedIssues(
    issues.map((issue) => ({
      ...issue,
      path: [field, ...issue.path],
      message: issue.code === "unrecognized_keys"
        ? "unknown field"
        : issue.message,
    })),
    MAX_ISSUES_SHOWN,
  );
}

const CapabilitiesSchema = z.array(z.string()).max(MAX_CAPABILITIES);

type ParsedBody =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response };

async function readFederationBody(req: Request): Promise<ParsedBody> {
  const bytes = await readBodyWithLimit(req, MAX_FEDERATION_BODY_BYTES);
  if (bytes === null) {
    return { ok: false, response: tooLarge() };
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {
      ok: false,
      response: badRequest("The request body is not valid JSON"),
    };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      response: badRequest("The request body must be a JSON object"),
    };
  }
  const record = body as Record<string, unknown>;
  if (record.protocolVersion !== FEDERATION_PROTOCOL_VERSION) {
    return {
      ok: false,
      response: badRequest(
        `protocolVersion is not supported; this hub supports protocolVersion ${FEDERATION_PROTOCOL_VERSION}`,
      ),
    };
  }
  // unknown capability strings are ignored, so a later slice adds verbs without a protocol bump
  if (record.capabilities !== undefined) {
    const capabilities = parseUntrusted(
      CapabilitiesSchema,
      record.capabilities,
    );
    if (!capabilities.success) {
      return {
        ok: false,
        response: badRequest(
          describeIssues("capabilities", capabilities.error.issues),
        ),
      };
    }
  }
  return { ok: true, body: record };
}

function fingerprintOf(
  body: Record<string, unknown>,
): { ok: true; fingerprint: Fingerprint } | { ok: false; response: Response } {
  const parsed = parseUntrusted(FingerprintSchema, body.fingerprint);
  if (!parsed.success) {
    return {
      ok: false,
      response: badRequest(describeIssues("fingerprint", parsed.error.issues)),
    };
  }
  return { ok: true, fingerprint: Fingerprint.fromJSON(parsed.data) };
}

export interface FederationRouteDeps {
  readonly hub: FederationHub;
  readonly clientAddress: string;
  readonly audit?: FederationAudit;
}

/** null for any other path; the hub answers only POST */
export async function handleFederationRequest(
  req: Request,
  deps: FederationRouteDeps,
): Promise<Response | null> {
  const pathname = new URL(req.url).pathname;
  if (!isFederationHubPath(pathname)) return null;
  if (req.method !== "POST") {
    return json(405, {
      error: "method_not_allowed",
      message: "Only POST is accepted",
    }, { allow: "POST" });
  }
  return pathname === FEDERATION_JOIN_PATH
    ? await handleJoin(req, deps)
    : await handleCheckIn(req, deps);
}

async function handleJoin(
  req: Request,
  deps: FederationRouteDeps,
): Promise<Response> {
  const address = deps.clientAddress;
  // join only: many instances behind one NAT check in from one address
  const burst = checkIpBurst(address);
  if (!burst.allowed) {
    deps.audit?.joinRefused(address, "rate_limited");
    return rateLimited(burst.retryAfterSeconds);
  }
  const read = await readFederationBody(req);
  if (!read.ok) return read.response;
  const fingerprint = fingerprintOf(read.body);
  if (!fingerprint.ok) return fingerprint.response;
  if (typeof read.body.joinToken !== "string") {
    return badRequest("joinToken: expected a string");
  }
  const joinId = joinIdOf(read.body.joinId);
  if (joinId === undefined) {
    return badRequest("joinId: expected a lower-case UUID");
  }
  const presented = read.body.joinToken;
  const claimedName = joinTokenNameOf(presented)?.value;
  let guarded;
  try {
    guarded = await limitFailedAttempts(
      failedAttemptKey(null, address, "federation-join"),
      async () => {
        const outcome = await deps.hub.join(
          presented,
          joinId,
          fingerprint.fingerprint,
        );
        return { ok: outcome.kind !== "invalid-token", outcome };
      },
    );
  } catch (error) {
    return failed(error);
  }
  if (guarded.limited) {
    deps.audit?.joinRefused(address, "rate_limited", claimedName);
    return rateLimited(guarded.retryAfterSeconds);
  }
  const outcome = guarded.result.outcome;
  switch (outcome.kind) {
    case "invalid-token":
      deps.audit?.joinRefused(address, "invalid_token", claimedName);
      return json(401, INVALID_JOIN_TOKEN);
    case "name-taken":
      deps.audit?.joinRefused(address, "name_taken", outcome.memberName);
      return json(409, {
        error: "name_taken",
        message:
          `A live member is already named '${outcome.memberName}'; remove it before another joins under this name`,
      });
    case "joined":
      if (outcome.replayed) {
        deps.audit?.joinReplayed(address, outcome.memberName);
      } else {
        deps.audit?.joined(address, outcome.memberName);
      }
      return json(200, {
        memberId: outcome.memberId,
        memberName: outcome.memberName,
        credential: outcome.credential,
        hub: hubIdentity(deps.hub),
        checkInIntervalSeconds: CHECK_IN_INTERVAL_SECONDS,
      });
  }
}

function bearerOf(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

async function handleCheckIn(
  req: Request,
  deps: FederationRouteDeps,
): Promise<Response> {
  const address = deps.clientAddress;
  const read = await readFederationBody(req);
  if (!read.ok) return read.response;
  const fingerprint = fingerprintOf(read.body);
  if (!fingerprint.ok) return fingerprint.response;
  if (!InstanceId.isValid(read.body.instanceId)) {
    return badRequest("instanceId: expected a UUID");
  }
  const instanceId = InstanceId.create(read.body.instanceId);

  let credential: MemberCredential;
  try {
    credential = MemberCredential.parse(bearerOf(req));
  } catch (error) {
    if (!(error instanceof MemberCredentialError)) return failed(error);
    // an unparseable credential names no member, so only the address is counted
    const guarded = await limitFailedAttempts(
      failedAttemptKey(null, address, "federation-check-in"),
      () => Promise.resolve({ ok: false }),
    );
    if (guarded.limited) {
      deps.audit?.checkInRefused(address, "rate_limited");
      return rateLimited(guarded.retryAfterSeconds);
    }
    deps.audit?.checkInRefused(address, "unauthorized");
    return json(401, INVALID_CREDENTIAL);
  }

  let guarded;
  try {
    guarded = await limitFailedAttempts(
      failedAttemptKey(
        null,
        address,
        `federation-check-in:${credential.memberId}`,
      ),
      async () => {
        const outcome = await deps.hub.checkIn(
          credential,
          instanceId,
          fingerprint.fingerprint,
        );
        return { ok: outcome.kind !== "unauthorized", outcome };
      },
    );
  } catch (error) {
    return failed(error);
  }
  if (guarded.limited) {
    deps.audit?.checkInRefused(address, "rate_limited");
    return rateLimited(guarded.retryAfterSeconds);
  }
  const outcome = guarded.result.outcome;
  switch (outcome.kind) {
    case "unauthorized":
      deps.audit?.checkInRefused(address, "unauthorized");
      return json(401, INVALID_CREDENTIAL);
    case "instance-limit":
      deps.audit?.checkInRefused(address, "instance_limit");
      return json(409, {
        error: "instance_limit",
        message:
          "This member already has the most live instances a hub records; an instance is dropped once it stops checking in",
      });
    case "checked-in":
      return json(200, {
        hub: hubIdentity(deps.hub),
        checkInIntervalSeconds: CHECK_IN_INTERVAL_SECONDS,
        jobs: [],
      });
  }
}

export interface FederationLeaderForward {
  isFollowing(): boolean;
  forward(req: Request, options: ForwardOptions): Promise<Response>;
}

export interface FederationServeDeps {
  /** undefined unless the gate is on and this serve is a hub */
  readonly hub: FederationHub | undefined;
  readonly clientAddress: () => string;
  readonly audit?: FederationAudit;
  /** a team follower's route to its leader, which applies every federation write */
  readonly leader?: FederationLeaderForward;
}

/**
 * serve's entry: null without a hub or off the federation paths, so serve's
 * other routes answer
 */
export async function routeFederationRequest(
  req: Request,
  deps: FederationServeDeps,
): Promise<Response | null> {
  const hub = deps.hub;
  if (hub === undefined) return null;
  if (!isFederationHubPath(new URL(req.url).pathname)) return null;
  if (deps.leader !== undefined && deps.leader.isFollowing()) {
    const body = await readBodyWithLimit(req, MAX_FEDERATION_BODY_BYTES);
    if (body === null) {
      return tooLarge();
    }
    // the caller is not authenticated here, so a refusal names no leader
    return await deps.leader.forward(req, {
      body,
      clientIp: deps.clientAddress(),
      nameLeader: false,
    });
  }
  return await handleFederationRequest(req, {
    hub,
    clientAddress: deps.clientAddress(),
    ...(deps.audit !== undefined ? { audit: deps.audit } : {}),
  });
}
