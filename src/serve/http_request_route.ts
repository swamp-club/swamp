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
  setConnectionClient,
  setConnectionCollectives,
  setConnectionLoginIdentity,
  setConnectionSourceIp,
  setConnectionToken,
} from "./handlers/shared.ts";
import {
  authenticateHttpCaller,
  type HttpCaller,
  type HttpCallerSessionAuth,
  httpFailure,
} from "./http_caller_auth.ts";
import {
  HTTP_REQUEST_TYPES,
  MAX_HTTP_REQUEST_BODY_BYTES,
  USE_WEBSOCKET_CODE,
} from "./protocol.ts";
import type { ServerTokenAuthResult } from "./token_auth.ts";
import { readBodyWithLimit } from "./webhook.ts";

export interface HttpRequestRouteDeps {
  readonly ctx: ConnectionContext;
  readonly authenticate: (
    token: string,
    sourceIp: string,
  ) => Promise<ServerTokenAuthResult>;
  readonly now?: () => number;
  /** the dashboard's origin-bound session cookie; absent, bearer only */
  readonly dashboardSession?: HttpCallerSessionAuth;
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

// a reply enqueued whole is taken in one pull and frees its slot before a byte is read
const REPLY_CHUNK_BYTES = 64 * 1024;

/**
 * Runs one client read through the WebSocket's own request path, so the two
 * transports share one validation, authorization and audit.
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
    dashboardSession: deps.dashboardSession,
    // a read the socket answered had no per-principal rate; the slot cap below
    // bounds the replies a caller holds in memory instead
    limitPrincipalRate: false,
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
      404,
      USE_WEBSOCKET_CODE,
      `'${validated.type}' is not answered over HTTP; send it over the WebSocket`,
    );
  }
  const notLeader = followerHttpRefusal(validated.type, deps.ctx.followerGate);
  if (notLeader !== undefined) return notLeader;

  // a slot is held until the reply is read to its end or abandoned, so a caller
  // holds at most MAX_ACTIVE_REQUESTS unread replies; over it, the socket answers
  const slot = caller.token === undefined
    ? `anonymous:${sourceIp}`
    : caller.principal;
  const inFlight = inFlightByPrincipal.get(slot) ?? 0;
  if (inFlight >= MAX_ACTIVE_REQUESTS) {
    return httpFailure(
      429,
      USE_WEBSOCKET_CODE,
      `Over ${MAX_ACTIVE_REQUESTS} requests in flight on HTTP; send it over the WebSocket`,
    );
  }
  inFlightByPrincipal.set(slot, inFlight + 1);

  const body = replyStream(
    caller,
    sourceIp,
    text,
    deps.ctx,
    deps.dispatch ?? handleMessage,
  );
  const gzip = acceptsGzip(req);
  return new Response(
    holdingSlotUntilRead(
      gzip ? body.pipeThrough(new CompressionStream("gzip")) : body,
      () => releaseInFlight(slot),
    ),
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
  setConnectionClient(socket, caller.access.client);

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
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      reply.close(1001, "client disconnected");
    },
  });
}

/**
 * the outermost stream, handing the response writer one small chunk per pull:
 * the writer stops pulling while its bounded buffers are full, so the end is
 * seen only once the client has taken all but those buffers
 */
function holdingSlotUntilRead(
  inner: ReadableStream<Uint8Array<ArrayBuffer>>,
  release: () => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const reader = inner.getReader();
  let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let released = false;
  const releaseOnce = () => {
    pending = new Uint8Array(0);
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (pending.byteLength === 0) {
        let chunk: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          releaseOnce();
          controller.error(error);
          return;
        }
        if (chunk.done) {
          releaseOnce();
          controller.close();
          return;
        }
        pending = chunk.value;
      }
      controller.enqueue(pending.subarray(0, REPLY_CHUNK_BYTES));
      pending = pending.subarray(REPLY_CHUNK_BYTES);
    },
    async cancel(reason) {
      releaseOnce();
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

function releaseInFlight(slot: string): void {
  const remaining = (inFlightByPrincipal.get(slot) ?? 1) - 1;
  if (remaining <= 0) inFlightByPrincipal.delete(slot);
  else inFlightByPrincipal.set(slot, remaining);
}

function acceptsGzip(req: Request): boolean {
  return (req.headers.get("accept-encoding") ?? "")
    .split(",")
    .some((encoding) => encoding.trim().split(";")[0] === "gzip");
}
