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

// Wire types for serve's bearer-only HTTP routes, copied from serve and kept in
// step by http_protocol_test.ts.

import type { WorkflowRunView } from "./protocol.ts";

export const HTTP_ACTION_PATH = "/api/v1/action";
export const DELEGATION_ROUTE_PREFIX = "/api/v1/delegations/";

export const HTTP_ACTION_TYPES = [
  "workflow.run",
  "workflow.resume",
  "workflow.history.get",
  "workflow.approvals",
  "workflow.approve",
  "workflow.reject",
  "workflow.signal",
] as const;

export type HttpActionType = typeof HTTP_ACTION_TYPES[number];

interface TraceFields {
  traceparent?: string;
  tracestate?: string;
}

export interface RunActionPayload extends TraceFields {
  workflowIdOrName: string;
  /** names one user action, so a retry replays rather than starting again */
  idempotencyKey: string;
  inputs?: Record<string, unknown>;
  runtimeTags?: Record<string, string>;
}

export interface ResumeActionPayload extends TraceFields {
  workflowIdOrName: string;
  runId: string;
  inputs?: Record<string, unknown>;
}

export interface HistoryActionPayload {
  runId: string;
}

export interface DecisionActionPayload {
  workflowIdOrName: string;
  runId: string;
  stepName: string;
  jobName?: string;
  /** the attempt the caller saw, so a stale decision records nothing */
  suspendedAt: string;
  reason?: string;
}

export type SignalActionPayload =
  | { waitId: string; payload: unknown; idempotencyKey?: string }
  | {
    workflow: string;
    key: string;
    payload: unknown;
    idempotencyKey?: string;
  };

export interface ActionSuccessBody {
  readonly requestId: string;
  readonly type: string;
  readonly data: unknown;
}

export interface ActionStartedData {
  readonly runId: string;
  readonly workflowName: string;
  readonly replayed: boolean;
}

export interface ActionFailureBody {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
  readonly receipt?: unknown;
  readonly pending?: unknown;
  readonly lastWait?: unknown;
  readonly errors?: unknown;
  // the gate a refused resume waits on
  readonly gate?: { readonly job: string; readonly step: string };
}

export const HTTP_ACTION_ROUTE_CODES = [
  "method_not_allowed",
  "unauthorized",
  "rate_limited",
  "unsupported_media_type",
  "payload_too_large",
  "invalid_request",
  "type_not_allowed",
  "runs_unavailable",
  "still_working",
  "leader_upgrade_required",
  "run_not_started",
] as const;

/** a gate waiting for a decision, as workflow.approvals lists it */
export interface PendingApproval {
  workflowId: string;
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt: string | undefined;
  prompt: string | undefined;
  inputs: Readonly<Record<string, unknown>>;
  initiatedBy?: string;
  canDecide?: boolean;
  canDecideReason?: "grant-condition";
  canCancel?: boolean;
  canResume?: boolean;
}

export interface ExpiredApproval {
  workflowId: string;
  workflowName: string;
  runId: string;
  stepName: string;
  suspendedAt: string;
  timeoutSeconds: number;
  expiredAt: string;
}

export interface ApprovalsData {
  approvals: PendingApproval[];
  expired: ExpiredApproval[];
}

export interface ApproveData {
  runId: string;
  workflowName: string;
  stepName: string;
  approved: true;
  decidedBy: string;
  client?: string;
  reason: string | null;
  allGatesDecided: boolean;
}

export interface RejectData {
  runId: string;
  workflowId: string;
  workflowName: string;
  stepName: string;
  approved: false;
  decidedBy: string;
  client?: string;
  reason: string | null;
  runStatus: string;
}

export interface SignalReceipt {
  id: string;
  receivedAt: string;
  submittedBy: string;
  idempotencyKey?: string;
}

export interface SignalDeliveredData {
  waitId: string;
  signal: SignalReceipt & { waitId: string };
  duplicate?: true;
}

export interface SignalPendingData {
  signal: SignalReceipt;
  heldUntil: string;
  duplicate?: true;
  key?: string;
  workflowId?: string;
  workflowName?: string;
}

export interface SignalAcceptedData {
  signal: SignalReceipt;
  duplicate?: true;
}

export type HistoryData = WorkflowRunView;

export interface LinkExternalIdentity {
  platform: string;
  team_id: string;
  user_id: string;
  display: string;
  workspace: string;
  email?: string;
}

export interface CeilingDocument {
  version: 1;
  ceiling: { actions: string[]; resource: string }[];
}

export const DELEGATION_ROUTE_CODES = [
  "already_redeemed",
  "ceiling_too_wide",
  "club_busy",
  "club_refused",
  "club_unavailable",
  "email_required",
  "internal_error",
  "invalid_ceiling",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "links_not_enabled",
  "links_require_collective_client",
  "links_require_plan",
  "links_unavailable",
  "method_not_allowed",
  "no_instance",
  "not_found",
  "not_saved",
  "payload_too_large",
  "rate_limited",
  "team_not_ready",
  "team_unknown",
  "too_many_pending",
  "unsupported_media_type",
] as const;

export type DelegationRouteCode = typeof DELEGATION_ROUTE_CODES[number];

export const REFRESH_REFUSAL_REASONS = [
  "mismatch",
  "unknown",
  "not_issued",
  "not_admitted",
  "ended",
  "expired",
  "superseded",
  "unreadable",
  "suspended",
  "links_unavailable",
] as const;

export type RefreshRefusalReason = typeof REFRESH_REFUSAL_REASONS[number];

export interface DelegationFailureBody {
  readonly code: DelegationRouteCode;
  readonly message: string;
  readonly reason?: RefreshRefusalReason;
}

export interface LinkStartedBody {
  readonly pendingId: string;
  readonly redeemSecret: string;
  readonly consentUrl: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface LinkPersonBody {
  readonly username?: string;
  readonly email?: string;
}

export interface TokensIssuedBody {
  readonly status: "issued";
  readonly delegationId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly expiresAt?: string;
  readonly person: LinkPersonBody;
}

export type RedeemBody =
  | { readonly status: "pending"; readonly interval: number }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "ended"; readonly cause: string }
  | TokensIssuedBody;

export interface RefreshedBody {
  readonly status: "refreshed";
  readonly delegationId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly expiresIn: number;
  readonly expiresAt?: string;
  readonly person: LinkPersonBody;
}

export interface EndedBody {
  readonly ended: true;
}
