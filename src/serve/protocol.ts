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

export interface DataGetPayload {
  modelIdOrName?: string;
  dataName?: string;
  workflowName?: string;
  runId?: string;
  version?: number;
  includeContent?: boolean;
}

export interface DataQueryPayload {
  predicate: string;
  limit?: number;
  select?: string;
}

export interface DataListPayload {
  modelIdOrName?: string;
  workflowName?: string;
  runId?: string;
  typeFilter?: string;
}

export interface ModelSearchPayload {
  query?: string;
}

export interface ModelMethodDescribePayload {
  modelIdOrName: string;
  methodName: string;
}

export interface WorkflowSearchPayload {
  query?: string;
}

export interface VaultGetPayload {
  vaultNameOrId: string;
  vaultType?: string;
}

export interface VaultPutPayload {
  vaultName: string;
  key: string;
  value: string;
  force?: boolean;
  refreshFrom?: string;
  refreshTtlMs?: number;
  clearRefresh?: boolean;
}

export interface AuditTimelinePayload {
  hours?: number;
  showAll?: boolean;
  sessionId?: string;
  includeDiagnostic?: boolean;
}

export interface SummarisePayload {
  since?: string;
  limit?: number;
}

export interface ReportGetPayload {
  reportName: string;
  model?: string;
  workflow?: string;
  version?: number;
  variant?: string;
}

export interface ReportSearchPayload {
  query?: string;
  model?: string;
  workflow?: string;
  scope?: string;
  type?: string;
  labels?: string[];
}

export interface ReportDescribePayload {
  reportName: string;
}

export interface ReportTypeSearchPayload {
  query?: string;
}

export type ServerRequest =
  | { type: "workflow.run"; id: string; payload: WorkflowRunPayload }
  | { type: "model.method.run"; id: string; payload: ModelMethodRunPayload }
  | { type: "access.grant.list"; id: string; payload?: AccessGrantListPayload }
  | { type: "access.group.list"; id: string; payload?: AccessGroupListPayload }
  | { type: "access.check"; id: string; payload: AccessCheckPayload }
  | { type: "access.can-i"; id: string; payload: AccessCanIPayload }
  | { type: "access.reload"; id: string }
  | { type: "data.get"; id: string; payload: DataGetPayload }
  | { type: "data.query"; id: string; payload: DataQueryPayload }
  | { type: "data.list"; id: string; payload: DataListPayload }
  | { type: "model.search"; id: string; payload?: ModelSearchPayload }
  | {
    type: "model.method.describe";
    id: string;
    payload: ModelMethodDescribePayload;
  }
  | { type: "workflow.search"; id: string; payload?: WorkflowSearchPayload }
  | { type: "vault.get"; id: string; payload: VaultGetPayload }
  | { type: "vault.put"; id: string; payload: VaultPutPayload }
  | { type: "audit.timeline"; id: string; payload?: AuditTimelinePayload }
  | { type: "summarise"; id: string; payload?: SummarisePayload }
  | { type: "report.get"; id: string; payload: ReportGetPayload }
  | { type: "report.search"; id: string; payload?: ReportSearchPayload }
  | { type: "report.describe"; id: string; payload: ReportDescribePayload }
  | {
    type: "report.type.search";
    id: string;
    payload?: ReportTypeSearchPayload;
  }
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

export interface DataGetResponse {
  data: Record<string, unknown>;
}

export interface DataQueryResponse {
  data: Record<string, unknown>;
}

export interface DataListResponse {
  data: Record<string, unknown>;
}

export interface ModelSearchResponse {
  data: Record<string, unknown>;
}

export interface ModelMethodDescribeResponse {
  data: Record<string, unknown>;
}

export interface WorkflowSearchResponse {
  data: Record<string, unknown>;
}

export interface VaultGetResponse {
  data: Record<string, unknown>;
}

export interface VaultPutResponse {
  data: Record<string, unknown>;
}

export interface AuditTimelineResponse {
  data: Record<string, unknown>;
}

export interface SummariseResponse {
  data: Record<string, unknown>;
}

export interface ReportGetResponse {
  data: Record<string, unknown>;
}

export interface ReportSearchResponse {
  data: Record<string, unknown>;
}

export interface ReportDescribeResponse {
  data: Record<string, unknown>;
}

export interface ReportTypeSearchResponse {
  data: Record<string, unknown>;
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
  | { type: "access.reload"; id: string; payload: AccessReloadResponse }
  | { type: "data.get"; id: string; payload: DataGetResponse }
  | { type: "data.query"; id: string; payload: DataQueryResponse }
  | { type: "data.list"; id: string; payload: DataListResponse }
  | { type: "model.search"; id: string; payload: ModelSearchResponse }
  | {
    type: "model.method.describe";
    id: string;
    payload: ModelMethodDescribeResponse;
  }
  | { type: "workflow.search"; id: string; payload: WorkflowSearchResponse }
  | { type: "vault.get"; id: string; payload: VaultGetResponse }
  | { type: "vault.put"; id: string; payload: VaultPutResponse }
  | { type: "audit.timeline"; id: string; payload: AuditTimelineResponse }
  | { type: "summarise"; id: string; payload: SummariseResponse }
  | { type: "report.get"; id: string; payload: ReportGetResponse }
  | { type: "report.search"; id: string; payload: ReportSearchResponse }
  | { type: "report.describe"; id: string; payload: ReportDescribeResponse }
  | {
    type: "report.type.search";
    id: string;
    payload: ReportTypeSearchResponse;
  };
