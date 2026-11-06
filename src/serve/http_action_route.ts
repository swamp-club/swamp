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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { handleMessage, MAX_ACTIVE_REQUESTS } from "./connection.ts";
import { followerHttpForward } from "./follower_requests.ts";
import type { ConnectionContext } from "./handlers/shared.ts";
import {
  type ActionReply,
  actionReplyForEnd,
  actionReplyForFrame,
  actionResponse,
  DETACHED_ACTION_TYPES,
  READ_ACTION_TYPES,
} from "./http_action_reply.ts";
import { parseActionRequest } from "./http_action_request.ts";
import {
  authenticateHttpCaller,
  httpFailure,
  tooManyRequests,
} from "./http_caller_auth.ts";
import {
  createCallerReplySocket,
  holdingSlotUntilRead,
} from "./http_request_route.ts";
import { MAX_HTTP_ACTION_BODY_BYTES } from "./protocol.ts";
import { rateLimitKeyWithAddress } from "./rate_limiter.ts";
import { hasJsonContentType } from "./signal_http.ts";
import type { ServerTokenAuthResult } from "./token_auth.ts";
import { readBodyWithLimit } from "./webhook.ts";

const logger = getSwampLogger(["serve", "http-action"]);

/** past this the caller is told to retry; the work carries on regardless */
export const ACTION_DEADLINE_MS = 30_000;

/** a forwarded start waits this long for this node's copy to hold the run */
const FORWARDED_START_BARRIER_MS = 2_000;

export interface HttpActionRouteDeps {
  readonly ctx: ConnectionContext;
  readonly authenticate: (
    token: string,
    sourceIp: string,
  ) => Promise<ServerTokenAuthResult>;
  readonly now?: () => number;
  readonly dispatch?: typeof handleMessage;
  readonly deadlineMs?: number;
}

const inFlightByCaller = new Map<string, number>();

function releaseCaller(slot: string): void {
  const left = (inFlightByCaller.get(slot) ?? 1) - 1;
  if (left <= 0) inFlightByCaller.delete(slot);
  else inFlightByCaller.set(slot, left);
}

function responseFor(reply: ActionReply, onRead: () => void): Response {
  const { status, text, headers } = actionResponse(reply);
  const bytes = new TextEncoder().encode(text);
  return new Response(
    holdingSlotUntilRead(
      new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      onRead,
    ),
    { status, headers },
  );
}

function stillWorking(requestId?: string): Response {
  return Response.json(
    {
      code: "still_working",
      message: "This action is still in progress; retry it to read its result",
      ...(requestId !== undefined ? { requestId } : {}),
    },
    { status: 503, headers: { "retry-after": "1" } },
  );
}

async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
): Promise<T | "deadline"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** a leader too old to have this route answers plain text, not our JSON */
function leaderLacksRoute(response: Response): boolean {
  return response.status === 404 &&
    !(response.headers.get("content-type") ?? "").includes("application/json");
}

async function forwardedReply(
  forwarding: Promise<Response>,
  type: string,
  ctx: ConnectionContext,
  deadlineMs: number,
): Promise<Response> {
  const settled = await withDeadline(forwarding, deadlineMs);
  if (settled === "deadline") {
    // the leader may still answer; its body is dropped so the connection frees
    forwarding.then((late) => late.body?.cancel()).catch(() => {});
    return stillWorking();
  }
  if (leaderLacksRoute(settled)) {
    await settled.body?.cancel();
    return Response.json(
      {
        code: "leader_upgrade_required",
        message: "The leader of this serve team has no action route yet",
      },
      { status: 503, headers: { "retry-after": "5" } },
    );
  }
  if (settled.ok && !READ_ACTION_TYPES.has(type) && ctx.feedBarrier) {
    // a failed or slow barrier costs a stale local read, not the action's reply
    const barrier = ctx.feedBarrier().catch(() => {});
    if (DETACHED_ACTION_TYPES.has(type)) {
      await withDeadline(barrier, FORWARDED_START_BARRIER_MS);
    } else {
      await barrier;
    }
  }
  return settled;
}

/** Bearer only: this path takes no session store, so a cookie cannot authenticate it. */
export async function handleHttpActionRequest(
  req: Request,
  sourceIp: string,
  deps: HttpActionRouteDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json(
      { code: "method_not_allowed", message: "Method not allowed" },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  const { ctx } = deps;
  const caller = await authenticateHttpCaller(req, sourceIp, {
    authMode: ctx.authConfig.mode,
    authenticate: deps.authenticate,
    now: deps.now,
    limitPrincipalRate: true,
    failedAttemptKey: rateLimitKeyWithAddress,
  });
  if (caller instanceof Response) return caller;

  if (!hasJsonContentType(req)) {
    return httpFailure(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
    );
  }
  const bytes = await readBodyWithLimit(req, MAX_HTTP_ACTION_BODY_BYTES);
  if (bytes === null) {
    return httpFailure(
      413,
      "payload_too_large",
      `Request body exceeds ${MAX_HTTP_ACTION_BODY_BYTES} bytes`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return httpFailure(400, "invalid_request", "Invalid JSON");
  }
  let parsed: ReturnType<typeof parseActionRequest>;
  try {
    parsed = parseActionRequest(raw, {
      anonymous: caller.token === undefined,
    });
  } catch {
    // a size-limited body can still nest deeper than the stack can walk
    return httpFailure(400, "invalid_request", "Request is nested too deeply");
  }
  if (!parsed.ok) {
    return parsed.reason === "type_not_allowed"
      ? httpFailure(
        404,
        "type_not_allowed",
        "This type is not available on this route",
      )
      : httpFailure(400, "invalid_request", parsed.message);
  }

  const slot = caller.token === undefined
    ? `anonymous:${sourceIp}`
    : caller.principal;
  const inFlight = inFlightByCaller.get(slot) ?? 0;
  if (inFlight >= MAX_ACTIVE_REQUESTS) return tooManyRequests(1);
  inFlightByCaller.set(slot, inFlight + 1);

  const deadlineMs = deps.deadlineMs ?? ACTION_DEADLINE_MS;
  const forwarding = followerHttpForward(parsed.type, req, ctx, {
    clientIp: sourceIp,
    body: bytes,
  });
  if (forwarding !== undefined) {
    try {
      return await forwardedReply(forwarding, parsed.type, ctx, deadlineMs);
    } finally {
      releaseCaller(slot);
    }
  }

  if (DETACHED_ACTION_TYPES.has(parsed.type) && !ctx.activeRunRegistry) {
    releaseCaller(slot);
    return httpFailure(
      503,
      "runs_unavailable",
      "This server can't keep a run going after the request ends",
    );
  }

  const { reply, socket, activeRequests } = createCallerReplySocket(
    caller,
    sourceIp,
  );
  let settle!: (reply: ActionReply) => void;
  const answer = new Promise<ActionReply>((resolve) => {
    settle = resolve;
  });
  reply.onFrame = (text) => {
    const settled = actionReplyForFrame(
      parsed.type,
      JSON.parse(text),
      parsed.requestId,
    );
    if (!settled) return;
    settle(settled);
    // a detached run carries on: closing only stops listening, as --detach does
    if (DETACHED_ACTION_TYPES.has(parsed.type)) {
      queueMicrotask(() => reply.close());
    }
  };
  if (READ_ACTION_TYPES.has(parsed.type)) {
    req.signal.addEventListener(
      "abort",
      () => reply.close(1001, "client disconnected"),
      { once: true },
    );
  }

  // the slot frees once the handler has ended and the reply has been read
  let holds = 2;
  const release = () => {
    if (--holds === 0) releaseCaller(slot);
  };
  // async, so a throw before dispatch's first await still frees the slot
  const handling = (async () =>
    await (deps.dispatch ?? handleMessage)(
      socket,
      ctx,
      activeRequests,
      new MessageEvent("message", { data: parsed.frame }),
      caller.access.principal,
    ))().catch((error: unknown) => {
      logger.error("An action failed unexpectedly: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      settle(actionReplyForEnd(parsed.requestId));
      reply.close();
      release();
    });

  const settled = await withDeadline(answer, deadlineMs);
  if (settled === "deadline") {
    // a read has no effect worth finishing, and each retry would add another
    if (READ_ACTION_TYPES.has(parsed.type)) reply.close(1001, "deadline");
    release();
    return stillWorking(parsed.requestId);
  }
  const localMiss = settled.status === 404 &&
    parsed.type === "workflow.history.get" &&
    ctx.followerGate?.role === "follower" && ctx.leaderLink !== undefined;
  if (localMiss) {
    // a start through another node may not have reached this copy yet
    await handling;
    const forwarded = ctx.leaderLink!.forward(req, {
      clientIp: sourceIp,
      body: bytes,
    });
    try {
      return await forwardedReply(forwarded, parsed.type, ctx, deadlineMs);
    } finally {
      release();
    }
  }
  return responseFor(settled, release);
}
