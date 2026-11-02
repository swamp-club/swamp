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
  handleMessage,
  MAX_ACTIVE_REQUESTS,
  validateServerRequest,
} from "./connection.ts";
import { followerHttpRefusal } from "./follower_requests.ts";
import {
  type ConnectionContext,
  markUncappedSocket,
  removeConnection,
  setConnectionCollectives,
  setConnectionLoginIdentity,
  setConnectionSourceIp,
  setConnectionToken,
} from "./handlers/shared.ts";
import {
  authenticateHttpCaller,
  type HttpCaller,
  httpFailure,
  tooManyRequests,
} from "./http_caller_auth.ts";
import { HTTP_REQUEST_TYPES, MAX_HTTP_REQUEST_BODY_BYTES } from "./protocol.ts";
import type { ServerTokenAuthResult } from "./token_auth.ts";
import { readBodyWithLimit } from "./webhook.ts";

export interface HttpRequestRouteDeps {
  readonly ctx: ConnectionContext;
  readonly authenticate: (
    token: string,
    sourceIp: string,
  ) => Promise<ServerTokenAuthResult>;
  readonly now?: () => number;
  /** handleMessage unless a test stands in for the request path */
  readonly dispatch?: typeof handleMessage;
}

/**
 * The reply channel a request on the HTTP route answers into: the handlers
 * reply through a WebSocket, so this is one, as far as serve's code uses one.
 * Frames arrive uncompressed and uncapped, so always as text.
 */
class HttpReplySocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  readonly bufferedAmount = 0;
  onclose: ((event: CloseEvent) => void) | null = null;
  onFrame: (frame: string) => void = () => {};

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== WebSocket.OPEN || typeof data !== "string") return;
    this.onFrame(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    const event = new CloseEvent("close", { code, reason });
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}

const inFlightByPrincipal = new Map<string, number>();

/**
 * Runs one client read through the WebSocket's own request path and streams
 * every frame it answers with as one NDJSON line, with no frame limit.
 */
export async function handleHttpRequest(
  req: Request,
  sourceIp: string,
  deps: HttpRequestRouteDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json(
      { code: "method_not_allowed", message: "Method not allowed" },
      { status: 405, headers: { allow: "POST" } },
    );
  }
  const caller = await authenticateHttpCaller(req, sourceIp, {
    authMode: deps.ctx.authConfig.mode,
    authenticate: deps.authenticate,
    now: deps.now,
  });
  if (caller instanceof Response) return caller;

  const bytes = await readBodyWithLimit(req, MAX_HTTP_REQUEST_BODY_BYTES);
  if (bytes === null) {
    return httpFailure(
      413,
      "payload_too_large",
      `Request body exceeds ${MAX_HTTP_REQUEST_BODY_BYTES} bytes`,
    );
  }
  const text = new TextDecoder().decode(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return httpFailure(400, "invalid_request", "Invalid JSON");
  }
  const validated = validateServerRequest(raw);
  if (typeof validated === "string") {
    return httpFailure(400, "invalid_request", validated);
  }
  if (!HTTP_REQUEST_TYPES.has(validated.type)) {
    return httpFailure(
      400,
      "invalid_request",
      `'${validated.type}' is not answered over HTTP; send it over the WebSocket`,
    );
  }
  const notLeader = followerHttpRefusal(validated.type, deps.ctx.followerGate);
  if (notLeader !== undefined) return notLeader;

  // stands in for the per-socket request cap a WebSocket gives its caller
  const inFlight = inFlightByPrincipal.get(caller.principal) ?? 0;
  if (inFlight >= MAX_ACTIVE_REQUESTS) return tooManyRequests(1);
  inFlightByPrincipal.set(caller.principal, inFlight + 1);

  const body = replyStream(
    caller,
    sourceIp,
    text,
    deps.ctx,
    deps.dispatch ?? handleMessage,
  );
  const gzip = acceptsGzip(req);
  return new Response(
    gzip ? body.pipeThrough(new CompressionStream("gzip")) : body,
    {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        ...(gzip && { "content-encoding": "gzip" }),
      },
    },
  );
}

function replyStream(
  caller: HttpCaller,
  sourceIp: string,
  requestText: string,
  ctx: ConnectionContext,
  dispatch: typeof handleMessage,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const reply = new HttpReplySocket();
  const socket = reply as unknown as WebSocket;
  markUncappedSocket(socket);
  setConnectionSourceIp(socket, sourceIp);
  if (caller.token !== undefined) {
    setConnectionCollectives(
      socket,
      caller.access.collectives,
      caller.access.groups,
      caller.token.principalId,
    );
    setConnectionToken(socket, caller.token);
  }
  setConnectionLoginIdentity(socket, caller.access.loginIdentity);

  const activeRequests = new Map<string, AbortController>();
  // a disconnect or a revoked session aborts the request, as a closed socket's
  // teardown does
  reply.addEventListener("close", () => {
    for (const controller of activeRequests.values()) controller.abort();
    removeConnection(socket);
  });

  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async start(controller) {
      reply.onFrame = (frame) => {
        if (!cancelled) controller.enqueue(encoder.encode(frame + "\n"));
      };
      try {
        await dispatch(
          socket,
          ctx,
          activeRequests,
          new MessageEvent("message", { data: requestText }),
          caller.access.principal,
        );
      } finally {
        reply.close();
        releaseInFlight(caller.principal);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      reply.close(1001, "client disconnected");
    },
  });
}

function releaseInFlight(principal: string): void {
  const remaining = (inFlightByPrincipal.get(principal) ?? 1) - 1;
  if (remaining <= 0) inFlightByPrincipal.delete(principal);
  else inFlightByPrincipal.set(principal, remaining);
}

function acceptsGzip(req: Request): boolean {
  return (req.headers.get("accept-encoding") ?? "")
    .split(",")
    .some((encoding) => encoding.trim().split(";")[0] === "gzip");
}
