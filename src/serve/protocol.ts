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
 * Wire protocol types for the swamp WebSocket API.
 *
 * Clients send ServerRequest messages, the server streams back ServerMessage
 * events. Each request carries a client-assigned `id` that the server echoes
 * on every response, enabling multiplexed operations on a single socket.
 */

// ── Inbound (client → server) ────────────────────────────────────────────

export interface WorkflowRunPayload {
  workflowIdOrName: string;
  inputs?: Record<string, unknown>;
  lastEvaluated?: boolean;
  driver?: string;
  verbose?: boolean;
  runtimeTags?: Record<string, string>;
}

export interface ModelMethodRunPayload {
  modelIdOrName: string;
  methodName: string;
  inputs?: Record<string, unknown>;
  lastEvaluated?: boolean;
  driver?: string;
  runtimeTags?: Record<string, string>;
}

export type ServerRequest =
  | { type: "workflow.run"; id: string; payload: WorkflowRunPayload }
  | { type: "model.method.run"; id: string; payload: ModelMethodRunPayload }
  | { type: "cancel"; id: string };

// ── Outbound (server → client) ───────────────────────────────────────────

/** A JSON-safe event from a libswamp async generator. */
export interface SerializedEvent {
  kind: string;
  [key: string]: unknown;
}

/** Error details sent to the client. */
export interface SerializedError {
  code: string;
  message: string;
  details?: unknown;
}

export type ServerMessage =
  | { type: "event"; id: string; event: SerializedEvent }
  | { type: "error"; id: string; error: SerializedError };
