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
  type Principal,
  principalToString,
} from "../domain/access/principal.ts";
import { withServerSpan } from "../infrastructure/tracing/mod.ts";

/** Reads the largest event-loop lag serve observed recently. */
export interface EventLoopLagReader {
  maxLagMs(): number | undefined;
}

/** What a `swamp.serve.request` span records about one WebSocket request. */
export interface WebSocketRequestTrace {
  /** The validated request type, so the attribute stays low-cardinality. */
  type: string;
  socket: WebSocket;
  /** Requests in flight on this connection, counting this one. */
  activeRequests: number;
  principal: Principal | null;
  datastoreType: string;
  datastoreEngine: string;
  eventLoopLag?: EventLoopLagReader;
}

const connectionIds = new WeakMap<WebSocket, string>();

/**
 * A random id for `socket`, minted on first use. Every request on one
 * WebSocket carries the same id, so one dashboard tab's requests can be
 * grouped across their separate traces.
 */
export function connectionIdOf(socket: WebSocket): string {
  let id = connectionIds.get(socket);
  if (!id) {
    id = crypto.randomUUID();
    connectionIds.set(socket, id);
  }
  return id;
}

/**
 * Runs `fn` inside a root SERVER span named `swamp.serve.request` for one
 * WebSocket request, so the handler's lookups, authorization and libswamp
 * spans are its children (swamp-club#3741).
 *
 * `fn` must start the handler, not receive an already started promise: the
 * handler only joins the span when it begins inside the span's context.
 *
 * Like the HTTP request span, success leaves the status unset; `sendError`
 * records the error code a request answered with. Messages carry no trace
 * context, and none would be trusted.
 */
export function traceWebSocketRequest(
  trace: WebSocketRequestTrace,
  fn: () => Promise<void>,
): Promise<void> {
  const attributes: Record<string, string | number> = {
    "swamp.serve.request.type": trace.type,
    "swamp.serve.connection.id": connectionIdOf(trace.socket),
    "swamp.serve.active_requests": trace.activeRequests,
    "auth.principal.kind": trace.principal?.kind ?? "anonymous",
    "datastore.type": trace.datastoreType,
    "datastore.engine": trace.datastoreEngine,
  };
  if (trace.principal) {
    attributes["auth.principal.id"] = principalToString(trace.principal);
  }
  return withServerSpan("swamp.serve.request", attributes, async (span) => {
    try {
      await fn();
    } finally {
      const lag = trace.eventLoopLag?.maxLagMs();
      if (lag !== undefined) {
        span.setAttribute("swamp.serve.event_loop.lag_max_ms", lag);
      }
    }
  });
}
