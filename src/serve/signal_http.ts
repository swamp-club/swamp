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
 * The HTTP signal route: `POST /api/v1/signal/<waitId>` with a JSON body
 * `{ "payload": { ... } }`. It is how a system that holds a token and a
 * wait ID, and no WebSocket client, answers a wait. Delivery itself is
 * {@link deliverSignalForCaller}, shared with the `workflow.signal` request.
 */

import { parsePrincipal, type Principal } from "../domain/access/principal.ts";
import type { AuditOutcome } from "../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../domain/serve_audit/audit_event_builder.ts";
import { SIGNAL_PAYLOAD_MAX_BYTES } from "../domain/workflows/signal_wait.ts";
import {
  type AccessCaller,
  type ConnectionContext,
  resolveDisplayPrincipal,
} from "./handlers/shared.ts";
import {
  checkIpBurst,
  checkRateLimit,
  clearRateLimit,
  rateLimitKey,
} from "./rate_limiter.ts";
import {
  deliverSignalForCaller,
  type SignalDeliveryResult,
} from "./signal_delivery.ts";
import type { ServerTokenAuthResult } from "./token_auth.ts";
import { readBodyWithLimit } from "./webhook.ts";

/** The body may wrap the payload in a little JSON; nothing larger is read. */
export const MAX_SIGNAL_BODY_BYTES = SIGNAL_PAYLOAD_MAX_BYTES + 1024;

const SIGNAL_ROUTE =
  /^\/api\/v1\/signal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The wait ID a request path names, lower-cased, or undefined when the path
 * is not the signal route. Only a UUID matches, so no other client text
 * reaches a store key or the audit log through the path.
 */
export function matchSignalRoute(pathname: string): string | undefined {
  return SIGNAL_ROUTE.exec(pathname)?.[1].toLowerCase();
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
  expired: 410,
  closed: 410,
  unsupported: 501,
  unreadable: 500,
  failed: 500,
};

function tooManyRequests(retryAfterSeconds: number | undefined): Response {
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
 * nothing else. The body is read only for an authenticated caller.
 */
export async function handleSignalHttpRequest(
  req: Request,
  waitId: string,
  sourceIp: string,
  deps: SignalHttpDeps,
): Promise<Response> {
  const { ctx } = deps;
  let caller: AccessCaller = {
    principal: null,
    collectives: [],
    groups: [],
    sourceIp,
  };

  if (ctx.authConfig.mode !== "none") {
    const ipBurst = checkIpBurst(sourceIp);
    if (!ipBurst.allowed) return tooManyRequests(ipBurst.retryAfterSeconds);
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
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
    caller = {
      principal: parsePrincipal(auth.principalId),
      collectives: auth.collectives,
      groups: auth.groups,
      sourceIp,
    };
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

  const requestId = crypto.randomUUID();
  const result = await deliverSignalForCaller(ctx, caller, {
    requestId,
    waitId,
    payload: (body as { payload: unknown }).payload,
  });
  emitResponseAudit(ctx, caller.principal, sourceIp, requestId, waitId, result);

  const { status, ...rest } = result;
  return Response.json({ status, ...rest }, { status: STATUS[status] });
}

/**
 * Audits the response, as the WebSocket dispatch audits every request. The
 * resource is the workflow once the caller was told it, otherwise the wait
 * ID. A denial is audited separately, with the workflow, where it is decided.
 */
function emitResponseAudit(
  ctx: ConnectionContext,
  principal: Principal | null,
  sourceIp: string,
  requestId: string,
  waitId: string,
  result: SignalDeliveryResult,
): void {
  if (!ctx.auditEmitter) return;
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
        waitId,
    principalKind: principal?.kind ?? "anonymous",
    principalId: principal?.id ?? "anonymous",
    initiatedBy: principal ? resolveDisplayPrincipal(principal, ctx) : "ghost",
    sourceIp,
    requestId,
    detail: result.status === "delivered" ? undefined : result.status,
  }));
}
