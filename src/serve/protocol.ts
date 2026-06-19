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
  verbose?: boolean;
  runtimeTags?: Record<string, string>;
}

export interface ModelMethodRunPayload {
  modelIdOrName: string;
  methodName: string;
  inputs?: Record<string, unknown>;
  lastEvaluated?: boolean;
  runtimeTags?: Record<string, string>;
  typeArg?: string;
  definitionName?: string;
}

export interface AccessGrantListPayload {
  subject?: string;
  resource?: string;
}

export interface AccessGroupListPayload {
  name?: string;
}

export interface AccessCheckPayload {
  subject: string;
  action: string;
  resource: string;
  collectives?: string[];
}

export interface AccessCanIPayload {
  action?: string;
  resource?: string;
  collectives?: string[];
}

export type ServerRequest =
  | { type: "workflow.run"; id: string; payload: WorkflowRunPayload }
  | { type: "model.method.run"; id: string; payload: ModelMethodRunPayload }
  | { type: "access.grant.list"; id: string; payload?: AccessGrantListPayload }
  | { type: "access.group.list"; id: string; payload?: AccessGroupListPayload }
  | { type: "access.check"; id: string; payload: AccessCheckPayload }
  | { type: "access.can-i"; id: string; payload: AccessCanIPayload }
  | { type: "access.reload"; id: string }
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

export interface AccessGrantListResponse {
  grants: Record<string, unknown>[];
}

export interface AccessGroupListResponse {
  groups: Record<string, unknown>[];
}

export interface AccessCheckResponse {
  subject: string;
  action: string;
  resource: string;
  collectives: string[];
  decisions: Record<string, unknown>[];
}

export interface AccessCanIDecision {
  action: string;
  resource: string;
  effect: string;
  grantId: string;
  via: string;
  condition?: string;
}

export interface AccessCanIResponse {
  principal: string;
  decisions: AccessCanIDecision[];
}

export interface AccessReloadResponse {
  success: boolean;
  grantCount: number;
  groupCount: number;
}

export type ServerMessage =
  | { type: "event"; id: string; event: SerializedEvent }
  | { type: "error"; id: string; error: SerializedError }
  /**
   * Terminal frame after a run's event stream completes successfully, so a
   * client can distinguish "run ended" from "stream stalled". An `error`
   * frame is the terminal frame for failed requests. Additive — clients
   * that predate it ignore unknown frame types.
   */
  | { type: "done"; id: string }
  | { type: "access.grant.list"; id: string; payload: AccessGrantListResponse }
  | {
    type: "access.group.list";
    id: string;
    payload: AccessGroupListResponse;
  }
  | { type: "access.check"; id: string; payload: AccessCheckResponse }
  | { type: "access.can-i"; id: string; payload: AccessCanIResponse }
  | { type: "access.reload"; id: string; payload: AccessReloadResponse };
