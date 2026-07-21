// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and\/or modify
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
// along with Swamp.  If not, see <https:\/\/www.gnu.org\/licenses\/>.

/**
 * Wire protocol types for the swamp WebSocket API.
 *
 * These types mirror src/serve/protocol.ts in the swamp CLI. They are
 * duplicated here so the client package has zero dependencies on the CLI
 * source tree and can be published independently to JSR.
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
}

// ── Data operations ──────────────────────────────────────────────────────

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

// ── Model operations ─────────────────────────────────────────────────────

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

export interface ModelSearchPayload {
  query?: string;
}

export interface ModelMethodDescribePayload {
  modelIdOrName: string;
  methodName: string;
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

// ── Workflow operations ──────────────────────────────────────────────────

export interface WorkflowGetPayload {
  workflowIdOrName: string;
}

export interface WorkflowSearchPayload {
  query?: string;
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
}

export interface WorkflowRunSearchPayload {
  query?: string;
  since?: string;
  status?: string;
  workflow?: string;
  tags?: Record<string, string>;
  limit?: number;
}

export interface WorkflowSchemaPayload {
  workflowIdOrName: string;
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
}

// ── Vault operations ─────────────────────────────────────────────────────

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

// ── Audit / summary / reports ────────────────────────────────────────────

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

// ── Extension operations ─────────────────────────────────────────────────

export type ExtensionListPayload = Record<string, never>;

export interface ExtensionSearchPayload {
  query?: string;
  collective?: string;
  platform?: string;
  label?: string;
  contentType?: string;
  channel?: string;
  sort?: string;
  perPage?: number;
  page?: number;
}

export interface ExtensionInfoPayload {
  extensionName: string;
}

export interface ExtensionRmPayload {
  extensionName: string;
}

// ── Doctor operations ────────────────────────────────────────────────────

// Doctor operations have no payload fields.

// ── Server admin ─────────────────────────────────────────────────────────

// Worker list and datastore status have no payload fields.

// ── ServerRequest union ──────────────────────────────────────────────────

export type ServerRequest =
  // Streaming operations
  | { type: "workflow.run"; id: string; payload: WorkflowRunPayload }
  | { type: "model.method.run"; id: string; payload: ModelMethodRunPayload }
  | { type: "workflow.resume"; id: string; payload: WorkflowResumePayload }
  // Data operations
  | { type: "data.get"; id: string; payload: DataGetPayload }
  | { type: "data.query"; id: string; payload: DataQueryPayload }
  | { type: "data.list"; id: string; payload: DataListPayload }
  | { type: "data.search"; id: string; payload?: DataSearchPayload }
  | { type: "data.versions"; id: string; payload: DataVersionsPayload }
  | { type: "data.delete"; id: string; payload: DataDeletePayload }
  | { type: "data.rename"; id: string; payload: DataRenamePayload }
  // Model operations
  | { type: "model.get"; id: string; payload: ModelGetPayload }
  | { type: "model.create"; id: string; payload: ModelCreatePayload }
  | { type: "model.delete"; id: string; payload: ModelDeletePayload }
  | { type: "model.search"; id: string; payload?: ModelSearchPayload }
  | {
    type: "model.method.describe";
    id: string;
    payload: ModelMethodDescribePayload;
  }
  | { type: "model.output.get"; id: string; payload: ModelOutputGetPayload }
  | { type: "model.output.data"; id: string; payload: ModelOutputDataPayload }
  | { type: "model.output.logs"; id: string; payload: ModelOutputLogsPayload }
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
  | { type: "model.validate"; id: string; payload?: ModelValidatePayload }
  | { type: "model.evaluate"; id: string; payload?: ModelEvaluatePayload }
  // Workflow operations
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
  | { type: "workflow.schema"; id: string; payload: WorkflowSchemaPayload }
  | { type: "workflow.search"; id: string; payload?: WorkflowSearchPayload }
  | { type: "workflow.approve"; id: string; payload: WorkflowApprovePayload }
  | { type: "workflow.reject"; id: string; payload: WorkflowRejectPayload }
  // Vault operations
  | { type: "vault.get"; id: string; payload: VaultGetPayload }
  | { type: "vault.put"; id: string; payload: VaultPutPayload }
  | { type: "vault.delete"; id: string; payload: VaultDeletePayload }
  | { type: "vault.describe"; id: string; payload: VaultDescribePayload }
  | { type: "vault.inspect"; id: string; payload: VaultInspectPayload }
  | { type: "vault.list-keys"; id: string; payload?: VaultListKeysPayload }
  | { type: "vault.search"; id: string; payload?: VaultSearchPayload }
  | { type: "vault.annotate"; id: string; payload: VaultAnnotatePayload }
  // Audit / summary / reports
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
  // Extensions
  | { type: "extension.list"; id: string }
  | { type: "extension.search"; id: string; payload?: ExtensionSearchPayload }
  | { type: "extension.info"; id: string; payload: ExtensionInfoPayload }
  | { type: "extension.install"; id: string }
  | { type: "extension.rm"; id: string; payload: ExtensionRmPayload }
  | { type: "extension.outdated"; id: string }
  // Doctor
  | { type: "doctor.vaults"; id: string }
  | { type: "doctor.secrets"; id: string }
  | { type: "doctor.workflows"; id: string }
  | { type: "doctor.extensions"; id: string }
  // Server admin
  | { type: "worker.list"; id: string }
  | { type: "datastore.status"; id: string }
  // Control
  | { type: "cancel"; id: string };

// ── Outbound (server → client) ───────────────────────────────────────────

export interface SerializedEvent {
  kind: string;
  [key: string]: unknown;
}

export interface SerializedError {
  code: string;
  message: string;
  details?: unknown;
}

/** Generic response payload for request-response operations. */
export interface DataResponse {
  data: Record<string, unknown>;
}

export type ServerMessage =
  // Streaming frames
  | { type: "event"; id: string; event: SerializedEvent }
  | { type: "error"; id: string; error: SerializedError }
  | { type: "done"; id: string }
  // Data responses
  | { type: "data.get"; id: string; payload: DataResponse }
  | { type: "data.query"; id: string; payload: DataResponse }
  | { type: "data.list"; id: string; payload: DataResponse }
  | { type: "data.search"; id: string; payload: DataResponse }
  | { type: "data.versions"; id: string; payload: DataResponse }
  | { type: "data.delete"; id: string; payload: DataResponse }
  | { type: "data.rename"; id: string; payload: DataResponse }
  // Model responses
  | { type: "model.get"; id: string; payload: DataResponse }
  | { type: "model.create"; id: string; payload: DataResponse }
  | { type: "model.delete"; id: string; payload: DataResponse }
  | { type: "model.search"; id: string; payload: DataResponse }
  | { type: "model.method.describe"; id: string; payload: DataResponse }
  | { type: "model.output.get"; id: string; payload: DataResponse }
  | { type: "model.output.data"; id: string; payload: DataResponse }
  | { type: "model.output.logs"; id: string; payload: DataResponse }
  | { type: "model.output.search"; id: string; payload: DataResponse }
  | { type: "model.method.history.get"; id: string; payload: DataResponse }
  | { type: "model.method.history.logs"; id: string; payload: DataResponse }
  | { type: "model.method.history.search"; id: string; payload: DataResponse }
  | { type: "model.validate"; id: string; payload: DataResponse }
  | { type: "model.evaluate"; id: string; payload: DataResponse }
  // Workflow responses
  | { type: "workflow.get"; id: string; payload: DataResponse }
  | { type: "workflow.history.get"; id: string; payload: DataResponse }
  | { type: "workflow.history.logs"; id: string; payload: DataResponse }
  | { type: "workflow.history.search"; id: string; payload: DataResponse }
  | { type: "workflow.run.search"; id: string; payload: DataResponse }
  | { type: "workflow.schema"; id: string; payload: DataResponse }
  | { type: "workflow.search"; id: string; payload: DataResponse }
  | { type: "workflow.approve"; id: string; payload: DataResponse }
  | { type: "workflow.reject"; id: string; payload: DataResponse }
  // Vault responses
  | { type: "vault.get"; id: string; payload: DataResponse }
  | { type: "vault.put"; id: string; payload: DataResponse }
  | { type: "vault.delete"; id: string; payload: DataResponse }
  | { type: "vault.describe"; id: string; payload: DataResponse }
  | { type: "vault.inspect"; id: string; payload: DataResponse }
  | { type: "vault.list-keys"; id: string; payload: DataResponse }
  | { type: "vault.search"; id: string; payload: DataResponse }
  | { type: "vault.annotate"; id: string; payload: DataResponse }
  // Audit / summary / report responses
  | { type: "audit.timeline"; id: string; payload: DataResponse }
  | { type: "summarise"; id: string; payload: DataResponse }
  | { type: "report.get"; id: string; payload: DataResponse }
  | { type: "report.search"; id: string; payload: DataResponse }
  | { type: "report.describe"; id: string; payload: DataResponse }
  | { type: "report.type.search"; id: string; payload: DataResponse }
  // Extension responses
  | { type: "extension.list"; id: string; payload: DataResponse }
  | { type: "extension.search"; id: string; payload: DataResponse }
  | { type: "extension.info"; id: string; payload: DataResponse }
  | { type: "extension.install"; id: string; payload: DataResponse }
  | { type: "extension.rm"; id: string; payload: DataResponse }
  | { type: "extension.outdated"; id: string; payload: DataResponse }
  // Doctor responses
  | { type: "doctor.vaults"; id: string; payload: DataResponse }
  | { type: "doctor.secrets"; id: string; payload: DataResponse }
  | { type: "doctor.workflows"; id: string; payload: DataResponse }
  | { type: "doctor.extensions"; id: string; payload: DataResponse }
  // Server admin responses
  | { type: "worker.list"; id: string; payload: DataResponse }
  | { type: "datastore.status"; id: string; payload: DataResponse }
  // Access responses (internal — not in client package's primary API)
  | { type: "access.grant.list"; id: string; payload: DataResponse }
  | { type: "access.group.list"; id: string; payload: DataResponse }
  | { type: "access.check"; id: string; payload: DataResponse }
  | { type: "access.can-i"; id: string; payload: DataResponse }
  | { type: "access.reload"; id: string; payload: DataResponse };

// ── Event types (wire-format discriminated unions) ────────────────────────

/** Events emitted during a workflow run. */
export type WorkflowRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "evaluating_workflow" }
  | { kind: "started"; runId: string; workflowName: string }
  | { kind: "job_started"; jobId: string }
  | { kind: "job_completed"; jobId: string; status: string }
  | { kind: "job_skipped"; jobId: string }
  | { kind: "step_started"; jobId: string; stepId: string }
  | { kind: "step_completed"; jobId: string; stepId: string }
  | { kind: "step_skipped"; jobId: string; stepId: string }
  | {
    kind: "step_failed";
    jobId: string;
    stepId: string;
    error: string;
    allowedFailure?: boolean;
  }
  | {
    kind: "model_resolved";
    jobId: string;
    stepId: string;
    modelName: string;
    modelType: string;
    methodName: string;
  }
  | {
    kind: "env_var_warning";
    jobId: string;
    stepId: string;
    modelName: string;
    envVars: Array<{ path: string; envVar: string }>;
    message: string;
  }
  | {
    kind: "method_executing";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
  }
  | {
    kind: "method_output";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "method_event";
    jobId: string;
    stepId: string;
    modelName: string;
    methodName: string;
    event: Record<string, unknown>;
  }
  | { kind: "report_started"; reportName: string; scope: string }
  | {
    kind: "report_completed";
    reportName: string;
    scope: string;
    markdown: string;
    json: Record<string, unknown>;
  }
  | { kind: "report_failed"; reportName: string; scope: string; error: string }
  | { kind: "completed"; run: WorkflowRunView }
  | { kind: "cancelled"; run: WorkflowRunView; reason?: string }
  | { kind: "error"; error: SerializedError };

/** Events emitted during a model method run. */
export type ModelMethodRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "resolving_model"; modelIdOrName: string }
  | {
    kind: "model_resolved";
    modelName: string;
    modelType: string;
    methodName: string;
  }
  | {
    kind: "env_var_warning";
    modelName: string;
    envVars: Array<{ path: string; envVar: string }>;
    message: string;
  }
  | { kind: "evaluating_expressions"; lastEvaluated: boolean }
  | { kind: "executing"; modelName: string; methodName: string }
  | {
    kind: "method_output";
    modelName: string;
    methodName: string;
    stream: "stdout" | "stderr";
    line: string;
  }
  | {
    kind: "method_event";
    modelName: string;
    methodName: string;
    event: Record<string, unknown>;
  }
  | { kind: "data_artifact_saved"; name: string; path: string }
  | { kind: "report_started"; reportName: string; scope: string }
  | {
    kind: "report_completed";
    reportName: string;
    scope: string;
    markdown: string;
    json: Record<string, unknown>;
  }
  | { kind: "report_failed"; reportName: string; scope: string; error: string }
  | { kind: "completed"; run: ModelMethodRunView }
  | { kind: "cancelled"; run: ModelMethodRunView; reason?: string }
  | { kind: "auto_gc_started" }
  | {
    kind: "auto_gc_completed";
    versionsDeleted: number;
    bytesReclaimed: number;
  }
  | { kind: "error"; error: SerializedError };

// ── Completed event payload types ────────────────────────────────────────

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  jobs: Array<{
    name: string;
    status: string;
    steps: Array<{
      name: string;
      status: string;
      error?: string;
      duration?: number;
      dataArtifacts?: Array<{
        dataId: string;
        name: string;
        version: number;
        tags: Record<string, string>;
      }>;
      allowedFailure?: boolean;
    }>;
    duration?: number;
  }>;
  duration?: number;
  path?: string;
}

export interface ModelMethodRunView {
  modelId: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: string;
  duration?: number;
  outputId: string;
  logFile?: string;
  dataArtifacts: Array<{
    id: string;
    name: string;
    path: string;
    attributes?: Record<string, unknown>;
  }>;
}
