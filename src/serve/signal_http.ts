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

/**
 * The HTTP signal routes. `POST /api/v1/signal/<waitId>` with a JSON body
 * `{ "payload": { ... } }` is how a system that holds a token and a wait
 * ID, and no WebSocket client, answers a wait. `POST /api/v1/signal` with
 * `{ "workflow": "...", "key": "...", "payload": { ... } }` answers the wait
 * that holds a key (swamp-club#3211); the workflow travels in the body, as
 * its name may hold `@` and `/`. Delivery itself is
 * {@link deliverSignalForCaller}, shared with the `workflow.signal` request.
 */

import { parsePrincipal } from "../domain/access/principal.ts";
import { resolveActorIdentity } from "../domain/serve_audit/actor_identity.ts";
import type { AuditOutcome } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import {
  SIGNAL_KEY_MAX_LENGTH,
  SIGNAL_PAYLOAD_MAX_BYTES,
  SIGNAL_WORKFLOW_MAX_LENGTH,
} from "../domain/workflows/signal_wait.ts";
import { normalizeWaitId } from "../domain/workflows/signal_wait_records.ts";
import {
  type AccessCaller,
  type ConnectionContext,
  isCallerAuthorized,
  isRestrictedCommand,
  resolveDisplayPrincipal,
  type TokenSessionBinding,
} from "./handlers/shared.ts";
import {
  checkIpBurst,
  checkRateLimit,
  clearRateLimit,
  rateLimitKey,
} from "./rate_limiter.ts";
import {
  continueAfterSignal,
  deliverSignalForCaller,
  type SignalDeliveryAddress,
  type SignalDeliveryResult,
} from "./signal_delivery.ts";
import type { ServerTokenAuthResult } from "./token_auth.ts";
import { readBodyWithLimit } from "./webhook.ts";

/**
 * The most of a request body that is read. It only bounds the read: the
 * payload's own limit is checked on the parsed value, in
 * {@link deliverSignalForCaller}. A body can be several times its payload,
 * since a client may write each non-ASCII character as a six-byte escape and
 * may indent the JSON, so the cap leaves room for a payload at its limit
 * sent either way.
 */
export const MAX_SIGNAL_BODY_BYTES = SIGNAL_PAYLOAD_MAX_BYTES * 6 + 1024;

// Only narrows the path segment; normalizeWaitId decides what a wait ID is.
const SIGNAL_ROUTE = /^\/api\/v1\/signal\/([0-9A-Fa-f-]{36})$/;

/** The route of a signal addressed by workflow and key, both in the body. */
const SIGNAL_BY_KEY_ROUTE = "/api/v1/signal";

/** The request type these routes are the HTTP form of. */
const SIGNAL_REQUEST_TYPE = "workflow.signal";

/** Which signal route a path is: by the wait ID it names, or by key. */
export type SignalRoute =
  | { readonly waitId: string }
  | { readonly byKey: true };

/**
 * The signal route a request path is, or undefined when it is neither. By
 * ID it carries the wait ID, lower-cased; only a UUID matches, so no other
 * client text reaches a store key or the audit log through the path.
 */
export function matchSignalRoute(pathname: string): SignalRoute | undefined {
  if (pathname === SIGNAL_BY_KEY_ROUTE) return { byKey: true };
  const segment = SIGNAL_ROUTE.exec(pathname)?.[1];
  // Judged as the WebSocket request and the CLI judge a wait ID.
  const waitId = segment === undefined ? undefined : normalizeWaitId(segment);
  return waitId === undefined ? undefined : { waitId };
}

export interface SignalHttpDeps {
  ctx: ConnectionContext;
  /** Authenticates a bearer token. Not called when authorization is off. */
  authenticate: (
    token: string,
    sourceIp: string,
  ) => Promise<ServerTokenAuthResult>;
}

const STATUS: Record<SignalDeliveryResult["status"], number> = {
  delivered: 200,
  not_found: 404,
  invalid_payload: 422,
  already_settled: 409,
  // The key is declared and nothing waits on it now: the request is right
  // and the workflow's state refuses it. The body's `status` tells it from
  // a wait that is already settled.
  no_open_wait: 409,
  expired: 410,
  closed: 410,
  unsupported: 501,
  unreadable: 500,
  failed: 500,
};

const BEARER_PREFIX_LEN = "Bearer ".length;

/**
 * The token of a `Bearer` authorization header, or null. The scheme is
 * matched in any case, as HTTP defines it and as the WebSocket upgrade
 * reads it (`extractWebSocketToken`); the token is returned as sent.
 */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (
    header === null ||
    header.slice(0, BEARER_PREFIX_LEN).toLowerCase() !== "bearer "
  ) return null;
  const token = header.slice(BEARER_PREFIX_LEN);
  return token.length > 0 ? token : null;
}

function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": String(retryAfterSeconds) },
  });
}

function badRequest(message: string, status = 400): Response {
  return Response.json({ status: "error", message }, { status });
}

/**
 * Answers a request `matchSignalRoute` matched. Everything before the token
 * is checked costs the same for every caller: a rate-limit lookup and
 * nothing else. The body is read only for an authenticated caller, and only
 * once the server's audit and restricted-command gates let the request in.
 */
export async function handleSignalHttpRequest(
  req: Request,
  route: SignalRoute,
  sourceIp: string,
  deps: SignalHttpDeps,
): Promise<Response> {
  const { ctx } = deps;
  let tokenBinding: TokenSessionBinding | undefined;
  let caller: AccessCaller = {
    principal: null,
    collectives: [],
    groups: [],
    sourceIp,
  };

  if (ctx.authConfig.mode !== "none") {
    const ipBurst = checkIpBurst(sourceIp);
    if (!ipBurst.allowed) return tooManyRequests(ipBurst.retryAfterSeconds);
    const token = bearerToken(req);
    if (!token) {
      return new Response("Unauthorized: token required", { status: 401 });
    }
    const key = rateLimitKey(token, sourceIp);
    const rateCheck = checkRateLimit(key);
    if (!rateCheck.allowed) return tooManyRequests(rateCheck.retryAfterSeconds);
    const auth = await deps.authenticate(token, sourceIp);
    if (!auth.ok) {
      return new Response(`Unauthorized: ${auth.reason}`, { status: 401 });
    }
    clearRateLimit(key);
    tokenBinding = {
      name: auth.tokenName,
      createdAt: auth.tokenCreatedAt,
      principalId: auth.principalId,
    };
    caller = {
      principal: parsePrincipal(auth.principalId),
      collectives: auth.collectives,
      groups: auth.groups,
      sourceIp,
      loginIdentity: auth.oauthIdentity,
    };
  }

  // The two gates every WebSocket request passes before it is dispatched
  // (`handleMessage`), so this route cannot be a way around either.
  if (
    ctx.auditEmitter && ctx.auditFailOpen === false &&
    (ctx.auditWal?.isFull === true ||
      ctx.auditWal?.hasDroppedEvents === true ||
      ctx.auditEmitter.durableStalled)
  ) {
    return badRequest(
      "Request rejected: audit subsystem cannot durably record events (fail-secure mode)",
      503,
    );
  }
  const requestId = crypto.randomUUID();
  if (
    isRestrictedCommand(
      SIGNAL_REQUEST_TYPE,
      ctx.authConfig.restrictedCommands,
    ) &&
    !isCallerAuthorized(
      caller,
      requestId,
      "admin",
      { kind: "access", name: SIGNAL_REQUEST_TYPE, fields: {} },
      ctx,
    )
  ) {
    return badRequest(
      `Access denied: ${SIGNAL_REQUEST_TYPE} is restricted to admins on this server`,
      403,
    );
  }

  const bytes = await readBodyWithLimit(req, MAX_SIGNAL_BODY_BYTES);
  if (bytes === null) {
    return badRequest(
      `Request body exceeds ${MAX_SIGNAL_BODY_BYTES} bytes`,
      413,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return badRequest("Request body must be JSON");
  }
  if (
    typeof body !== "object" || body === null || Array.isArray(body) ||
    !("payload" in body)
  ) {
    return badRequest(
      'Request body must be a JSON object with a "payload" field',
    );
  }

  let address: SignalDeliveryAddress;
  if ("waitId" in route) {
    address = { waitId: route.waitId };
  } else {
    // Only the shape is judged here. Whether the two name anything is
    // decided after the caller is authorized, and answered 404.
    const { workflow, key } = body as { workflow?: unknown; key?: unknown };
    if (
      typeof workflow !== "string" || workflow.length === 0 ||
      workflow.length > SIGNAL_WORKFLOW_MAX_LENGTH ||
      typeof key !== "string" || key.length === 0 ||
      key.length > SIGNAL_KEY_MAX_LENGTH || "waitId" in body
    ) {
      return badRequest(
        `Request body must be {"workflow": ..., "key": ..., "payload": ...}: a workflow name or ID of at most ${SIGNAL_WORKFLOW_MAX_LENGTH} characters, a key of at most ${SIGNAL_KEY_MAX_LENGTH}, and no "waitId"`,
      );
    }
    address = { workflow, key };
  }

  // The wait ID, or the workflow a key address names: as sent until it
  // resolves, then under its canonical name, as its denial is audited.
  let named = "waitId" in address ? address.waitId : address.workflow;
  const result = await deliverSignalForCaller(ctx, caller, {
    requestId,
    ...address,
    payload: (body as { payload: unknown }).payload,
  }, {
    onWorkflowResolved: (name) => {
      named = name;
    },
  });
  emitResponseAudit(ctx, caller, requestId, named, result);
  await continueAfterSignal(ctx, result, {
    principal: caller.principal,
    ...(tokenBinding ? { token: tokenBinding } : {}),
  });

  // The run is for the server alone; the caller is told it only in `data`.
  const { status, run: _run, ...rest } = result as typeof result & {
    run?: unknown;
  };
  return Response.json({ status, ...rest }, { status: STATUS[status] });
}

/**
 * Audits the response, as the WebSocket dispatch audits every request. The
 * resource is the workflow once the caller was told it, otherwise `named`:
 * the wait ID, or the workflow a key address names (its canonical name once
 * it resolved, else the string as sent). A denial is audited separately,
 * with the workflow, where it is decided.
 */
function emitResponseAudit(
  ctx: ConnectionContext,
  caller: AccessCaller,
  requestId: string,
  named: string,
  result: SignalDeliveryResult,
): void {
  if (!ctx.auditEmitter) return;
  const { principal, sourceIp } = caller;
  const outcome: AuditOutcome = result.status === "delivered"
    ? "success"
    : "failure";
  ctx.auditEmitter.emit(buildAuditEvent({
    instanceId: ctx.instanceId ?? "unknown",
    category: "execution",
    stage: "response",
    outcome,
    action: "workflow.signal",
    resourceKind: "workflow",
    resourceName:
      (result.status === "delivered" ? result.data.workflowName : undefined) ??
        named,
    principalKind: principal?.kind ?? "anonymous",
    principalId: principal?.id ?? "anonymous",
    initiatedBy: principal ? resolveDisplayPrincipal(principal, ctx) : "ghost",
    actor: resolveActorIdentity(
      principal,
      ctx.resolvedUserNames,
      caller.loginIdentity,
    ),
    sourceIp,
    requestId,
    detail: result.status === "delivered" ? undefined : result.status,
  }));
}
