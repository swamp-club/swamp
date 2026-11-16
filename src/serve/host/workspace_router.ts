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

import { getLogger } from "@logtape/logtape";
import { createHttpForwarder } from "./forward_http.ts";
import { hostReply } from "./host_reply.ts";
import {
  type ForwardingOptions,
  forwardRequestHeaders,
  forwardWebSocketHeaders,
  type ListenerProtocol,
  offeredSubprotocols,
} from "./forwarding_headers.ts";
import { matchWorkspacePath } from "./workspace_path.ts";

const logger = getLogger(["swamp", "serve", "host"]);

const DEFAULT_WEBSOCKET_OPEN_TIMEOUT_MS = 10_000;

// the WebSocket API cannot pause a read, so a side that stops reading has its
// relay closed rather than buffered in the host without bound
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export type WorkspaceRoute =
  | { readonly kind: "running"; readonly port: number }
  | { readonly kind: "unavailable"; readonly state: string };

/** the router's view of the host's serves; undefined means no such workspace */
export interface WorkspaceDirectory {
  workspace(name: string): WorkspaceRoute | undefined;
  root(): WorkspaceRoute | undefined;
}

export interface WorkspaceRouterOptions {
  readonly directory: WorkspaceDirectory;
  readonly protocol: ListenerProtocol;
  readonly trustProxy: boolean;
  /** aborting it ends every forwarded stream and relayed socket */
  readonly signal: AbortSignal;
  readonly webSocketOpenTimeoutMs?: number;
}

export interface WorkspaceRouter {
  handle(
    req: Request,
    info: Deno.ServeHandlerInfo<Deno.NetAddr>,
  ): Promise<Response>;
}

export function createWorkspaceRouter(
  options: WorkspaceRouterOptions,
): WorkspaceRouter {
  const { directory, signal } = options;
  const http = createHttpForwarder(signal);
  const openTimeoutMs = options.webSocketOpenTimeoutMs ??
    DEFAULT_WEBSOCKET_OPEN_TIMEOUT_MS;
  const relays = new Set<() => void>();
  signal.addEventListener("abort", () => {
    for (const end of [...relays]) end();
  }, { once: true });

  const relayWebSocket = async (
    req: Request,
    port: number,
    pathAndQuery: string,
    forwarding: ForwardingOptions,
  ): Promise<Response> => {
    let upstream: WebSocket;
    try {
      upstream = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`, {
        protocols: offeredSubprotocols(req),
        headers: forwardWebSocketHeaders(req, forwarding),
      });
    } catch (error) {
      logger.info`Refused to forward a WebSocket: ${error}`;
      return hostReply(400, { error: "The request could not be forwarded." });
    }
    upstream.binaryType = "arraybuffer";
    const toCaller: Array<string | ArrayBuffer> = [];
    let queuedBytes = 0;
    let closeFromChild: { code: number; reason: string } | undefined;
    const queueForCaller = (data: string | ArrayBuffer) => {
      queuedBytes += typeof data === "string" ? data.length : data.byteLength;
      if (queuedBytes > MAX_BUFFERED_BYTES) {
        closeQuietly(upstream, 1000, "The other side is not reading.");
        return;
      }
      toCaller.push(data);
    };
    upstream.onmessage = (e) => queueForCaller(e.data);

    // the WebSocket API hides a refused handshake's status, so a child's 401
    // or 421 reaches the caller as this 502
    const outcome = await new Promise<"open" | "refused" | "timeout">(
      (resolve) => {
        const settle = (result: "open" | "refused" | "timeout") => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          req.signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = () => settle("refused");
        const timer = setTimeout(() => settle("timeout"), openTimeoutMs);
        signal.addEventListener("abort", onAbort, { once: true });
        // a caller that hangs up during the handshake leaves no upstream open
        req.signal.addEventListener("abort", onAbort, { once: true });
        upstream.addEventListener("open", () => settle("open"), {
          once: true,
        });
        upstream.addEventListener("error", () => settle("refused"), {
          once: true,
        });
        upstream.addEventListener("close", () => settle("refused"), {
          once: true,
        });
      },
    );
    if (outcome !== "open") {
      closeQuietly(upstream, 1000, "");
      logger
        .info`A WebSocket to the child on port ${port} did not open: ${outcome}`;
      return outcome === "timeout"
        ? hostReply(504, { error: "The workspace did not answer in time." })
        : hostReply(502, { error: "The workspace could not be reached." });
    }

    let upgraded: { socket: WebSocket; response: Response };
    try {
      upgraded = Deno.upgradeWebSocket(
        req,
        upstream.protocol ? { protocol: upstream.protocol } : {},
      );
    } catch (error) {
      closeQuietly(upstream, 1000, "");
      logger.info`A WebSocket upgrade failed: ${error}`;
      return hostReply(400, { error: "The request could not be forwarded." });
    }
    const socket = upgraded.socket;
    socket.binaryType = "arraybuffer";
    upstream.onmessage = (e) => {
      if (socket.readyState === WebSocket.OPEN) relay(socket, e.data);
      else queueForCaller(e.data);
    };
    const closeBoth = (reason: string) => {
      closeQuietly(socket, 1000, reason);
      closeQuietly(upstream, 1000, reason);
    };
    const end = () => closeBoth("The host is shutting down.");
    const relay = (target: WebSocket, data: string | ArrayBuffer) => {
      if (target.bufferedAmount > MAX_BUFFERED_BYTES) {
        closeBoth("The other side is not reading.");
        return;
      }
      target.send(data);
    };
    relays.add(end);
    socket.onopen = () => {
      for (const message of toCaller.splice(0)) relay(socket, message);
      if (closeFromChild !== undefined) {
        closeQuietly(socket, closeFromChild.code, closeFromChild.reason);
      }
    };
    socket.onmessage = (e) => {
      if (upstream.readyState === WebSocket.OPEN) relay(upstream, e.data);
    };
    socket.onclose = (e) => {
      relays.delete(end);
      closeQuietly(upstream, e.code, e.reason);
    };
    upstream.onclose = (e) => {
      if (socket.readyState === WebSocket.CONNECTING) {
        closeFromChild = { code: e.code, reason: e.reason };
        return;
      }
      closeQuietly(socket, e.code, e.reason);
    };
    upstream.onerror = () =>
      closeQuietly(socket, 1000, "The workspace closed the connection.");
    return upgraded.response;
  };

  return {
    handle(req, info) {
      // a relay begun now would miss the shutdown that already ended the rest
      if (signal.aborted) {
        return Promise.resolve(
          hostReply(503, { error: "The host is shutting down." }),
        );
      }
      const url = new URL(req.url);
      const match = matchWorkspacePath(url.pathname);
      if (match.kind === "unknown") return Promise.resolve(noWorkspace());
      const route = match.kind === "workspace"
        ? directory.workspace(match.name)
        : directory.root();
      if (route === undefined) return Promise.resolve(noWorkspace());
      if (route.kind === "unavailable") {
        return Promise.resolve(hostReply(503, {
          error: "The workspace is not running.",
          ...(match.kind === "workspace" ? { workspace: match.name } : {}),
          state: route.state,
        }));
      }
      const pathAndQuery = match.path + url.search;
      const forwarding: ForwardingOptions = {
        peer: info.remoteAddr.hostname,
        protocol: options.protocol,
        trustProxy: options.trustProxy,
      };
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return relayWebSocket(req, route.port, pathAndQuery, forwarding);
      }
      return http.forward(
        req,
        route.port,
        pathAndQuery,
        forwardRequestHeaders(req, forwarding),
      );
    },
  };
}

function noWorkspace(): Response {
  return hostReply(404, { error: "No workspace answers at this address." });
}

// a script may close only with 1000 or 3000-4999; anything else the other side
// sent (1001 going away, 1006 dropped) passes on as 1000
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState > WebSocket.OPEN) return;
  try {
    ws.close(code >= 3000 && code <= 4999 ? code : 1000, reason);
  } catch {
    // already closing
  }
}
