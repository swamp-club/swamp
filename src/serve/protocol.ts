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
  skipAllReports?: boolean;
  skipReportNames?: string[];
  skipReportLabels?: string[];
  reportNames?: string[];
  reportLabels?: string[];
  skipAllChecks?: boolean;
  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  traceparent?: string;
  tracestate?: string;
}

export interface ModelMethodRunPayload {
  modelIdOrName: string;
  methodName: string;
  inputs?: Record<string, unknown>;
  lastEvaluated?: boolean;
  runtimeTags?: Record<string, string>;
  typeArg?: string;
  definitionName?: string;
  skipAllReports?: boolean;
  skipReportNames?: string[];
  skipReportLabels?: string[];
  reportNames?: string[];
  reportLabels?: string[];
  skipAllChecks?: boolean;
  skipCheckNames?: string[];
  skipCheckLabels?: string[];
  traceparent?: string;
  tracestate?: string;
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

export interface VaultDeletePayload {
  vaultName: string;
  key: string;
  force?: boolean;
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

export interface DataSearchPayload {
  query?: string;
  type?: string;
  lifetime?: string;
  ownerType?: string;
  workflow?: string;
  model?: string;
  contentType?: string;
  since?: string;
  output?: string;
  run?: string;
  streaming?: boolean;
  tags?: Record<string, string>;
  limit?: number;
}

export interface DataVersionsPayload {
  modelIdOrName: string;
  dataName: string;
}

export interface DataDeletePayload {
  modelIdOrName: string;
  dataName: string;
  version?: number;
}

export interface DataRenamePayload {
  modelIdOrName: string;
  oldName: string;
  newName: string;
}

// ── Model operations ─────────────────────────────────────────────────

export interface ModelGetPayload {
  modelIdOrName: string;
}

export interface ModelCreatePayload {
  typeArg: string;
  name?: string;
  globalArguments?: Record<string, unknown>;
}

export interface ModelDeletePayload {
  modelIdOrName: string;
  force?: boolean;
}

export interface ModelOutputGetPayload {
  outputIdOrModelName: string;
}

export interface ModelOutputDataPayload {
  outputIdArg: string;
  name?: string;
  field?: string;
  version?: number;
}

export interface ModelOutputLogsPayload {
  outputIdArg: string;
  tail?: number;
}

export interface ModelOutputSearchPayload {
  query?: string;
}

export interface ModelMethodHistoryGetPayload {
  outputIdOrModelName: string;
}

export interface ModelMethodHistoryLogsPayload {
  outputIdOrModelName: string;
  tail?: number;
}

export interface ModelMethodHistorySearchPayload {
  query?: string;
}

export interface ModelValidatePayload {
  modelIdOrName?: string;
  labels?: string[];
  method?: string;
}

export interface ModelEvaluatePayload {
  modelIdOrName?: string;
}

// ── Workflow operations ──────────────────────────────────────────────

export interface WorkflowGetPayload {
  workflowIdOrName: string;
}

export interface WorkflowHistoryGetPayload {
  workflowIdOrName: string;
}

export interface WorkflowHistoryLogsPayload {
  runIdOrWorkflow: string;
  tail?: number;
}

export interface WorkflowHistorySearchPayload {
  query?: string;
  inputs?: Record<string, string>;
}

export interface WorkflowRunSearchPayload {
  query?: string;
  since?: string;
  status?: string;
  workflow?: string;
  tags?: Record<string, string>;
  inputs?: Record<string, string>;
  limit?: number;
}

export interface WorkflowSchemaPayload {
  workflowIdOrName?: string;
}

export interface WorkflowApprovePayload {
  workflowIdOrName: string;
  stepName: string;
  reason?: string;
  runId?: string;
  decidedBy?: string;
}

export interface WorkflowRejectPayload {
  workflowIdOrName: string;
  stepName: string;
  reason?: string;
  runId?: string;
  decidedBy?: string;
}

export interface WorkflowResumePayload {
  workflowIdOrName: string;
  runId?: string;
  inputs?: Record<string, unknown>;
  traceparent?: string;
  tracestate?: string;
}

// ── Vault operations ─────────────────────────────────────────────────

export interface VaultDescribePayload {
  vaultNameOrId: string;
  vaultType?: string;
}

export interface VaultInspectPayload {
  vaultName: string;
  key: string;
}

export interface VaultListKeysPayload {
  vaultName?: string;
}

export interface VaultSearchPayload {
  query?: string;
}

export interface VaultAnnotatePayload {
  vaultName: string;
  key: string;
  url?: string;
  notes?: string;
  labels?: string[];
  removeLabels?: string[];
  clear?: boolean;
}

// ── Server admin ─────────────────────────────────────────────────────

export interface WorkerListPayload {
  showAll?: boolean;
}

export type WorkerQueueListPayload = Record<string, never>;

export interface WorkerVerifyPayload {
  workerName?: string;
  labels?: Record<string, string>;
}

export type DatastoreStatusPayload = Record<string, never>;

// ── Extension operations ─────────────────────────────────────────────

export type ExtensionListPayload = Record<string, never>;

export interface ExtensionSearchPayload {
  query?: string;
  collective?: string;
  platform?: string | string[];
  label?: string | string[];
  contentType?: string | string[];
  channel?: string | string[];
  sort?: string;
  perPage?: number;
  page?: number;
}

export interface ExtensionInfoPayload {
  extensionName: string;
}

export type ExtensionInstallPayload = Record<string, never>;

export interface ExtensionRmPayload {
  extensionName: string;
}

export type ExtensionOutdatedPayload = Record<string, never>;

// ── Doctor operations ────────────────────────────────────────────────

export type DoctorVaultsPayload = Record<string, never>;

export type DoctorDatastoresPayload = Record<string, never>;

export type DoctorSecretsPayload = Record<string, never>;

export type DoctorWorkflowsPayload = Record<string, never>;

export type DoctorExtensionsPayload = Record<string, never>;

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
  | { type: "data.search"; id: string; payload?: DataSearchPayload }
  | { type: "data.versions"; id: string; payload: DataVersionsPayload }
  | { type: "data.delete"; id: string; payload: DataDeletePayload }
  | { type: "data.rename"; id: string; payload: DataRenamePayload }
  | { type: "model.get"; id: string; payload: ModelGetPayload }
  | { type: "model.create"; id: string; payload: ModelCreatePayload }
  | { type: "model.delete"; id: string; payload: ModelDeletePayload }
  | { type: "model.search"; id: string; payload?: ModelSearchPayload }
  | {
    type: "model.method.describe";
    id: string;
    payload: ModelMethodDescribePayload;
  }
  | {
    type: "model.output.get";
    id: string;
    payload: ModelOutputGetPayload;
  }
  | {
    type: "model.output.data";
    id: string;
    payload: ModelOutputDataPayload;
  }
  | {
    type: "model.output.logs";
    id: string;
    payload: ModelOutputLogsPayload;
  }
  | {
    type: "model.output.search";
    id: string;
    payload?: ModelOutputSearchPayload;
  }
  | {
    type: "model.method.history.get";
    id: string;
    payload: ModelMethodHistoryGetPayload;
  }
  | {
    type: "model.method.history.logs";
    id: string;
    payload: ModelMethodHistoryLogsPayload;
  }
  | {
    type: "model.method.history.search";
    id: string;
    payload?: ModelMethodHistorySearchPayload;
  }
  | {
    type: "model.validate";
    id: string;
    payload?: ModelValidatePayload;
  }
  | {
    type: "model.evaluate";
    id: string;
    payload?: ModelEvaluatePayload;
  }
  | { type: "workflow.get"; id: string; payload: WorkflowGetPayload }
  | {
    type: "workflow.history.get";
    id: string;
    payload: WorkflowHistoryGetPayload;
  }
  | {
    type: "workflow.history.logs";
    id: string;
    payload: WorkflowHistoryLogsPayload;
  }
  | {
    type: "workflow.history.search";
    id: string;
    payload?: WorkflowHistorySearchPayload;
  }
  | {
    type: "workflow.run.search";
    id: string;
    payload?: WorkflowRunSearchPayload;
  }
  | {
    type: "workflow.schema";
    id: string;
    payload: WorkflowSchemaPayload;
  }
  | { type: "workflow.search"; id: string; payload?: WorkflowSearchPayload }
  | { type: "workflow.approvals"; id: string }
  | { type: "workflow.approve"; id: string; payload: WorkflowApprovePayload }
  | { type: "workflow.reject"; id: string; payload: WorkflowRejectPayload }
  | { type: "workflow.resume"; id: string; payload: WorkflowResumePayload }
  | { type: "vault.get"; id: string; payload: VaultGetPayload }
  | { type: "vault.put"; id: string; payload: VaultPutPayload }
  | { type: "vault.delete"; id: string; payload: VaultDeletePayload }
  | { type: "vault.describe"; id: string; payload: VaultDescribePayload }
  | { type: "vault.inspect"; id: string; payload: VaultInspectPayload }
  | { type: "vault.list-keys"; id: string; payload?: VaultListKeysPayload }
  | { type: "vault.search"; id: string; payload?: VaultSearchPayload }
  | { type: "vault.annotate"; id: string; payload: VaultAnnotatePayload }
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
  | { type: "worker.list"; id: string; payload?: WorkerListPayload }
  | {
    type: "worker.queue.list";
    id: string;
    payload?: WorkerQueueListPayload;
  }
  | { type: "worker.verify"; id: string; payload?: WorkerVerifyPayload }
  | { type: "datastore.status"; id: string; payload?: DatastoreStatusPayload }
  | { type: "extension.list"; id: string; payload?: ExtensionListPayload }
  | { type: "extension.search"; id: string; payload?: ExtensionSearchPayload }
  | { type: "extension.info"; id: string; payload: ExtensionInfoPayload }
  | { type: "extension.install"; id: string; payload?: ExtensionInstallPayload }
  | { type: "extension.rm"; id: string; payload: ExtensionRmPayload }
  | {
    type: "extension.outdated";
    id: string;
    payload?: ExtensionOutdatedPayload;
  }
  | { type: "doctor.vaults"; id: string; payload?: DoctorVaultsPayload }
  | {
    type: "doctor.datastores";
    id: string;
    payload?: DoctorDatastoresPayload;
  }
  | { type: "doctor.secrets"; id: string; payload?: DoctorSecretsPayload }
  | {
    type: "doctor.workflows";
    id: string;
    payload?: DoctorWorkflowsPayload;
  }
  | {
    type: "doctor.extensions";
    id: string;
    payload?: DoctorExtensionsPayload;
  }
  | {
    type: "run.history";
    id: string;
    payload?: RunHistoryPayload;
  }
  | {
    type: "run.doctor";
    id: string;
    payload?: RunDoctorPayload;
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

export interface AccessReloadFileResult {
  filename: string;
  entryCount: number;
  created: number;
  revoked: number;
  reactivated: number;
  unchanged: number;
}

export interface AccessReloadResponse {
  success: boolean;
  grantCount: number;
  groupCount: number;
  filesProcessed?: number;
  fileResults?: AccessReloadFileResult[];
  errors?: string[];
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

export interface DataSearchResponse {
  data: Record<string, unknown>;
}

export interface DataVersionsResponse {
  data: Record<string, unknown>;
}

export interface DataDeleteResponse {
  data: Record<string, unknown>;
}

export interface DataRenameResponse {
  data: Record<string, unknown>;
}

export interface ModelGetResponse {
  data: Record<string, unknown>;
}

export interface ModelCreateResponse {
  data: Record<string, unknown>;
}

export interface ModelDeleteResponse {
  data: Record<string, unknown>;
}

export interface ModelSearchResponse {
  data: Record<string, unknown>;
}

export interface ModelMethodDescribeResponse {
  data: Record<string, unknown>;
}

export interface ModelOutputGetResponse {
  data: Record<string, unknown>;
}

export interface ModelOutputDataResponse {
  data: Record<string, unknown>;
}

export interface ModelOutputLogsResponse {
  data: Record<string, unknown>;
}

export interface ModelOutputSearchResponse {
  data: Record<string, unknown>;
}

export interface ModelMethodHistoryGetResponse {
  data: Record<string, unknown>;
}

export interface ModelMethodHistoryLogsResponse {
  data: Record<string, unknown>;
}

export interface ModelMethodHistorySearchResponse {
  data: Record<string, unknown>;
}

export interface ModelValidateResponse {
  data: Record<string, unknown>;
}

export interface ModelEvaluateResponse {
  data: Record<string, unknown>;
}

export interface WorkflowGetResponse {
  data: Record<string, unknown>;
}

export interface WorkflowHistoryGetResponse {
  data: Record<string, unknown>;
}

export interface WorkflowHistoryLogsResponse {
  data: Record<string, unknown>;
}

export interface WorkflowHistorySearchResponse {
  data: Record<string, unknown>;
}

export interface WorkflowRunSearchResponse {
  data: Record<string, unknown>;
}

export interface WorkflowSchemaResponse {
  data: Record<string, unknown>;
}

export interface WorkflowSearchResponse {
  data: Record<string, unknown>;
}

export interface WorkflowApprovalsResponse {
  data: Record<string, unknown>;
}

export interface WorkflowApproveResponse {
  data: Record<string, unknown>;
}

export interface WorkflowRejectResponse {
  data: Record<string, unknown>;
}

export interface VaultGetResponse {
  data: Record<string, unknown>;
}

export interface VaultPutResponse {
  data: Record<string, unknown>;
}

export interface VaultDeleteResponse {
  data: Record<string, unknown>;
}

export interface VaultDescribeResponse {
  data: Record<string, unknown>;
}

export interface VaultInspectResponse {
  data: Record<string, unknown>;
}

export interface VaultListKeysResponse {
  data: Record<string, unknown>;
}

export interface VaultSearchResponse {
  data: Record<string, unknown>;
}

export interface VaultAnnotateResponse {
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

export interface WorkerListResponse {
  data: Record<string, unknown>;
}

export interface WorkerQueueListResponse {
  data: Record<string, unknown>;
}

export interface WorkerProbeResult {
  name: string;
  status: "pass" | "fail" | "error";
  platform?: string;
  arch?: string;
  probeMarkerOk?: boolean;
  queryOk?: boolean;
  dataPlaneOk?: boolean;
  failures?: string[];
  error?: string;
}

export interface WorkerVerifyData {
  workers: WorkerProbeResult[];
  total: number;
  passed: number;
  failed: number;
}

export interface WorkerVerifyResponse {
  data: Record<string, unknown>;
}

export interface DatastoreStatusResponse {
  data: Record<string, unknown>;
}

export interface ExtensionListResponse {
  data: Record<string, unknown>;
}

export interface ExtensionSearchResponse {
  data: Record<string, unknown>;
}

export interface ExtensionInfoResponse {
  data: Record<string, unknown>;
}

export interface ExtensionInstallResponse {
  data: Record<string, unknown>;
}

export interface ExtensionRmResponse {
  data: Record<string, unknown>;
}

export interface ExtensionOutdatedResponse {
  data: Record<string, unknown>;
}

export interface DoctorVaultsResponse {
  data: Record<string, unknown>;
}

export interface DoctorDatastoresResponse {
  data: Record<string, unknown>;
}

export interface DoctorSecretsResponse {
  data: Record<string, unknown>;
}

export interface DoctorWorkflowsResponse {
  data: Record<string, unknown>;
}

export interface DoctorExtensionsResponse {
  data: Record<string, unknown>;
}

export interface RunHistoryPayload {
  active?: boolean;
  all?: boolean;
}

export interface RunDoctorPayload {
  fix?: boolean;
}

export interface RunHistoryResponse {
  runs: Array<{
    id: string;
    runKind: string;
    modelType: string | null;
    methodName: string | null;
    workflowName: string | null;
    pid: number;
    hostname: string;
    status: string;
    startedAt: string;
    heartbeatAt: string;
    stale: boolean;
  }>;
}

export interface RunDoctorResponse {
  totalTracked: number;
  active: number;
  stale: number;
  reaped: number;
  activeRuns: RunHistoryResponse["runs"];
  staleRuns: RunHistoryResponse["runs"];
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
  | { type: "data.search"; id: string; payload: DataSearchResponse }
  | { type: "data.versions"; id: string; payload: DataVersionsResponse }
  | { type: "data.delete"; id: string; payload: DataDeleteResponse }
  | { type: "data.rename"; id: string; payload: DataRenameResponse }
  | { type: "model.get"; id: string; payload: ModelGetResponse }
  | { type: "model.create"; id: string; payload: ModelCreateResponse }
  | { type: "model.delete"; id: string; payload: ModelDeleteResponse }
  | { type: "model.search"; id: string; payload: ModelSearchResponse }
  | {
    type: "model.method.describe";
    id: string;
    payload: ModelMethodDescribeResponse;
  }
  | { type: "model.output.get"; id: string; payload: ModelOutputGetResponse }
  | { type: "model.output.data"; id: string; payload: ModelOutputDataResponse }
  | { type: "model.output.logs"; id: string; payload: ModelOutputLogsResponse }
  | {
    type: "model.output.search";
    id: string;
    payload: ModelOutputSearchResponse;
  }
  | {
    type: "model.method.history.get";
    id: string;
    payload: ModelMethodHistoryGetResponse;
  }
  | {
    type: "model.method.history.logs";
    id: string;
    payload: ModelMethodHistoryLogsResponse;
  }
  | {
    type: "model.method.history.search";
    id: string;
    payload: ModelMethodHistorySearchResponse;
  }
  | { type: "model.validate"; id: string; payload: ModelValidateResponse }
  | { type: "model.evaluate"; id: string; payload: ModelEvaluateResponse }
  | { type: "workflow.get"; id: string; payload: WorkflowGetResponse }
  | {
    type: "workflow.history.get";
    id: string;
    payload: WorkflowHistoryGetResponse;
  }
  | {
    type: "workflow.history.logs";
    id: string;
    payload: WorkflowHistoryLogsResponse;
  }
  | {
    type: "workflow.history.search";
    id: string;
    payload: WorkflowHistorySearchResponse;
  }
  | {
    type: "workflow.run.search";
    id: string;
    payload: WorkflowRunSearchResponse;
  }
  | { type: "workflow.schema"; id: string; payload: WorkflowSchemaResponse }
  | { type: "workflow.search"; id: string; payload: WorkflowSearchResponse }
  | {
    type: "workflow.approvals";
    id: string;
    payload: WorkflowApprovalsResponse;
  }
  | { type: "workflow.approve"; id: string; payload: WorkflowApproveResponse }
  | { type: "workflow.reject"; id: string; payload: WorkflowRejectResponse }
  | { type: "vault.get"; id: string; payload: VaultGetResponse }
  | { type: "vault.put"; id: string; payload: VaultPutResponse }
  | { type: "vault.delete"; id: string; payload: VaultDeleteResponse }
  | { type: "vault.describe"; id: string; payload: VaultDescribeResponse }
  | { type: "vault.inspect"; id: string; payload: VaultInspectResponse }
  | { type: "vault.list-keys"; id: string; payload: VaultListKeysResponse }
  | { type: "vault.search"; id: string; payload: VaultSearchResponse }
  | { type: "vault.annotate"; id: string; payload: VaultAnnotateResponse }
  | { type: "audit.timeline"; id: string; payload: AuditTimelineResponse }
  | { type: "summarise"; id: string; payload: SummariseResponse }
  | { type: "report.get"; id: string; payload: ReportGetResponse }
  | { type: "report.search"; id: string; payload: ReportSearchResponse }
  | { type: "report.describe"; id: string; payload: ReportDescribeResponse }
  | {
    type: "report.type.search";
    id: string;
    payload: ReportTypeSearchResponse;
  }
  | { type: "worker.list"; id: string; payload: WorkerListResponse }
  | {
    type: "worker.queue.list";
    id: string;
    payload: WorkerQueueListResponse;
  }
  | { type: "worker.verify"; id: string; payload: WorkerVerifyResponse }
  | { type: "datastore.status"; id: string; payload: DatastoreStatusResponse }
  | { type: "extension.list"; id: string; payload: ExtensionListResponse }
  | { type: "extension.search"; id: string; payload: ExtensionSearchResponse }
  | { type: "extension.info"; id: string; payload: ExtensionInfoResponse }
  | { type: "extension.install"; id: string; payload: ExtensionInstallResponse }
  | { type: "extension.rm"; id: string; payload: ExtensionRmResponse }
  | {
    type: "extension.outdated";
    id: string;
    payload: ExtensionOutdatedResponse;
  }
  | { type: "doctor.vaults"; id: string; payload: DoctorVaultsResponse }
  | {
    type: "doctor.datastores";
    id: string;
    payload: DoctorDatastoresResponse;
  }
  | { type: "doctor.secrets"; id: string; payload: DoctorSecretsResponse }
  | { type: "doctor.workflows"; id: string; payload: DoctorWorkflowsResponse }
  | {
    type: "doctor.extensions";
    id: string;
    payload: DoctorExtensionsResponse;
  }
  | { type: "run.history"; id: string; payload: RunHistoryResponse }
  | { type: "run.doctor"; id: string; payload: RunDoctorResponse };
