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

export interface EventLoopLagReader {
  maxLagMs(): number | undefined;
}

export interface WebSocketRequestTrace {
  type: string;
  socket: WebSocket;
  activeRequests: number;
  principal: Principal | null;
  datastoreType: string;
  datastoreEngine: string;
  eventLoopLag?: EventLoopLagReader;
}

const connectionIds = new WeakMap<WebSocket, string>();

export function connectionIdOf(socket: WebSocket): string {
  let id = connectionIds.get(socket);
  if (!id) {
    id = crypto.randomUUID();
    connectionIds.set(socket, id);
  }
  return id;
}

/**
 * fn must start the handler, not receive a started promise: the handler joins
 * the span only when it begins inside its context. Messages carry no trace
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
