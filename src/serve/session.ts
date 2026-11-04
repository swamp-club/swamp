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

import type { ServerMessage } from "./protocol.ts";

/**
 * Reply port for delivery adapters that do not own a WebSocket. `send` admits
 * a message to a bounded, ordered writer or throws when it cannot. The adapter
 * accounts for every admitted write and `flush` waits for their delivery.
 * `close` closes the entire delivery session and detaches all of its request
 * subscriptions; it does not cancel accepted runs or close other sessions.
 */
export interface SessionReply {
  readonly kind: "session-reply";
  readonly open: boolean;
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
  flush(): Promise<void>;
}

/** One identity for authority, token binding, tracing and ordered replies. */
export type ServeSession = WebSocket | SessionReply;

export function isSessionReply(session: ServeSession): session is SessionReply {
  return "kind" in session && session.kind === "session-reply";
}

export function isSessionOpen(session: ServeSession): boolean {
  return isSessionReply(session)
    ? session.open
    : session.readyState === WebSocket.OPEN;
}

/** Waits for an adapter's admitted writes before releasing its lifecycle. */
export async function flushSession(session: ServeSession): Promise<void> {
  if (isSessionReply(session)) await session.flush();
}
