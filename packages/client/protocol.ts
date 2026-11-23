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
 * These types mirror src/serve/protocol.ts in the swamp CLI. They are
 * duplicated here so the client package has zero dependencies on the CLI
 * source tree and can be published independently to JSR.
 */

// ── Inbound (client → server) ────────────────────────────────────────────

export interface WorkflowRunPayload {
  /** kinds newer than old clients, sent only when listed */
  eventKinds?: string[];
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
   * a retry with the same key gets the first start's run, not a new run; send
   * only to a server advertising the http-actions capability, since an older
   * one drops it
   */
  idempotencyKey?: string;
  /**
   * The client's inherited held-lock list (`SWAMP_LOCK_HOLDER_TOKENS`), so a
   * run requested by a step of this server's own run skips that step's lock.
   */
  lockHolderTokens?: string;
}

/** `server.version` capability: the server honours `literalInputs`. */
export const SERVE_CAPABILITY_LITERAL_INPUTS = "literal-inputs";

/** `server.version` capability: the server honours `fromJob` on a resume. */
export const SERVE_CAPABILITY_RESUME_FROM_JOB = "resume-from-job";

/** `server.version` capability: the server honours `dataInputKeys`. */
export const SERVE_CAPABILITY_DATA_INPUTS = "data-inputs";

/**
 * `server.version` capability: the server treats a method argument marked
 * `.meta({ data: true })` as data.
 */
export const SERVE_CAPABILITY_DATA_ARGUMENTS = "data-arguments";

export interface ModelMethodRunPayload {
  modelIdOrName: string;
  methodName: string;
  inputs?: Record<string, unknown>;
  /**
   * Treat `inputs` as data: expression text in them is never evaluated
   * (swamp-club#3205). Only send to a server whose `server.version` reply
   * lists {@link SERVE_CAPABILITY_LITERAL_INPUTS}; an older server ignores
   * the field and evaluates.
   */
  literalInputs?: boolean;
  /**
   * Dotted input keys that are data, as `--input-data` writes them. Only send
   * to a server whose `server.version` reply lists
   * {@link SERVE_CAPABILITY_DATA_INPUTS}; an older server ignores them.
   */
  dataInputKeys?: string[];
  lastEvaluated?: boolean;
  runtimeTags?: Record<string, string>;
  typeArg?: string;
  definitionName?: string;
  /** Refuses the run unless the behavior it acts on is of this type. */
  expectedType?: string;
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
  /** Counts outputs started before this instant or duration ago (exclusive). */
  until?: string;
  /** Outputs kept per model in `recent`; clamped to 0..100, default 20. */
  recentLimit?: number;
}

export interface ModelOutputSearchPayload {
  query?: string;
  /** Only outputs of this model, by exact name or id. */
  model?: string;
  /**
   * Only outputs started at or after this ISO 8601 instant, or this long
   * ago by serve's clock for a duration like `7d`.
   */
  since?: string;
  /**
   * Only outputs started before this ISO 8601 instant or duration ago
   * (exclusive).
   */
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

// ── Workflow operations ──────────────────────────────────────────────────

export interface WorkflowGetPayload {
  workflowIdOrName: string;
}

export interface WorkflowSearchPayload {
  query?: string;
  /** Page size; omitted returns every authorized workflow. */
  limit?: number;
  /** Number of authorized workflows to skip before the page. */
  offset?: number;
}

export interface WorkflowHistoryGetPayload {
  workflowIdOrName: string;
  /**
   * reads every resource past the run's attribute budget, for a caller that
   * keeps only merged step outputs; the reply carries no artifact attributes
   */
  allAttributes?: boolean;
  /** names a run by its full id: no scan, no workflow fallback, no outputs */
  exactRun?: boolean;
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
  /** Runs started before (exclusive): a duration back or ISO time. */
  until?: string;
  status?: string;
  /** One workflow's runs, by name ignoring case. */
  workflow?: string;
  /** Runs of any of these workflows, by exact name; empty filters nothing. */
  workflows?: string[];
  /** Runs with this trigger source (`schedule`, `api`…), ignoring case. */
  triggerSource?: string;
  /** Runs with any of these statuses; with `status`, both must hold. */
  statuses?: string[];
  /** Runs with any of these trigger sources; with `triggerSource`, both hold. */
  triggerSources?: string[];
  tags?: Record<string, string>;
  inputs?: Record<string, string>;
  /** Page size; the server applies a default of 500 when omitted. */
  limit?: number;
  /** Number of authorized runs to skip before the page. */
  offset?: number;
}

/** One output in a model's `recent` list. */
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

/** Usage of one definition id under one type over the window. */
export interface ModelUsageSummaryModel {
  definitionId: string;
  modelName: string;
  type: string;
  executions: number;
  failed: number;
  lastStartedAt: string;
  /** Distinct methods run, most recent first. */
  methods: string[];
  /** The newest outputs, newest first, at most `recentLimit`. */
  recent: ModelUsageSummaryRecentOutput[];
}

export interface ModelUsageSummaryData {
  /** The window as resolved, when bounded. */
  since?: string;
  until?: string;
  /** Every readable output, including those of definitions no longer named. */
  totals: { executions: number; failed: number };
  /** Newest use first. */
  models: ModelUsageSummaryModel[];
}

export interface ModelUsageSummaryResponse {
  data: ModelUsageSummaryData;
}

/**
 * Asks for run counts across workflows. Counts only runs the caller may
 * read. Every field is optional.
 */
export interface WorkflowRunSummaryPayload {
  /** Runs started at or after this ISO time (a duration back also works). */
  since?: string;
  /** Runs started before this ISO time (exclusive). */
  until?: string;
  /** Only runs of these workflows, by exact name. */
  workflows?: string[];
  /** Only runs with this trigger source, ignoring case. */
  triggerSource?: string;
  /** Only runs with any of these trigger sources, ignoring case. */
  triggerSources?: string[];
  /** Runs kept per workflow in `recent`; clamped to 0..100, default 20. */
  recentLimit?: number;
  /** Include hourly buckets. */
  timeline?: boolean;
}

/** One run in a workflow's `recent` list. */
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
  /** Total duration of the finished runs. */
  durationMs: number;
  lastStartedAt?: string;
  /** The newest runs, newest first. */
  recent: WorkflowRunSummaryRecentRun[];
}

/** The runs started within one UTC hour. */
export interface WorkflowRunSummaryBucket {
  /** Top of the UTC hour, as an ISO timestamp. */
  start: string;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/** Run counts across the workflows the caller may read. */
export interface WorkflowRunSummaryData {
  since?: string;
  until?: string;
  totals: {
    /** Workflows with at least one counted run. */
    workflows: number;
    runs: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    running: number;
    suspended: number;
    /** Total duration of the finished runs. */
    durationMs: number;
  };
  /** One entry per workflow with a counted run, ordered by name. */
  workflows: WorkflowRunSummaryWorkflow[];
  /** Start of the oldest counted run; absent when none has a start. */
  oldestStartedAt?: string;
  /** Hours with runs, ascending; only when asked for. */
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
  jobName?: string;
  strictGate?: boolean;
  /** send only to a server advertising the gate-attempt capability */
  suspendedAt?: string;
  reason?: string;
  runId?: string;
  decidedBy?: string;
}

export interface WorkflowRejectPayload {
  workflowIdOrName: string;
  stepName: string;
  jobName?: string;
  strictGate?: boolean;
  /** send only to a server advertising the gate-attempt capability */
  suspendedAt?: string;
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
  /** kinds newer than old clients, sent only when listed */
  eventKinds?: string[];
  workflowIdOrName: string;
  runId?: string;
  from?: string;
  /**
   * The job of the `from` step, when its name is used in more than one job
   * (swamp-club#3815). Only send to a server whose `server.version` reply
   * lists {@link SERVE_CAPABILITY_RESUME_FROM_JOB}; an older server ignores
   * the field and resets the `from` step in every job that has it.
   */
  fromJob?: string;
  /** resumes only a suspended run, so a retry can't re-run a failed run */
  suspendedOnly?: boolean;
  inputs?: Record<string, unknown>;
  traceparent?: string;
  tracestate?: string;
  /** As on {@link WorkflowRunPayload}. */
  lockHolderTokens?: string;
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

// ── Server admin ─────────────────────────────────────────────────────────

export interface WorkerListPayload {
  showAll?: boolean;
  /** Also return workers that disconnected within this many ms (max 24h). */
  disconnectedWithinMs?: number;
}

export interface WorkerLeaseListPayload {
  /** Dispatch ids whose step leases to return. */
  dispatchIds?: string[];
  /** Also return leases written within this many ms (max 5 minutes). */
  endedWithinMs?: number;
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

// ── Doctor operations ────────────────────────────────────────────────────

// Doctor operations have no payload fields.

// ── Run tracking ────────────────────────────────────────────────────────

export interface RunHistoryPayload {
  active?: boolean;
  all?: boolean;
}

/** Follows a run already in progress, from its event after `afterSeq`. */
export interface RunAttachPayload {
  /** kinds newer than old clients, sent only when listed */
  eventKinds?: string[];
  runId: string;
  afterSeq?: number;
}

/** What a data change did to its item. */
export type DataChangeKind = "saved" | "deleted" | "renamed";

/** One data item that changed, as `data.subscribe` reports it. */
export interface DataChange {
  /** The commit's position; subscribe again from it to resume after it. */
  cursor: number;
  /** When the write was committed, on serve's clock (ISO). */
  at: string;
  behavior: string;
  type: string;
  name: string;
  /** The version saved or removed; absent when a whole name went. */
  version?: number;
  change: DataChangeKind;
  to?: string;
}

/** Serve answers `data_feed_unavailable` when its datastore has no change feed. */
export interface DataSubscribePayload {
  /** Resume after this cursor; from now when absent. */
  cursor?: number;
  /** Behavior names to hear about; any when absent. */
  behaviors?: string[];
  /** Behavior types to hear about; any when absent. */
  types?: string[];
}

/** A page of changes, or an empty one as a heartbeat every few seconds. */
export interface DataSubscribeFrame {
  changes: DataChange[];
  /** The last position read; subscribe again from it after a disconnect. */
  cursor: number;
  head: number;
  done: false;
}

// ── Workflow trigger operations ─────────────────────────────────────────

export interface WorkflowTriggerGetPayload {
  workflowName: string;
}

export interface TriggerCatchUp {
  readonly policy: "none" | "latest";
  readonly maxDelay?: string;
}

export interface EffectiveTrigger {
  readonly schedule: string | null;
  readonly inputs: Record<string, unknown>;
  readonly catchUp: TriggerCatchUp | null;
}

export interface WorkflowTriggerGetResult {
  readonly workflowName: string;
  readonly builtIn: EffectiveTrigger | null;
  readonly override: {
    readonly schedule?: string;
    readonly inputs?: Record<string, unknown>;
    readonly catchUp?: TriggerCatchUp;
  } | null;
  readonly effective: EffectiveTrigger;
}

// ── Server admin ─────────────────────────────────────────────────────────

// Worker list, datastore status, cluster instances, and serve config
// have no payload fields.

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
  // Run tracking
  | { type: "run.history"; id: string; payload?: RunHistoryPayload }
  | { type: "run.attach"; id: string; payload: RunAttachPayload }
  | { type: "data.subscribe"; id: string; payload: DataSubscribePayload }
  // Server admin
  | { type: "worker.list"; id: string; payload?: WorkerListPayload }
  | { type: "worker.queue.list"; id: string }
  | { type: "worker.lease.list"; id: string; payload?: WorkerLeaseListPayload }
  | { type: "datastore.status"; id: string }
  | { type: "cluster.instances"; id: string }
  | { type: "serve.config"; id: string }
  | { type: "server.version"; id: string; payload?: { leader?: boolean } }
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
  /** set on draining and not_ready refusals by serves that name a wait */
  retryAfterSeconds?: number;
}

/** Generic response payload for request-response operations. */
export interface DataResponse {
  data: Record<string, unknown>;
}

// ── Flat response payloads (not DataResponse-shaped) ─────────────────────
//
// These operations return a payload that is NOT wrapped in { data: ... };
// the shapes mirror the same-named types in src/serve/protocol.ts.

export interface AccessGrantListResponse {
  grants: Record<string, unknown>[];
  subjectDisplayNames?: Record<string, string>;
}

export interface AccessGroupListResponse {
  groups: Record<string, unknown>[];
}

/**
 * The run-time decision for a concrete `vault:<name>` (swamp-club#2676):
 * whether a serve run triggered by the principal may read or write the
 * vault, and whether its runs are vault-scoped.
 */
export interface RunVaultAccessReport {
  vault: string;
  action: "read" | "write";
  allowed: boolean;
  /** The principal's runs read only vaults a vault allow names. */
  restricted: boolean;
  /** The rule that decided, e.g. `vault-scoped` or `no-vault-grants`. */
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
  /** The method checked; absent when none was, or from a server that predates it. */
  method?: string;
  /** The server's approval policy; absent from servers that predate it. */
  approveRequiresExplicitGrant?: boolean;
  /** The server's signal policy; absent from servers that predate it. */
  signalRequiresExplicitGrant?: boolean;
  /** The server's tag policy; absent from servers that predate it. */
  tagRequiresExplicitGrant?: boolean;
  /** For a concrete vault and read or write; absent otherwise. */
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
  /** The server's approval policy; absent from servers that predate it. */
  approveRequiresExplicitGrant?: boolean;
  /** The server's signal policy; absent from servers that predate it. */
  signalRequiresExplicitGrant?: boolean;
  /** The server's tag policy; absent from servers that predate it. */
  tagRequiresExplicitGrant?: boolean;
  /** For a concrete vault and read or write; absent otherwise. */
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
    interruptReason?: string | null;
    autoContinuedFrom?: string | null;
  }>;
}

export interface ClusterInstancesResponse {
  instances: Record<string, unknown>[];
}

export interface ServeConfigResponse {
  config: Record<string, unknown>;
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
  // Workflow responses
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
  // Run tracking responses
  | { type: "run.history"; id: string; payload: RunHistoryResponse }
  | { type: "run.attached"; id: string; payload: RunAttachedReply }
  | { type: "data.subscribe"; id: string; payload: DataSubscribeFrame }
  | { type: "run.elsewhere"; id: string; payload: RunElsewhereReply }
  | { type: "run.interrupted"; id: string; payload: RunInterruptedReply }
  // Server admin responses
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
  // Access responses (internal — not in client package's primary API)
  | { type: "access.grant.list"; id: string; payload: AccessGrantListResponse }
  | { type: "access.group.list"; id: string; payload: AccessGroupListResponse }
  | { type: "access.check"; id: string; payload: AccessCheckResponse }
  | { type: "access.can-i"; id: string; payload: AccessCanIResponse }
  | { type: "access.reload"; id: string; payload: AccessReloadResponse };

// ── Event types (wire-format discriminated unions) ────────────────────────

/** Events emitted during a workflow run. */
export type WorkflowRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "evaluating_workflow" }
  | {
    kind: "superseded_runs";
    cancelledRunIds: string[];
    detachedNestedRuns?: DetachedNestedRunData[];
    cancelledNestedRuns?: CascadedNestedRunData[];
    stopRequestedNestedRuns?: CascadedNestedRunData[];
    skippedRuns?: SkippedSupersedeData[];
  }
  | {
    kind: "started";
    runId: string;
    /** set on a nested run's started event; track a run by the one without it */
    parentRunId?: string;
    workflowName: string;
    jobs?: WorkflowRunJobInfo[];
    /** an idempotent retry answered with the first start's run */
    replayed?: boolean;
  }
  | { kind: "job_started"; jobId: string }
  | { kind: "job_completed"; jobId: string; status: string }
  | { kind: "job_skipped"; jobId: string }
  | { kind: "step_started"; jobId: string; stepId: string }
  | { kind: "step_completed"; jobId: string; stepId: string }
  | { kind: "step_skipped"; jobId: string; stepId: string }
  | {
    kind: "approval_requested";
    runId: string;
    workflowName?: string;
    jobId: string;
    stepId: string;
    prompt: string;
    timeout?: number;
    fanOutGate?: FanOutGatePrompt;
  }
  | { kind: "step_queued"; jobId: string; stepId: string; requirement: string }
  | {
    kind: "step_target_disconnected";
    jobId: string;
    stepId: string;
    target: string;
  }
  | {
    kind: "assert_result";
    jobId: string;
    stepId: string;
    passed: boolean;
    message: string;
    severity: "low" | "medium" | "high";
    expr: string;
    error?: string;
  }
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
  | ({ kind: "suspended"; run: WorkflowRunView } & SuspendedGate)
  | { kind: "error"; error: SerializedError };

/** A fan-out job's approval gate, built from the run's frozen plan. */
export interface FanOutGatePrompt {
  gate: "plan" | "canary";
  job: string;
  selector: { labels?: Record<string, string>; platform?: string };
  members: {
    worker: string;
    disposition: string;
    reason?: string;
    batch?: number;
  }[];
  batches: string[][];
  /** used is set at the canary gate */
  budget: { allowed: number | null; used?: number };
  canary?: {
    lanes: {
      worker: string;
      status: "succeeded" | "failed" | "not_run";
      failedSteps: { step: string; error?: string }[];
      assertions: { step: string; severity: string; message: string }[];
    }[];
  };
  /** at the canary gate: the lanes the next batch starts */
  next?: string[];
}

/** Where a suspended run waits: a gate, a signal wait, or a nested run. */
export interface SuspendedGate {
  jobId: string;
  stepId: string;
  prompt: string;
  timeout?: number;
  fanOutGate?: FanOutGatePrompt;
  /** the run waits on a suspended child run; jobId and stepId are the nested step */
  nested?: { workflowName: string; runId: string };
  /** the run waits for a signal at jobId and stepId */
  wait?: { id: string; deadline: string; key?: string };
  /** open signal waits held by nested runs, each at the run that has to act */
  nestedSignalWaits?: NestedSignalWaitData[];
}

export interface NestedSignalWaitData {
  workflowId: string;
  workflowName: string;
  runId: string;
  jobId: string;
  stepId: string;
  waitId: string;
  deadline: string;
  key?: string;
}

export interface WorkflowRunJobInfo {
  id: string;
  stepCount: number;
  dependsOn: string[];
}

export interface DetachedNestedRunData {
  workflowId: string;
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
  cancelCommand: string;
}

export interface CascadedNestedRunData {
  workflowId: string;
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
}

export interface SkippedSupersedeData {
  runId: string;
  waitIds: string[];
}

/**
 * How a workflow run or resume settled. The run's fields sit beside `outcome`,
 * so code reading `status` or `jobs` keeps working; narrow on `outcome` first.
 */
export type WorkflowRunResult =
  | (WorkflowRunView & { outcome: "completed" })
  | (WorkflowRunView & { outcome: "cancelled"; reason?: string })
  | (WorkflowRunView & { outcome: "suspended"; gate: SuspendedGate })
  /** an idempotent retry: serve answered with the first start's run id only */
  | { outcome: "replayed"; runId: string };

/** Events emitted during a model method run. */
export type ModelMethodRunEvent =
  | { kind: "validating_inputs" }
  | { kind: "resolving_model"; modelIdOrName: string }
  | {
    kind: "auto_created";
    modelType: string;
    definitionName: string;
    definitionPath: string;
  }
  | { kind: "global_args_updated"; definitionName: string }
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
    tags?: Record<string, string>;
  }>;
}

// replies to app requests mirror libswamp's shapes; lists are already filtered to what the caller may read

export interface ServerVersionPayload {
  leader?: boolean;
}

export interface ServerVersionReply {
  version: string;
  gitSha: string;
  /** Optional request features this server honours; absent on older servers. */
  capabilities?: string[];
}

/** Retention has removed records older than `cutoff`, so a listing omits them. */
export interface ReapedBefore {
  cutoff: string;
  retention: string;
}

// data.get

export interface DataGetAlternative {
  modelName: string;
  modelType: string;
  modelId: string;
  jobName?: string;
  stepName?: string;
  version: number;
  replacementQuery?: string;
}

export interface DataGetData {
  id: string;
  name: string;
  modelId: string;
  modelName: string;
  modelType: string;
  version: number;
  contentType: string;
  lifetime: string;
  garbageCollection: string | number;
  streaming: boolean;
  tags: Record<string, string>;
  ownerDefinition: {
    definitionHash?: string;
    ownerType: string;
    ownerRef: string;
    workflowId?: string;
    workflowRunId?: string;
    workflowName?: string;
    jobName?: string;
    stepName?: string;
    source?: string;
  };
  createdAt: string;
  size?: number;
  checksum?: string;
  contentPath: string;
  /** Present unless the request set `includeContent: false`. */
  content?: string;
  contentEncoding?: "utf-8" | "base64";
  replacementQuery?: string;
  /** For a workflow-scoped read without `runId`: follows the latest run. */
  latestRunQuery?: string;
  warnings?: string[];
  /** For a workflow-scoped read: other readable producers of the same name. */
  alternatives?: DataGetAlternative[];
}

export interface DataGetReply {
  data: DataGetData;
}

// data.query

/** One stored data version as a query matches it. */
export interface DataRecord {
  id: string;
  name: string;
  version: number;
  isLatest: boolean;
  createdAt: string;
  /** The repo that produced it within a shared datastore; empty when solo. */
  namespace: string;
  attributes: Record<string, unknown>;
  tags: Record<string, string>;
  modelName: string;
  modelId: string;
  modelType: string;
  specName: string;
  dataType: string;
  contentType: string;
  lifetime: string;
  /** A count or a duration; empty when unknown. */
  garbageCollection: number | string;
  /** Empty when unknown. */
  lifecycle: "active" | "deleted" | "";
  ownerType: string;
  streaming: boolean;
  size: number;
  content: unknown;
  path: string;
  /** Provenance; empty when not produced inside a workflow. */
  ownerRef: string;
  workflowRunId: string;
  workflowName: string;
  jobName: string;
  stepName: string;
  source: string;
}

/** What a `select` produced, one entry or row per match. */
export type ProjectedData =
  | { shape: "scalar"; values: unknown[] }
  | { shape: "map"; columns: string[]; rows: Record<string, unknown>[] }
  | { shape: "list"; rows: unknown[][] };

export interface SpecNameHint {
  suggestedPredicate: string;
  otherFiltersDropped: boolean;
}

export interface DataQueryData {
  predicate: string;
  select?: string;
  /** Empty when the query had a `select`: read `projected` instead. */
  results: DataRecord[];
  projected?: ProjectedData;
  total: number;
  limited: boolean;
  specNameHint?: SpecNameHint;
  /** With a sort, set when the page filled its limit; pass back as `cursor`. */
  nextCursor?: string;
}

export interface DataQueryReply {
  data: DataQueryData;
}

// data.search

export interface DataSearchItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string;
  lifetime: string;
  /** Empty when unknown. */
  lifecycle: "active" | "deleted" | "";
  ownerType: string;
  ownerRef: string;
  modelId: string;
  modelName: string;
  modelType: string;
  streaming: boolean;
  size: number;
  createdAt: string;
  tags: Record<string, string>;
  workflowTag?: string;
  jobTag?: string;
  stepTag?: string;
}

export interface DataSearchData {
  query: string;
  filters: Record<string, string>;
  results: DataSearchItem[];
  total: number;
  limited: boolean;
}

export interface DataSearchReply {
  data: DataSearchData;
}

// data.versions

export interface DataVersionInfo {
  version: number;
  createdAt: string;
  size?: number;
  checksum?: string;
  isLatest: boolean;
}

export interface DataVersionsData {
  dataName: string;
  modelId: string;
  modelName: string;
  modelType: string;
  versions: DataVersionInfo[];
  total: number;
}

export interface DataVersionsReply {
  data: DataVersionsData;
}

// model.get / model.search

export type StalenessState =
  | "current"
  | "upgradable"
  | "stranded"
  | "unknown"
  | "invalid";

export type MethodKind =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "list"
  | "action";

export interface MethodDescribeData {
  name: string;
  description: string;
  /** JSON Schema of the method's arguments. */
  arguments: object;
  kind?: MethodKind;
  kindSource: "declared" | "inferred" | "none";
  outputLifetime?: string;
}

export interface ModelGetData {
  id: string;
  name: string;
  description?: string;
  type: string;
  version: number;
  tags: Record<string, string>;
  /** Sensitive values are redacted. */
  globalArguments: Record<string, unknown>;
  autoCreated?: boolean;
  typeVersion?: string;
  currentTypeVersion?: string;
  staleness?: StalenessState;
  /** JSON Schema of the global arguments. */
  globalArgumentsSchema?: object;
  methods?: MethodDescribeData[];
  configuredMethods?: Record<string, { arguments: Record<string, unknown> }>;
}

export interface ModelGetReply {
  data: ModelGetData;
}

export interface ModelSearchItem {
  id: string;
  name: string;
  type: string;
}

export interface ModelSearchData {
  query: string;
  results: ModelSearchItem[];
}

export interface ModelSearchReply {
  data: ModelSearchData;
}

// model.output.search / model.usage.summary

export interface ModelOutputSearchItem {
  id: string;
  definitionId: string;
  modelName?: string;
  type: string;
  methodName: string;
  status: string;
  startedAt: string;
  durationMs?: number;
  triggeredBy?: "manual" | "workflow" | "model";
  workflowId?: string;
  workflowName?: string;
  workflowRunId?: string;
  stepName?: string;
}

export interface ModelOutputSearchData {
  query: string;
  results: ModelOutputSearchItem[];
}

export interface ModelOutputSearchReply {
  data: ModelOutputSearchData;
}

export type ModelUsageSummaryReply = ModelUsageSummaryResponse;

// workflow.get / workflow.search

export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  [key: string]: unknown;
}

export interface InputsSchema {
  type?: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  [key: string]: unknown;
}

export type TriggerConditionData =
  | { type: "always" }
  | { type: "succeeded" }
  | { type: "failed" }
  | { type: "completed" }
  | { type: "skipped" }
  | { type: "and"; conditions: TriggerConditionData[] }
  | { type: "or"; conditions: TriggerConditionData[] }
  | { type: "not"; condition: TriggerConditionData };

export interface ReportSelection {
  require?: (string | { name: string; methods?: string[] })[];
  skip?: string[];
}

export interface WorkflowGetData {
  id: string;
  name: string;
  description?: string;
  version: number;
  inputs?: InputsSchema;
  trigger?: { schedule?: string; inputs?: Record<string, unknown> };
  tags: Record<string, string>;
  reports?: ReportSelection;
  jobs: {
    name: string;
    description?: string;
    dependsOn: { job: string; condition: TriggerConditionData }[];
    steps: {
      name: string;
      description?: string;
      dependsOn: { step: string; condition: TriggerConditionData }[];
      task: { type: string; [key: string]: unknown };
    }[];
  }[];
  path: string;
}

export interface WorkflowGetReply {
  data: WorkflowGetData;
}

export interface WorkflowSearchItem {
  id: string;
  name: string;
  description?: string;
  jobCount: number;
  stepCount: number;
  hasInputs: boolean;
  trigger?: { schedule?: string; inputs?: Record<string, unknown> };
}

export interface WorkflowSearchData {
  query: string;
  /** The requested page. */
  results: WorkflowSearchItem[];
}

export interface WorkflowSearchReply {
  data: WorkflowSearchData;
  /** Readable workflows matched, across every page. */
  total: number;
}

// workflow.run.search / workflow.history.search / workflow.run.summary

export interface WorkflowRunSearchItem {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  tags?: Record<string, string>;
  inputs?: Record<string, unknown>;
  /** Inputs too large to list: only the run's record holds their values. */
  inputsOmitted?: string[];
  instanceId?: string;
  triggerSource?: string;
  failedStep?: string;
  failureReason?: string;
  stepProgress?: { completed: number; total: number };
  /** Suspended with every gate decided and every nested run finished. */
  awaitingResume?: boolean;
  workflowHasInputs?: boolean;
  /** Absent when the caller may not read the parent's workflow. */
  parentRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
  };
  nestedWaits?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    status?: string;
  }[];
}

export interface WorkflowRunSearchData {
  query: string;
  /** The requested page, newest first. */
  results: WorkflowRunSearchItem[];
  reapedBefore?: ReapedBefore;
}

export interface WorkflowRunSearchReply {
  data: WorkflowRunSearchData;
  /** Readable runs matched, across every page. */
  total: number;
  since?: string;
  /** With `since`: the start of the oldest match; absent when none matched. */
  oldestStartedAt?: string;
}

export interface HistorySkippedWorkflow {
  workflowId: string;
  workflowName: string;
  runId: string;
  reason: string;
}

export interface WorkflowHistorySearchData {
  query: string;
  results: WorkflowRunSearchItem[];
  reapedBefore?: ReapedBefore;
  /** Workflows left out because a run record could not be read. */
  skippedWorkflows?: HistorySkippedWorkflow[];
}

export interface WorkflowHistorySearchReply {
  data: WorkflowHistorySearchData;
}

export type WorkflowRunSummaryReply = WorkflowRunSummaryResponse;

// workflow.history.get

export interface DataArtifactRefData {
  dataId: string;
  name: string;
  version: number;
  tags: Record<string, string>;
  attributes?: Record<string, unknown>;
  /** Content left out: the run's attribute budget was spent. */
  attributesOmitted?: true;
}

export type StepRunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "waiting"
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown";

export interface SignalWaitView {
  id: string;
  deadline: string;
  key?: string;
  receipt?: {
    id: string;
    waitId: string;
    receivedAt: string;
    submittedBy: string;
    /** The signal arrived before the wait opened and was held for it. */
    heldAsPending?: true;
  };
}

export interface StepRunView {
  name: string;
  status: StepRunStatus;
  error?: string;
  errorCode?: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  outputId?: string;
  artifacts?: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    dataAttributes?: Record<string, unknown>;
  };
  dataArtifacts?: DataArtifactRefData[];
  allowedFailure?: boolean;
  assertResult?: {
    passed: boolean;
    expr: string;
    message: string;
    severity: "low" | "medium" | "high";
    error?: string;
  };
  approval?: {
    status: "approved" | "rejected" | "timed_out";
    approvedBy?: string;
    /** Set when serve knew the decider's username; approvedBy keeps the id. */
    approvedByUsername?: string;
    approvedAt?: string;
    rejectedBy?: string;
    rejectedByUsername?: string;
    rejectedAt?: string;
    timeoutAt?: string;
    reason?: string;
    approvalDuration?: number;
    client?: string;
  };
  outputs?: Record<string, unknown>;
  /** Outputs merge only the resources read within the attribute budget. */
  outputsPartial?: true;
  /** On skipped steps only. */
  skipReason?: {
    kind: "dependency" | "guarded" | "job_skipped";
    expression?: string;
  };
  /** `workflow_changed`: a failed-run resume reset the step; start a new run. */
  failureKind?: "workflow_changed";
  /** On a nested workflow step; absent when the caller may not read it. */
  nestedRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    detached?: true;
  };
  wait?: SignalWaitView;
}

export interface FanOutMemberRunView {
  worker: string;
  disposition: string;
  reason?: string;
  batch?: number;
  lane?: "succeeded" | "failed" | "held" | "running" | "unknown" | "not_run";
  failedSteps?: { step: string; error?: string }[];
  assertions?: { step: string; severity: string; message: string }[];
}

export type FanOutHaltRunView =
  | {
    reason: "budget";
    batch: number;
    maxFailures: number;
    failed: string[];
    held: string[];
  }
  | { reason: "gate_rejected"; gate: "plan" | "canary"; held: string[] };

export interface FanOutGateRunView {
  kind: "plan" | "canary";
  step: string;
  status:
    | "pending"
    | "waiting"
    | "expired"
    | "approved"
    | "rejected"
    | "held"
    | "failed";
  expiredAt?: string;
  approval?: StepRunView["approval"];
}

/** A fan-out job rebuilt from the run record. */
export interface FanOutRunView {
  selector: { labels?: Record<string, string>; platform?: string };
  /** Absent when the run's evaluated workflow is gone. */
  policy?: { offline: string; minWorkers: number };
  plannedLanes: number;
  batches: string[][];
  budget: { allowed: number | null; used: number };
  members: FanOutMemberRunView[];
  halts: FanOutHaltRunView[];
  gates: FanOutGateRunView[];
  /** The latest resume only. */
  resume?: { at: string; rerun: string[]; kept: string[] };
}

export interface JobRunView {
  name: string;
  status: StepRunStatus;
  steps: StepRunView[];
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  /** Set by history get on a job that holds a fan-out plan. */
  fanOut?: FanOutRunView;
}

export interface ReportResultView {
  name: string;
  scope?: string;
  success: boolean;
  markdown?: string;
  json?: Record<string, unknown>;
  error?: string;
}

/** One workflow run as its history records it. */
export interface WorkflowHistoryRunView {
  id: string;
  workflowId: string;
  workflowName: string;
  inputs?: Record<string, unknown>;
  status:
    | "pending"
    | "running"
    | "suspended"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  jobs: JobRunView[];
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  path?: string;
  reports?: ReportResultView[];
  workflowDataArtifacts?: DataArtifactRefData[];
  initiatedBy?: string;
  /** Set when serve knew the initiator's username; initiatedBy keeps the id. */
  initiatedByUsername?: string;
  client?: string;
  references?: Record<string, string>;
  parentRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
  };
  inheritedPlacement?: {
    target?: string;
    labels?: Record<string, string>;
    platform?: string;
    source: { workflowName: string; jobName: string; stepName: string };
  };
  nestedWaits?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
    status?: string;
  }[];
  /** Suspended, no gate of its own waits, and every nested run finished. */
  awaitingResume?: boolean;
  /** Why the run stopped, while it is interrupted. */
  interruptReason?: string;
  /** A planned restart stopped it between steps; serve continues it. */
  parked?: boolean;
  /** Serve's last automatic continuation of the run, or its refusal. */
  autoContinuation?: {
    count: number;
    continuedAt?: string;
    interruptReason?: string;
    resetSteps?: string[];
    refused?: {
      at: string;
      reason: string;
      steps: string[];
      message: string;
    };
  };
}

export interface WorkflowHistoryGetReply {
  data: WorkflowHistoryRunView;
}

// workflow.history.logs

export type WorkflowHistoryLogsData =
  | { type: "log"; log: { lines: string[]; path: string } }
  | { type: "no_log_file"; info: { runId: string; workflowName: string } }
  | {
    type: "empty_log";
    info: { runId: string; workflowName: string; path: string };
  };

export interface WorkflowHistoryLogsReply {
  data: WorkflowHistoryLogsData;
}

// worker.list

export interface WorkerListItem {
  name: string;
  tokenName: string;
  status: "idle" | "busy" | "disconnected" | "unverified" | "draining";
  labels: Record<string, string>;
  platform: string;
  arch: string;
  instanceUuid: string;
  enrolledAt: string;
  lastSeenAt: string;
  capacity: number;
  activeDispatchIds: string[];
  disconnectedAt?: string;
}

export interface WorkerListData {
  workers: WorkerListItem[];
  count: number;
  filteredDisconnectedCount?: number;
}

export interface WorkerListReply {
  data: WorkerListData;
}

// run.attach

export type RunAttachKind = "workflow-run" | "workflow-resume" | "method-run";

/** The run is here: its events follow as `event` frames, then `done` or `error`. */
export interface RunAttachedReply {
  runId: string;
  /** `method-run` streams model method events; the others workflow events. */
  kind: RunAttachKind;
  startedAt: string;
}

/** The run is live on another serve instance; attach there. */
export interface RunElsewhereReply {
  runId: string;
  instanceId: string;
}

/** The instance running it has stopped, so the run will not finish. */
export interface RunInterruptedReply {
  runId: string;
  instanceId: string;
  reason: "instance_dead";
}

/** A `run.attach` reply that ends the request without a stream. */
export type RunAttachFrame =
  | { type: "run.attached"; payload: RunAttachedReply }
  | { type: "run.elsewhere"; payload: RunElsewhereReply }
  | { type: "run.interrupted"; payload: RunInterruptedReply };

/** What serve adds to each run event it streams. */
export interface RunEventStamp {
  /** Its place in the run, for a later `afterSeq`. */
  seq?: number;
  /** When serve emitted it (ISO); absent from older servers. */
  at?: string;
}

/** An event of an attached run, numbered for a later `afterSeq`. */
export type RunAttachEvent =
  & (WorkflowRunEvent | ModelMethodRunEvent)
  & { seq: number; at?: string };

// ── App request map ──────────────────────────────────────────────────────

/** Each request an app may make, with what it sends and what it gets back. */
export interface AppRequestMap {
  "workflow.run.search": {
    payload: WorkflowRunSearchPayload | undefined;
    reply: WorkflowRunSearchReply;
  };
  "workflow.run.summary": {
    payload: WorkflowRunSummaryPayload | undefined;
    reply: WorkflowRunSummaryReply;
  };
  "workflow.history.get": {
    payload: WorkflowHistoryGetPayload;
    reply: WorkflowHistoryGetReply;
  };
  "workflow.history.logs": {
    payload: WorkflowHistoryLogsPayload;
    reply: WorkflowHistoryLogsReply;
  };
  "workflow.history.search": {
    payload: WorkflowHistorySearchPayload | undefined;
    reply: WorkflowHistorySearchReply;
  };
  "model.usage.summary": {
    payload: ModelUsageSummaryPayload | undefined;
    reply: ModelUsageSummaryReply;
  };
  "data.get": { payload: DataGetPayload; reply: DataGetReply };
  "data.query": { payload: DataQueryPayload; reply: DataQueryReply };
  "data.search": {
    payload: DataSearchPayload | undefined;
    reply: DataSearchReply;
  };
  "data.versions": { payload: DataVersionsPayload; reply: DataVersionsReply };
  "model.output.search": {
    payload: ModelOutputSearchPayload | undefined;
    reply: ModelOutputSearchReply;
  };
  "workflow.search": {
    payload: WorkflowSearchPayload | undefined;
    reply: WorkflowSearchReply;
  };
  "workflow.get": { payload: WorkflowGetPayload; reply: WorkflowGetReply };
  "model.search": {
    payload: ModelSearchPayload | undefined;
    reply: ModelSearchReply;
  };
  "model.get": { payload: ModelGetPayload; reply: ModelGetReply };
  "worker.list": {
    payload: WorkerListPayload | undefined;
    reply: WorkerListReply;
  };
  "server.version": {
    payload: ServerVersionPayload | undefined;
    reply: ServerVersionReply;
  };
}

export type AppRequestType = keyof AppRequestMap;
