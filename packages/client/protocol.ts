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
 * mirrors src/serve/protocol.ts, duplicated so the package has no dependency on
 * the CLI source and can be published independently
 */

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
  noSupersede?: boolean;
  /**
   * The client's inherited held-lock list (`SWAMP_LOCK_HOLDER_TOKENS`), so a
   * run requested by a step of this server's own run skips that step's lock.
   */
  lockHolderTokens?: string;
}

export const SERVE_CAPABILITY_LITERAL_INPUTS = "literal-inputs";

export const SERVE_CAPABILITY_RESUME_FROM_JOB = "resume-from-job";

export interface ModelMethodRunPayload {
  modelIdOrName: string;
  methodName: string;
  inputs?: Record<string, unknown>;
  /**
   * treat `inputs` as data: expression text is never evaluated. Only send to a
   * server whose `server.version` lists SERVE_CAPABILITY_LITERAL_INPUTS; an
   * older server ignores the field and evaluates
   */
  literalInputs?: boolean;
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
  /**
   * The client's inherited held-lock list (`SWAMP_LOCK_HOLDER_TOKENS`), so a
   * run requested by a step of this server's own run skips that step's lock.
   */
  lockHolderTokens?: string;
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
  /**
   * Orders the matches by `createdAt` or `tags.<key>`, compared as strings,
   * with the item identity as the tie-break.
   */
  sort?: { field: string; direction: "asc" | "desc" };
  /**
   * The `nextCursor` a previous page of the same sorted query returned; the
   * response's `data.nextCursor` is set when a sorted page filled its limit.
   */
  cursor?: string;
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
  lifecycle?: string;
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
  includeInternal?: boolean;
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

export interface ModelUsageSummaryPayload {
  /**
   * Counts outputs started at or after this ISO 8601 instant, or this long
   * ago by serve's clock for a duration like `7d`.
   */
  since?: string;
  until?: string;
  /** Outputs kept per model in `recent`; clamped to 0..100, default 20. */
  recentLimit?: number;
}

export interface ModelOutputSearchPayload {
  query?: string;
  model?: string;
  since?: string;
  until?: string;
  /**
   * At most this many results, most recent first, counted among the outputs
   * the caller may read.
   */
  limit?: number;
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

export interface WorkflowGetPayload {
  workflowIdOrName: string;
}

export interface WorkflowSearchPayload {
  query?: string;
  /** Page size; omitted returns every authorized workflow. */
  limit?: number;
  offset?: number;
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
  workflow?: string;
  inputs?: Record<string, string>;
  filter?: string;
}

export interface WorkflowRunSearchPayload {
  query?: string;
  /** Runs started at or after: a duration back from now (`7d`) or ISO time. */
  since?: string;
  until?: string;
  status?: string;
  workflow?: string;
  /** Runs of any of these workflows, by exact name; empty filters nothing. */
  workflows?: string[];
  triggerSource?: string;
  /** Runs with any of these statuses; with `status`, both must hold. */
  statuses?: string[];
  /** Runs with any of these trigger sources; with `triggerSource`, both hold. */
  triggerSources?: string[];
  tags?: Record<string, string>;
  inputs?: Record<string, string>;
  /** Page size; the server applies a default of 500 when omitted. */
  limit?: number;
  offset?: number;
}

export interface ModelUsageSummaryRecentOutput {
  id: string;
  methodName: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  triggeredBy?: string;
  workflowId?: string;
  workflowName?: string;
  workflowRunId?: string;
  stepName?: string;
}

export interface ModelUsageSummaryModel {
  definitionId: string;
  modelName: string;
  type: string;
  executions: number;
  failed: number;
  lastStartedAt: string;
  methods: string[];
  recent: ModelUsageSummaryRecentOutput[];
}

export interface ModelUsageSummaryData {
  since?: string;
  until?: string;
  totals: { executions: number; failed: number };
  models: ModelUsageSummaryModel[];
}

export interface ModelUsageSummaryResponse {
  data: ModelUsageSummaryData;
}

/** counts only runs the caller may read; every field is optional */
export interface WorkflowRunSummaryPayload {
  since?: string;
  until?: string;
  workflows?: string[];
  triggerSource?: string;
  triggerSources?: string[];
  /** Runs kept per workflow in `recent`; clamped to 0..100, default 20. */
  recentLimit?: number;
  timeline?: boolean;
}

export interface WorkflowRunSummaryRecentRun {
  runId: string;
  status: string;
  startedAt?: string;
  duration?: number;
  triggerSource?: string;
}

/**
 * The runs of one workflow, counted. `failed` includes interrupted runs and
 * `running` includes pending ones; a status in no bucket counts in `runs`
 * only.
 */
export interface WorkflowRunSummaryWorkflow {
  workflowId: string;
  workflowName: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  running: number;
  suspended: number;
  durationMs: number;
  lastStartedAt?: string;
  recent: WorkflowRunSummaryRecentRun[];
}

export interface WorkflowRunSummaryBucket {
  start: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface WorkflowRunSummaryData {
  since?: string;
  until?: string;
  totals: {
    workflows: number;
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    running: number;
    suspended: number;
    durationMs: number;
  };
  workflows: WorkflowRunSummaryWorkflow[];
  /** Start of the oldest counted run; absent when none has a start. */
  oldestStartedAt?: string;
  timeline?: WorkflowRunSummaryBucket[];
}

export interface WorkflowRunSummaryResponse {
  data: WorkflowRunSummaryData;
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

export interface WorkflowCancelPayload {
  runId: string;
  workflowIdOrName?: string;
  reason?: string;
}

export interface WorkflowResumePayload {
  workflowIdOrName: string;
  runId?: string;
  from?: string;
  /**
   * the job of the `from` step when its name is used in more than one job. Only
   * send to a server whose `server.version` lists
   * SERVE_CAPABILITY_RESUME_FROM_JOB; an older server resets the `from` step in
   * every job that has it
   */
  fromJob?: string;
  inputs?: Record<string, unknown>;
  traceparent?: string;
  tracestate?: string;
  lockHolderTokens?: string;
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
  labels?: Record<string, string>;
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
  labels?: Record<string, string>;
  removeLabels?: string[];
  clear?: boolean;
}

export interface WorkerListPayload {
  showAll?: boolean;
  /** Also return workers that disconnected within this many ms (max 24h). */
  disconnectedWithinMs?: number;
}

export interface WorkerLeaseListPayload {
  dispatchIds?: string[];
  /** Also return leases written within this many ms (max 5 minutes). */
  endedWithinMs?: number;
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

export interface ExtensionRmPayload {
  extensionName: string;
}

export interface RunHistoryPayload {
  active?: boolean;
  all?: boolean;
}

export interface WorkflowTriggerGetPayload {
  workflowName: string;
}

export interface EffectiveTrigger {
  readonly schedule: string | null;
  readonly inputs: Record<string, unknown>;
}

export interface WorkflowTriggerGetResult {
  readonly workflowName: string;
  readonly builtIn: EffectiveTrigger | null;
  readonly override: {
    readonly schedule?: string;
    readonly inputs?: Record<string, unknown>;
  } | null;
  readonly effective: EffectiveTrigger;
}

export type ServerRequest =
  | { type: "workflow.run"; id: string; payload: WorkflowRunPayload }
  | { type: "model.method.run"; id: string; payload: ModelMethodRunPayload }
  | { type: "workflow.resume"; id: string; payload: WorkflowResumePayload }
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
  | { type: "model.output.get"; id: string; payload: ModelOutputGetPayload }
  | { type: "model.output.data"; id: string; payload: ModelOutputDataPayload }
  | { type: "model.output.logs"; id: string; payload: ModelOutputLogsPayload }
  | {
    type: "model.output.search";
    id: string;
    payload?: ModelOutputSearchPayload;
  }
  | {
    type: "model.usage.summary";
    id: string;
    payload?: ModelUsageSummaryPayload;
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
    type: "workflow.run.summary";
    id: string;
    payload?: WorkflowRunSummaryPayload;
  }
  | { type: "workflow.schema"; id: string; payload: WorkflowSchemaPayload }
  | { type: "workflow.search"; id: string; payload?: WorkflowSearchPayload }
  | { type: "workflow.approve"; id: string; payload: WorkflowApprovePayload }
  | { type: "workflow.reject"; id: string; payload: WorkflowRejectPayload }
  | { type: "workflow.cancel"; id: string; payload: WorkflowCancelPayload }
  | { type: "workflow.approvals"; id: string }
  | {
    type: "workflow.trigger.get";
    id: string;
    payload: WorkflowTriggerGetPayload;
  }
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
  | { type: "extension.list"; id: string }
  | { type: "extension.search"; id: string; payload?: ExtensionSearchPayload }
  | { type: "extension.info"; id: string; payload: ExtensionInfoPayload }
  | { type: "extension.install"; id: string }
  | { type: "extension.rm"; id: string; payload: ExtensionRmPayload }
  | { type: "extension.outdated"; id: string }
  | { type: "doctor.vaults"; id: string }
  | { type: "doctor.secrets"; id: string }
  | { type: "doctor.workflows"; id: string }
  | { type: "doctor.extensions"; id: string }
  | { type: "run.history"; id: string; payload?: RunHistoryPayload }
  | { type: "worker.list"; id: string; payload?: WorkerListPayload }
  | { type: "worker.queue.list"; id: string }
  | { type: "worker.lease.list"; id: string; payload?: WorkerLeaseListPayload }
  | { type: "datastore.status"; id: string }
  | { type: "cluster.instances"; id: string }
  | { type: "serve.config"; id: string }
  | { type: "server.version"; id: string }
  | { type: "cancel"; id: string };

export interface SerializedEvent {
  kind: string;
  [key: string]: unknown;
}

export interface SerializedError {
  code: string;
  message: string;
  details?: unknown;
}

export interface DataResponse {
  data: Record<string, unknown>;
}

// these responses are not wrapped in { data }; their shapes mirror the
// same-named types in src/serve/protocol.ts

export interface AccessGrantListResponse {
  grants: Record<string, unknown>[];
  subjectDisplayNames?: Record<string, string>;
}

export interface AccessGroupListResponse {
  groups: Record<string, unknown>[];
}

/**
 * the run-time decision for a concrete `vault:<name>`: whether a serve run
 * triggered by the principal may read or write the vault, and whether its runs
 * are vault-scoped
 */
export interface RunVaultAccessReport {
  vault: string;
  action: "read" | "write";
  allowed: boolean;
  /** The principal's runs read only vaults a vault allow names. */
  restricted: boolean;
  rule: string;
  reason: string;
  grantId?: string;
  /** Set for a trigger principal, whose scope covers all its runs. */
  triggerScope?: string;
}

export interface AccessCheckResponse {
  subject: string;
  action: string;
  resource: string;
  collectives: string[];
  groups: string[];
  decisions: Record<string, unknown>[];
  /**
   * the server's approval policy; absent from older servers, as are the signal
   * and tag policies below
   */
  approveRequiresExplicitGrant?: boolean;
  signalRequiresExplicitGrant?: boolean;
  tagRequiresExplicitGrant?: boolean;
  runVaultAccess?: RunVaultAccessReport;
}

export interface AccessCanIDecision {
  action: string;
  resource: string;
  effect: string;
  grantId: string;
  via: string;
  condition?: string;
  /**
   * Set when the grant covers the action only through another it grants:
   * `approve` or `signal` through `run`, `tag` through `write`.
   */
  impliedBy?: "run" | "write";
}

export interface AccessCanIResponse {
  principal: string;
  method?: string;
  decisions: AccessCanIDecision[];
  approveRequiresExplicitGrant?: boolean;
  signalRequiresExplicitGrant?: boolean;
  tagRequiresExplicitGrant?: boolean;
  runVaultAccess?: RunVaultAccessReport;
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

export interface WorkflowTriggerGetResponse {
  data: WorkflowTriggerGetResult;
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
    initiatedBy?: string | null;
  }>;
}

export interface ClusterInstancesResponse {
  instances: Record<string, unknown>[];
}

export interface ServeConfigResponse {
  config: Record<string, unknown>;
}

export type ServerMessage =
  | { type: "event"; id: string; event: SerializedEvent }
  | { type: "error"; id: string; error: SerializedError }
  | { type: "done"; id: string }
  | { type: "data.get"; id: string; payload: DataResponse }
  | { type: "data.query"; id: string; payload: DataResponse }
  | { type: "data.list"; id: string; payload: DataResponse }
  | { type: "data.search"; id: string; payload: DataResponse }
  | { type: "data.versions"; id: string; payload: DataResponse }
  | { type: "data.delete"; id: string; payload: DataResponse }
  | { type: "data.rename"; id: string; payload: DataResponse }
  | { type: "model.get"; id: string; payload: DataResponse }
  | { type: "model.create"; id: string; payload: DataResponse }
  | { type: "model.delete"; id: string; payload: DataResponse }
  | { type: "model.search"; id: string; payload: DataResponse }
  | { type: "model.method.describe"; id: string; payload: DataResponse }
  | { type: "model.output.get"; id: string; payload: DataResponse }
  | { type: "model.output.data"; id: string; payload: DataResponse }
  | { type: "model.output.logs"; id: string; payload: DataResponse }
  | { type: "model.output.search"; id: string; payload: DataResponse }
  | {
    type: "model.usage.summary";
    id: string;
    payload: ModelUsageSummaryResponse;
  }
  | { type: "model.method.history.get"; id: string; payload: DataResponse }
  | { type: "model.method.history.logs"; id: string; payload: DataResponse }
  | { type: "model.method.history.search"; id: string; payload: DataResponse }
  | { type: "model.validate"; id: string; payload: DataResponse }
  | { type: "model.evaluate"; id: string; payload: DataResponse }
  | { type: "workflow.get"; id: string; payload: DataResponse }
  | { type: "workflow.history.get"; id: string; payload: DataResponse }
  | { type: "workflow.history.logs"; id: string; payload: DataResponse }
  | { type: "workflow.history.search"; id: string; payload: DataResponse }
  | { type: "workflow.run.search"; id: string; payload: DataResponse }
  | {
    type: "workflow.run.summary";
    id: string;
    payload: WorkflowRunSummaryResponse;
  }
  | { type: "workflow.schema"; id: string; payload: DataResponse }
  | { type: "workflow.search"; id: string; payload: DataResponse }
  | { type: "workflow.approve"; id: string; payload: DataResponse }
  | { type: "workflow.reject"; id: string; payload: DataResponse }
  | { type: "workflow.cancel"; id: string; payload: DataResponse }
  | { type: "workflow.approvals"; id: string; payload: DataResponse }
  | {
    type: "workflow.trigger.get";
    id: string;
    payload: WorkflowTriggerGetResponse;
  }
  | { type: "vault.get"; id: string; payload: DataResponse }
  | { type: "vault.put"; id: string; payload: DataResponse }
  | { type: "vault.delete"; id: string; payload: DataResponse }
  | { type: "vault.describe"; id: string; payload: DataResponse }
  | { type: "vault.inspect"; id: string; payload: DataResponse }
  | { type: "vault.list-keys"; id: string; payload: DataResponse }
  | { type: "vault.search"; id: string; payload: DataResponse }
  | { type: "vault.annotate"; id: string; payload: DataResponse }
  | { type: "audit.timeline"; id: string; payload: DataResponse }
  | { type: "summarise"; id: string; payload: DataResponse }
  | { type: "report.get"; id: string; payload: DataResponse }
  | { type: "report.search"; id: string; payload: DataResponse }
  | { type: "report.describe"; id: string; payload: DataResponse }
  | { type: "report.type.search"; id: string; payload: DataResponse }
  | { type: "extension.list"; id: string; payload: DataResponse }
  | { type: "extension.search"; id: string; payload: DataResponse }
  | { type: "extension.info"; id: string; payload: DataResponse }
  | { type: "extension.install"; id: string; payload: DataResponse }
  | { type: "extension.rm"; id: string; payload: DataResponse }
  | { type: "extension.outdated"; id: string; payload: DataResponse }
  | { type: "doctor.vaults"; id: string; payload: DataResponse }
  | { type: "doctor.secrets"; id: string; payload: DataResponse }
  | { type: "doctor.workflows"; id: string; payload: DataResponse }
  | { type: "doctor.extensions"; id: string; payload: DataResponse }
  | { type: "run.history"; id: string; payload: RunHistoryResponse }
  | { type: "worker.list"; id: string; payload: DataResponse }
  | { type: "worker.queue.list"; id: string; payload: DataResponse }
  | { type: "worker.lease.list"; id: string; payload: DataResponse }
  | { type: "datastore.status"; id: string; payload: DataResponse }
  | { type: "cluster.instances"; id: string; payload: ClusterInstancesResponse }
  | { type: "serve.config"; id: string; payload: ServeConfigResponse }
  | {
    type: "server.version";
    id: string;
    payload: {
      version: string;
      gitSha: string;
      /** Optional request features this server honours; absent on older servers. */
      capabilities?: string[];
    };
  }
  | { type: "access.grant.list"; id: string; payload: AccessGrantListResponse }
  | { type: "access.group.list"; id: string; payload: AccessGroupListResponse }
  | { type: "access.check"; id: string; payload: AccessCheckResponse }
  | { type: "access.can-i"; id: string; payload: AccessCanIResponse }
  | { type: "access.reload"; id: string; payload: AccessReloadResponse };

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
