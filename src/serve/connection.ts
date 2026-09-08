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
 * Per-WebSocket connection handler. Dispatches incoming requests to libswamp
 * operations and streams serialized events back to the client.
 */

import { z } from "zod";
import type { ServerRequest } from "./protocol.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { Principal } from "../domain/access/principal.ts";
import { audited, type AuditedOptions } from "./audited.ts";
import { AuditQueryService } from "../domain/serve_audit/audit_query_service.ts";
import type { AuditSubscriptionFilter } from "./audit_sinks/websocket_sink.ts";
import {
  GIT_SHA as SERVER_GIT_SHA,
  VERSION as SERVER_VERSION,
} from "../cli/commands/version.ts";
import {
  handleDataDelete,
  handleDataGc,
  handleDataGet,
  handleDataList,
  handleDataPrune,
  handleDataQuery,
  handleDataRename,
  handleDataSearch,
  handleDataVersions,
  handleRunGc,
  handleSummarise,
  resolveDataFields,
} from "./handlers/data_handlers.ts";
import {
  handleModelCreate,
  handleModelDelete,
  handleModelEdit,
  handleModelEvaluate,
  handleModelGet,
  handleModelMethodDescribe,
  handleModelMethodHistoryGet,
  handleModelMethodHistoryLogs,
  handleModelMethodHistorySearch,
  handleModelMethodRun,
  handleModelOutputData,
  handleModelOutputGet,
  handleModelOutputLogs,
  handleModelOutputSearch,
  handleModelSearch,
  handleModelTypeDescribe,
  handleModelTypeSearch,
  handleModelValidate,
} from "./handlers/model_handlers.ts";
import {
  handleWorkflowApprovals,
  handleWorkflowApprove,
  handleWorkflowCreate,
  handleWorkflowDelete,
  handleWorkflowEdit,
  handleWorkflowEvaluate,
  handleWorkflowGet,
  handleWorkflowHistoryGet,
  handleWorkflowHistoryLogs,
  handleWorkflowHistorySearch,
  handleWorkflowReject,
  handleWorkflowResume,
  handleWorkflowRun,
  handleWorkflowRunSearch,
  handleWorkflowSchema,
  handleWorkflowSearch,
  handleWorkflowTriggerGet,
  handleWorkflowTriggerRemove,
  handleWorkflowTriggerSet,
  handleWorkflowValidate,
  resolveWorkflowFields,
} from "./handlers/workflow_handlers.ts";
import {
  handleVaultAnnotate,
  handleVaultAuditTrail,
  handleVaultCreate,
  handleVaultDelete,
  handleVaultDescribe,
  handleVaultEdit,
  handleVaultGet,
  handleVaultInspect,
  handleVaultListKeys,
  handleVaultPut,
  handleVaultReadSecret,
  handleVaultSearch,
  handleVaultTypeSearch,
} from "./handlers/vault_handlers.ts";
import {
  handleAccessCanI,
  handleAccessCheck,
  handleAccessGrantList,
  handleAccessGroupList,
  handleAccessGroupListIdp,
  handleAccessReload,
  handleAccessTokenList,
  handleAccessTokenRevoke,
  handleAccessTokenRotate,
} from "./handlers/access_handlers.ts";
import {
  handleReportDescribe,
  handleReportGet,
  handleReportSearch,
  handleReportTypeSearch,
} from "./handlers/report_handlers.ts";
import {
  handleAuditTimeline,
  handleClusterInstances,
  handleDatastoreNamespaceList,
  handleDatastoreSetupExtension,
  handleDatastoreStatus,
  handleDoctorDatastores,
  handleDoctorExtensions,
  handleDoctorSecrets,
  handleDoctorVaults,
  handleDoctorWorkflows,
  handleExtensionInfo,
  handleExtensionInstall,
  handleExtensionList,
  handleExtensionOutdated,
  handleExtensionPull,
  handleExtensionRm,
  handleExtensionSearch,
  handleExtensionUpdate,
  handleRunDoctor,
  handleRunHistory,
  handleServeConfig,
  handleServeReload,
  handleVaultMigrate,
  handleWorkerList,
  handleWorkerQueueList,
  handleWorkerTokenCreate,
  handleWorkerTokenList,
  handleWorkerTokenRevoke,
  handleWorkerVerify,
} from "./handlers/admin_handlers.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  getConnectionSourceIp,
  isRestrictedCommand,
  MAX_PREDICATE_LENGTH,
  MAX_QUERY_RESULTS,
  send,
  sendError,
  subscribeUntilDetach,
} from "./handlers/shared.ts";
import { findActiveRunByRunId } from "./active_run_tracker.ts";
import { InstanceHeartbeatService } from "./instance_heartbeat.ts";

export {
  exceptionTypeForClient,
  lockTimeoutErrorForClient,
  sanitizeErrorForClient,
} from "./handlers/shared.ts";
export type { ConnectionContext } from "./handlers/shared.ts";

const MAX_ACTIVE_REQUESTS = 100;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000; // 8 hours

// ── Zod schemas for incoming WebSocket messages ─────────────────────────

const WorkflowRunRequestSchema = z.object({
  type: z.literal("workflow.run"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    lastEvaluated: z.boolean().optional(),
    verbose: z.boolean().optional(),
    runtimeTags: z.record(z.string(), z.string()).optional(),
    skipAllReports: z.boolean().optional(),
    skipReportNames: z.array(z.string()).optional(),
    skipReportLabels: z.array(z.string()).optional(),
    reportNames: z.array(z.string()).optional(),
    reportLabels: z.array(z.string()).optional(),
    skipAllChecks: z.boolean().optional(),
    skipCheckNames: z.array(z.string()).optional(),
    skipCheckLabels: z.array(z.string()).optional(),
    traceparent: z.string().optional(),
    tracestate: z.string().optional(),
  }),
});

const ModelMethodRunRequestSchema = z.object({
  type: z.literal("model.method.run"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string(),
    methodName: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    lastEvaluated: z.boolean().optional(),
    runtimeTags: z.record(z.string(), z.string()).optional(),
    typeArg: z.string().optional(),
    definitionName: z.string().optional(),
    skipAllReports: z.boolean().optional(),
    skipReportNames: z.array(z.string()).optional(),
    skipReportLabels: z.array(z.string()).optional(),
    reportNames: z.array(z.string()).optional(),
    reportLabels: z.array(z.string()).optional(),
    skipAllChecks: z.boolean().optional(),
    skipCheckNames: z.array(z.string()).optional(),
    skipCheckLabels: z.array(z.string()).optional(),
    traceparent: z.string().optional(),
    tracestate: z.string().optional(),
  }),
});

const AccessGrantListRequestSchema = z.object({
  type: z.literal("access.grant.list"),
  id: z.string().min(1).max(256),
  payload: z.object({
    subject: z.string().optional(),
    resource: z.string().optional(),
  }).optional(),
});

const AccessGroupListRequestSchema = z.object({
  type: z.literal("access.group.list"),
  id: z.string().min(1).max(256),
  payload: z.object({
    name: z.string().optional(),
  }).optional(),
});

const AccessGroupListIdpRequestSchema = z.object({
  type: z.literal("access.group.list-idp"),
  id: z.string().min(1).max(256),
});

const AccessCheckRequestSchema = z.object({
  type: z.literal("access.check"),
  id: z.string().min(1).max(256),
  payload: z.object({
    subject: z.string(),
    action: z.string(),
    resource: z.string(),
    collectives: z.array(z.string()).optional(),
  }),
});

const AccessCanIRequestSchema = z.object({
  type: z.literal("access.can-i"),
  id: z.string().min(1).max(256),
  payload: z.object({
    action: z.string().optional(),
    resource: z.string().optional(),
    method: z.string().optional(),
    collectives: z.array(z.string()).optional(),
  }).refine(
    (p) => !!p.action === !!p.resource,
    "action and resource must both be present or both absent",
  ),
});

const AccessReloadRequestSchema = z.object({
  type: z.literal("access.reload"),
  id: z.string().min(1).max(256),
});

const ServeReloadRequestSchema = z.object({
  type: z.literal("serve.reload"),
  id: z.string().min(1).max(256),
});

const CancelRequestSchema = z.object({
  type: z.literal("cancel"),
  id: z.string().min(1).max(256),
});

const DataGetRequestSchema = z.object({
  type: z.literal("data.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string().optional(),
    dataName: z.string().optional(),
    workflowName: z.string().optional(),
    runId: z.string().optional(),
    version: z.number().optional(),
    includeContent: z.boolean().optional(),
  }),
});

const DataQueryRequestSchema = z.object({
  type: z.literal("data.query"),
  id: z.string().min(1).max(256),
  payload: z.object({
    predicate: z.string().max(MAX_PREDICATE_LENGTH),
    limit: z.number().int().positive().max(MAX_QUERY_RESULTS).optional(),
    select: z.string().max(MAX_PREDICATE_LENGTH).optional(),
  }),
});

const DataListRequestSchema = z.object({
  type: z.literal("data.list"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string().optional(),
    workflowName: z.string().optional(),
    runId: z.string().optional(),
    typeFilter: z.string().optional(),
  }),
});

const DataSearchRequestSchema = z.object({
  type: z.literal("data.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
    type: z.string().optional(),
    lifetime: z.string().optional(),
    ownerType: z.string().optional(),
    workflow: z.string().optional(),
    model: z.string().optional(),
    contentType: z.string().optional(),
    since: z.string().optional(),
    output: z.string().optional(),
    run: z.string().optional(),
    streaming: z.boolean().optional(),
    tags: z.record(z.string(), z.string()).optional(),
    limit: z.number().int().positive().max(10_000).optional(),
  }).optional(),
});

const DataVersionsRequestSchema = z.object({
  type: z.literal("data.versions"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string(),
    dataName: z.string(),
  }),
});

const DataDeleteRequestSchema = z.object({
  type: z.literal("data.delete"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string(),
    dataName: z.string(),
    version: z.number().optional(),
  }),
});

const DataRenameRequestSchema = z.object({
  type: z.literal("data.rename"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string(),
    oldName: z.string(),
    newName: z.string(),
  }),
});

const ModelSearchRequestSchema = z.object({
  type: z.literal("model.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const ModelMethodDescribeRequestSchema = z.object({
  type: z.literal("model.method.describe"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string(),
    methodName: z.string(),
  }),
});

const WorkflowSearchRequestSchema = z.object({
  type: z.literal("workflow.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const WorkflowApprovalsRequestSchema = z.object({
  type: z.literal("workflow.approvals"),
  id: z.string().min(1).max(256),
});

const VaultGetRequestSchema = z.object({
  type: z.literal("vault.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultNameOrId: z.string(),
    vaultType: z.string().optional(),
  }),
});

const VaultPutRequestSchema = z.object({
  type: z.literal("vault.put"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultName: z.string(),
    key: z.string(),
    value: z.string(),
    force: z.boolean().optional(),
    refreshFrom: z.string().optional(),
    refreshTtlMs: z.number().optional(),
    clearRefresh: z.boolean().optional(),
    labels: z.record(z.string().min(1), z.string()).optional(),
  }),
});

const VaultDeleteRequestSchema = z.object({
  type: z.literal("vault.delete"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultName: z.string(),
    key: z.string(),
    force: z.boolean().optional(),
  }),
});

const AuditTimelineRequestSchema = z.object({
  type: z.literal("audit.timeline"),
  id: z.string().min(1).max(256),
  payload: z.object({
    hours: z.number().optional(),
    showAll: z.boolean().optional(),
    sessionId: z.string().optional(),
    includeDiagnostic: z.boolean().optional(),
  }).optional(),
});

const AuditQueryRequestSchema = z.object({
  type: z.literal("audit.query"),
  id: z.string().min(1).max(256),
  payload: z.object({
    since: z.string().optional(),
    until: z.string().optional(),
    principal: z.string().optional(),
    category: z.string().optional(),
    action: z.string().optional(),
    outcome: z.string().optional(),
    resource: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    cursor: z.string().optional(),
  }),
});

const AuditVerifyRequestSchema = z.object({
  type: z.literal("audit.verify"),
  id: z.string().min(1).max(256),
  payload: z.object({
    since: z.string().optional(),
    until: z.string().optional(),
  }),
});

const MAX_AUDIT_FILTER_ITEMS = 20;

const AuditSubscribeRequestSchema = z.object({
  type: z.literal("audit.subscribe"),
  id: z.string().min(1).max(256),
  payload: z.object({
    categories: z.array(z.string().max(64)).max(MAX_AUDIT_FILTER_ITEMS)
      .optional(),
    principals: z.array(z.string().max(256)).max(MAX_AUDIT_FILTER_ITEMS)
      .optional(),
    actions: z.array(z.string().max(256)).max(MAX_AUDIT_FILTER_ITEMS)
      .optional(),
    outcomes: z.array(z.string().max(64)).max(MAX_AUDIT_FILTER_ITEMS)
      .optional(),
    resourceKind: z.string().max(256).optional(),
  }).optional(),
});

const AuditUnsubscribeRequestSchema = z.object({
  type: z.literal("audit.unsubscribe"),
  id: z.string().min(1).max(256),
});

const SummariseRequestSchema = z.object({
  type: z.literal("summarise"),
  id: z.string().min(1).max(256),
  payload: z.object({
    since: z.string().optional(),
    limit: z.number().optional(),
  }).optional(),
});

const ReportGetRequestSchema = z.object({
  type: z.literal("report.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    reportName: z.string(),
    model: z.string().optional(),
    workflow: z.string().optional(),
    version: z.number().optional(),
    variant: z.string().optional(),
  }),
});

const ReportSearchRequestSchema = z.object({
  type: z.literal("report.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
    model: z.string().optional(),
    workflow: z.string().optional(),
    scope: z.string().optional(),
    type: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }).optional(),
});

const ReportDescribeRequestSchema = z.object({
  type: z.literal("report.describe"),
  id: z.string().min(1).max(256),
  payload: z.object({
    reportName: z.string(),
  }),
});

const ReportTypeSearchRequestSchema = z.object({
  type: z.literal("report.type.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

// ── Model operation schemas ─────────────────────────────────────────

const ModelGetRequestSchema = z.object({
  type: z.literal("model.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string(),
  }),
});

const ModelCreateRequestSchema = z.object({
  type: z.literal("model.create"),
  id: z.string().min(1).max(256),
  payload: z.object({
    typeArg: z.string(),
    name: z.string().optional(),
    globalArguments: z.record(z.string(), z.unknown()).optional(),
  }),
});

const ModelDeleteRequestSchema = z.object({
  type: z.literal("model.delete"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string(),
    force: z.boolean().optional(),
  }),
});

const ModelOutputGetRequestSchema = z.object({
  type: z.literal("model.output.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    outputIdOrModelName: z.string(),
  }),
});

const ModelOutputDataRequestSchema = z.object({
  type: z.literal("model.output.data"),
  id: z.string().min(1).max(256),
  payload: z.object({
    outputIdArg: z.string(),
    name: z.string().optional(),
    field: z.string().optional(),
    version: z.number().optional(),
  }),
});

const ModelOutputLogsRequestSchema = z.object({
  type: z.literal("model.output.logs"),
  id: z.string().min(1).max(256),
  payload: z.object({
    outputIdArg: z.string(),
    tail: z.number().optional(),
  }),
});

const ModelOutputSearchRequestSchema = z.object({
  type: z.literal("model.output.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const ModelMethodHistoryGetRequestSchema = z.object({
  type: z.literal("model.method.history.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    outputIdOrModelName: z.string(),
  }),
});

const ModelMethodHistoryLogsRequestSchema = z.object({
  type: z.literal("model.method.history.logs"),
  id: z.string().min(1).max(256),
  payload: z.object({
    outputIdOrModelName: z.string(),
    tail: z.number().optional(),
  }),
});

const ModelMethodHistorySearchRequestSchema = z.object({
  type: z.literal("model.method.history.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const ModelValidateRequestSchema = z.object({
  type: z.literal("model.validate"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string().optional(),
    labels: z.array(z.string()).optional(),
    method: z.string().optional(),
  }).optional(),
});

const ModelEvaluateRequestSchema = z.object({
  type: z.literal("model.evaluate"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string().optional(),
  }).optional(),
});

// ── Workflow operation schemas ───────────────────────────────────────

const WorkflowGetRequestSchema = z.object({
  type: z.literal("workflow.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string(),
  }),
});

const WorkflowHistoryGetRequestSchema = z.object({
  type: z.literal("workflow.history.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string(),
  }),
});

const WorkflowHistoryLogsRequestSchema = z.object({
  type: z.literal("workflow.history.logs"),
  id: z.string().min(1).max(256),
  payload: z.object({
    runIdOrWorkflow: z.string(),
    tail: z.number().optional(),
  }),
});

const WorkflowHistorySearchRequestSchema = z.object({
  type: z.literal("workflow.history.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
    workflow: z.string().optional(),
    inputs: z.record(z.string(), z.string()).optional(),
    filter: z.string().max(1024).optional(),
  }).optional(),
});

const WorkflowRunSearchRequestSchema = z.object({
  type: z.literal("workflow.run.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
    since: z.string().optional(),
    status: z.string().optional(),
    workflow: z.string().optional(),
    tags: z.record(z.string(), z.string()).optional(),
    inputs: z.record(z.string(), z.string()).optional(),
    limit: z.number().int().positive().max(10_000).optional(),
  }).optional(),
});

const WorkflowSchemaRequestSchema = z.object({
  type: z.literal("workflow.schema"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string().optional(),
  }),
});

const WorkflowApproveRequestSchema = z.object({
  type: z.literal("workflow.approve"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string(),
    stepName: z.string(),
    reason: z.string().optional(),
    runId: z.string().optional(),
    decidedBy: z.string().max(256).optional(),
  }),
});

const WorkflowRejectRequestSchema = z.object({
  type: z.literal("workflow.reject"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string(),
    stepName: z.string(),
    reason: z.string().optional(),
    runId: z.string().optional(),
    decidedBy: z.string().max(256).optional(),
  }),
});

const WorkflowResumeRequestSchema = z.object({
  type: z.literal("workflow.resume"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string(),
    runId: z.string().optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    traceparent: z.string().optional(),
    tracestate: z.string().optional(),
  }),
});

// ── Vault operation schemas ─────────────────────────────────────────

const VaultDescribeRequestSchema = z.object({
  type: z.literal("vault.describe"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultNameOrId: z.string(),
    vaultType: z.string().optional(),
  }),
});

const VaultInspectRequestSchema = z.object({
  type: z.literal("vault.inspect"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultName: z.string(),
    key: z.string(),
  }),
});

const VaultListKeysRequestSchema = z.object({
  type: z.literal("vault.list-keys"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultName: z.string().optional(),
  }).optional(),
});

const VaultSearchRequestSchema = z.object({
  type: z.literal("vault.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const VaultAnnotateRequestSchema = z.object({
  type: z.literal("vault.annotate"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultName: z.string(),
    key: z.string(),
    url: z.string().optional(),
    notes: z.string().optional(),
    labels: z.array(z.string()).optional(),
    removeLabels: z.array(z.string()).optional(),
    clear: z.boolean().optional(),
  }),
});

// ── Server admin schemas ────────────────────────────────────────────

const WorkerListRequestSchema = z.object({
  type: z.literal("worker.list"),
  id: z.string().min(1).max(256),
  payload: z.object({
    showAll: z.boolean().optional(),
  }).optional(),
});

const WorkerQueueListRequestSchema = z.object({
  type: z.literal("worker.queue.list"),
  id: z.string().min(1).max(256),
});

const WorkerVerifyRequestSchema = z.object({
  type: z.literal("worker.verify"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workerName: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
  }).optional(),
});

const DatastoreStatusRequestSchema = z.object({
  type: z.literal("datastore.status"),
  id: z.string().min(1).max(256),
});

const DatastoreSetupExtensionRequestSchema = z.object({
  type: z.literal("datastore.setup.extension"),
  id: z.string().min(1).max(256),
  payload: z.object({
    type: z.string(),
    config: z.record(z.string(), z.unknown()),
    skipMigration: z.boolean().optional(),
    hydrationStrategy: z.enum(["full", "lazy"]).optional(),
    namespace: z.string().optional(),
    timeout: z.number().int().positive().max(21600).optional(),
  }),
});

const VaultMigrateRequestSchema = z.object({
  type: z.literal("vault.migrate"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultName: z.string(),
    targetType: z.string(),
    targetConfig: z.record(z.string(), z.unknown()).optional(),
  }),
});

// ── Extension operation schemas ─────────────────────────────────────

const ExtensionListRequestSchema = z.object({
  type: z.literal("extension.list"),
  id: z.string().min(1).max(256),
});

const stringOrStringArray = z.union([z.string(), z.array(z.string())]);

const ExtensionSearchRequestSchema = z.object({
  type: z.literal("extension.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
    collective: z.string().optional(),
    platform: stringOrStringArray.optional(),
    label: stringOrStringArray.optional(),
    contentType: stringOrStringArray.optional(),
    channel: stringOrStringArray.optional(),
    sort: z.string().optional(),
    perPage: z.number().optional(),
    page: z.number().optional(),
  }).optional(),
});

const ExtensionInfoRequestSchema = z.object({
  type: z.literal("extension.info"),
  id: z.string().min(1).max(256),
  payload: z.object({
    extensionName: z.string(),
  }),
});

const ExtensionInstallRequestSchema = z.object({
  type: z.literal("extension.install"),
  id: z.string().min(1).max(256),
});

const ExtensionPullRequestSchema = z.object({
  type: z.literal("extension.pull"),
  id: z.string().min(1).max(256),
  payload: z.object({
    extensionName: z.string(),
    force: z.boolean().optional(),
    channel: z.string().optional(),
  }),
});

const ExtensionRmRequestSchema = z.object({
  type: z.literal("extension.rm"),
  id: z.string().min(1).max(256),
  payload: z.object({
    extensionName: z.string(),
  }),
});

const ExtensionOutdatedRequestSchema = z.object({
  type: z.literal("extension.outdated"),
  id: z.string().min(1).max(256),
});

const ExtensionUpdateRequestSchema = z.object({
  type: z.literal("extension.update"),
  id: z.string().min(1).max(256),
  payload: z.object({
    extensionName: z.string().optional(),
    checkOnly: z.boolean().optional(),
  }).optional(),
});

// ── Doctor operation schemas ────────────────────────────────────────

const DoctorVaultsRequestSchema = z.object({
  type: z.literal("doctor.vaults"),
  id: z.string().min(1).max(256),
});

const DoctorSecretsRequestSchema = z.object({
  type: z.literal("doctor.secrets"),
  id: z.string().min(1).max(256),
});

const DoctorWorkflowsRequestSchema = z.object({
  type: z.literal("doctor.workflows"),
  id: z.string().min(1).max(256),
});

const DoctorExtensionsRequestSchema = z.object({
  type: z.literal("doctor.extensions"),
  id: z.string().min(1).max(256),
});

const RunHistoryRequestSchema = z.object({
  type: z.literal("run.history"),
  id: z.string().min(1).max(256),
  payload: z.object({
    active: z.boolean().optional(),
    all: z.boolean().optional(),
  }).optional(),
});

const RunDoctorRequestSchema = z.object({
  type: z.literal("run.doctor"),
  id: z.string().min(1).max(256),
  payload: z.object({
    fix: z.boolean().optional(),
  }).optional(),
});

const RunAttachRequestSchema = z.object({
  type: z.literal("run.attach"),
  id: z.string().min(1).max(256),
  payload: z.object({
    runId: z.string().min(1).max(256),
    afterSeq: z.number().int().nonnegative().optional(),
  }),
});

const AccessTokenListRequestSchema = z.object({
  type: z.literal("access.token.list"),
  id: z.string().min(1).max(256),
  payload: z.object({}).optional(),
});

const AccessTokenRevokeRequestSchema = z.object({
  type: z.literal("access.token.revoke"),
  id: z.string().min(1).max(256),
  payload: z.object({
    name: z.string().min(1),
  }),
});

const AccessTokenRotateRequestSchema = z.object({
  type: z.literal("access.token.rotate"),
  id: z.string().min(1).max(256),
  payload: z.object({
    name: z.string().min(1),
    durationMs: z.number().positive().optional(),
    vaultName: z.string().optional(),
  }),
});

const ModelEditRequestSchema = z.object({
  type: z.literal("model.edit"),
  id: z.string().min(1).max(256),
  payload: z.object({
    modelIdOrName: z.string().min(1),
    content: z.string().optional(),
  }),
});

const ModelTypeDescribeRequestSchema = z.object({
  type: z.literal("model.type.describe"),
  id: z.string().min(1).max(256),
  payload: z.object({
    typeArg: z.string().min(1),
  }),
});

const ModelTypeSearchRequestSchema = z.object({
  type: z.literal("model.type.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const WorkflowCreateRequestSchema = z.object({
  type: z.literal("workflow.create"),
  id: z.string().min(1).max(256),
  payload: z.object({
    name: z.string().min(1),
  }),
});

const WorkflowDeleteRequestSchema = z.object({
  type: z.literal("workflow.delete"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string().min(1),
  }),
});

const WorkflowEditRequestSchema = z.object({
  type: z.literal("workflow.edit"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string().min(1),
    content: z.string().optional(),
  }),
});

const WorkflowValidateRequestSchema = z.object({
  type: z.literal("workflow.validate"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string().optional(),
  }).optional(),
});

const WorkflowEvaluateRequestSchema = z.object({
  type: z.literal("workflow.evaluate"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string().optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

const WorkflowTriggerSetRequestSchema = z.object({
  type: z.literal("workflow.trigger.set"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowName: z.string().min(1),
    schedule: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }),
});

const WorkflowTriggerGetRequestSchema = z.object({
  type: z.literal("workflow.trigger.get"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowName: z.string().min(1),
  }),
});

const WorkflowTriggerRemoveRequestSchema = z.object({
  type: z.literal("workflow.trigger.remove"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowName: z.string().min(1),
  }),
});

const VaultCreateRequestSchema = z.object({
  type: z.literal("vault.create"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultType: z.string().min(1),
    name: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    auditReads: z.boolean().optional(),
  }),
});

const VaultEditRequestSchema = z.object({
  type: z.literal("vault.edit"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultNameOrId: z.string().min(1),
    vaultType: z.string().optional(),
  }),
});

const VaultAuditTrailRequestSchema = z.object({
  type: z.literal("vault.audit-trail"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultName: z.string().optional(),
    secretKey: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }).optional(),
});

const VaultReadSecretRequestSchema = z.object({
  type: z.literal("vault.read-secret"),
  id: z.string().min(1).max(256),
  payload: z.object({
    vaultName: z.string().min(1),
    secretKey: z.string().min(1),
  }),
});

const VaultTypeSearchRequestSchema = z.object({
  type: z.literal("vault.type.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const WorkerTokenCreateRequestSchema = z.object({
  type: z.literal("worker.token.create"),
  id: z.string().min(1).max(256),
  payload: z.object({
    name: z.string().min(1),
    durationMs: z.number().positive(),
    vaultName: z.string().optional(),
    maxEnrollments: z.union([
      z.number().int().positive(),
      z.literal("unlimited"),
    ])
      .optional(),
  }),
});

const WorkerTokenListRequestSchema = z.object({
  type: z.literal("worker.token.list"),
  id: z.string().min(1).max(256),
  payload: z.object({
    showAll: z.boolean().optional(),
  }).optional(),
});

const WorkerTokenRevokeRequestSchema = z.object({
  type: z.literal("worker.token.revoke"),
  id: z.string().min(1).max(256),
  payload: z.object({
    name: z.string().min(1),
  }),
});

const DataGcRequestSchema = z.object({
  type: z.literal("data.gc"),
  id: z.string().min(1).max(256),
  payload: z.object({
    dryRun: z.boolean().optional(),
  }).optional(),
});

const DataPruneRequestSchema = z.object({
  type: z.literal("data.prune"),
  id: z.string().min(1).max(256),
  payload: z.object({
    dryRun: z.boolean().optional(),
  }).optional(),
});

const RunGcRequestSchema = z.object({
  type: z.literal("run.gc"),
  id: z.string().min(1).max(256),
  payload: z.object({
    dryRun: z.boolean().optional(),
    workflowRunRetentionDays: z.number().positive().optional(),
    outputRetentionDays: z.number().positive().optional(),
  }).optional(),
});

const DatastoreNamespaceListRequestSchema = z.object({
  type: z.literal("datastore.namespace.list"),
  id: z.string().min(1).max(256),
  payload: z.object({}).optional(),
});

const ServerVersionRequestSchema = z.object({
  type: z.literal("server.version"),
  id: z.string().min(1).max(256),
});

const ServerRequestSchema = z.discriminatedUnion("type", [
  ServerVersionRequestSchema,
  WorkflowRunRequestSchema,
  ModelMethodRunRequestSchema,
  AccessGrantListRequestSchema,
  AccessGroupListRequestSchema,
  AccessGroupListIdpRequestSchema,
  AccessCheckRequestSchema,
  AccessCanIRequestSchema,
  AccessReloadRequestSchema,
  ServeReloadRequestSchema,
  DataGetRequestSchema,
  DataQueryRequestSchema,
  DataListRequestSchema,
  DataSearchRequestSchema,
  DataVersionsRequestSchema,
  DataDeleteRequestSchema,
  DataRenameRequestSchema,
  ModelSearchRequestSchema,
  ModelMethodDescribeRequestSchema,
  WorkflowSearchRequestSchema,
  VaultGetRequestSchema,
  VaultPutRequestSchema,
  VaultDeleteRequestSchema,
  AuditTimelineRequestSchema,
  AuditQueryRequestSchema,
  AuditVerifyRequestSchema,
  AuditSubscribeRequestSchema,
  AuditUnsubscribeRequestSchema,
  SummariseRequestSchema,
  ReportGetRequestSchema,
  ReportSearchRequestSchema,
  ReportDescribeRequestSchema,
  ReportTypeSearchRequestSchema,
  ModelGetRequestSchema,
  ModelCreateRequestSchema,
  ModelDeleteRequestSchema,
  ModelOutputGetRequestSchema,
  ModelOutputDataRequestSchema,
  ModelOutputLogsRequestSchema,
  ModelOutputSearchRequestSchema,
  ModelMethodHistoryGetRequestSchema,
  ModelMethodHistoryLogsRequestSchema,
  ModelMethodHistorySearchRequestSchema,
  ModelValidateRequestSchema,
  ModelEvaluateRequestSchema,
  WorkflowGetRequestSchema,
  WorkflowHistoryGetRequestSchema,
  WorkflowHistoryLogsRequestSchema,
  WorkflowHistorySearchRequestSchema,
  WorkflowRunSearchRequestSchema,
  WorkflowSchemaRequestSchema,
  WorkflowApprovalsRequestSchema,
  WorkflowApproveRequestSchema,
  WorkflowRejectRequestSchema,
  WorkflowResumeRequestSchema,
  VaultDescribeRequestSchema,
  VaultInspectRequestSchema,
  VaultListKeysRequestSchema,
  VaultSearchRequestSchema,
  VaultAnnotateRequestSchema,
  WorkerListRequestSchema,
  WorkerQueueListRequestSchema,
  WorkerVerifyRequestSchema,
  DatastoreStatusRequestSchema,
  DatastoreSetupExtensionRequestSchema,
  VaultMigrateRequestSchema,
  ExtensionListRequestSchema,
  ExtensionSearchRequestSchema,
  ExtensionInfoRequestSchema,
  ExtensionInstallRequestSchema,
  ExtensionPullRequestSchema,
  ExtensionRmRequestSchema,
  ExtensionOutdatedRequestSchema,
  ExtensionUpdateRequestSchema,
  DoctorVaultsRequestSchema,
  DoctorSecretsRequestSchema,
  DoctorWorkflowsRequestSchema,
  DoctorExtensionsRequestSchema,
  RunHistoryRequestSchema,
  RunDoctorRequestSchema,
  RunAttachRequestSchema,
  CancelRequestSchema,
  AccessTokenListRequestSchema,
  AccessTokenRevokeRequestSchema,
  AccessTokenRotateRequestSchema,
  ModelEditRequestSchema,
  ModelTypeDescribeRequestSchema,
  ModelTypeSearchRequestSchema,
  WorkflowCreateRequestSchema,
  WorkflowDeleteRequestSchema,
  WorkflowEditRequestSchema,
  WorkflowValidateRequestSchema,
  WorkflowEvaluateRequestSchema,
  WorkflowTriggerSetRequestSchema,
  WorkflowTriggerGetRequestSchema,
  WorkflowTriggerRemoveRequestSchema,
  VaultCreateRequestSchema,
  VaultEditRequestSchema,
  VaultAuditTrailRequestSchema,
  VaultReadSecretRequestSchema,
  VaultTypeSearchRequestSchema,
  WorkerTokenCreateRequestSchema,
  WorkerTokenListRequestSchema,
  WorkerTokenRevokeRequestSchema,
  DataGcRequestSchema,
  DataPruneRequestSchema,
  RunGcRequestSchema,
  DatastoreNamespaceListRequestSchema,
]);

/**
 * Validates a parsed JSON value against the ServerRequest schema.
 * Returns the validated request on success, or a human-readable error string on failure.
 */
export function validateServerRequest(
  data: unknown,
): ServerRequest | string {
  const result = ServerRequestSchema.safeParse(data);
  if (result.success) {
    return result.data as ServerRequest;
  }
  const issues = result.error.issues.map((i) =>
    `${i.path.join(".")}: ${i.message}`
  ).join("; ");
  return `Invalid request: ${issues}`;
}

/**
 * Best-effort extraction of the request `id` from a parsed message
 * BEFORE schema validation. When validation fails, the validated
 * request object is unavailable, but the client still needs the id
 * echoed back so it can match the error to its pending request.
 * Falls back to `"unknown"` when the id is absent or not a string.
 */
export function extractRequestId(data: unknown): string {
  if (
    typeof data === "object" && data !== null &&
    "id" in data && typeof (data as Record<string, unknown>).id === "string"
  ) {
    return (data as Record<string, unknown>).id as string;
  }
  return "unknown";
}

const logger = getSwampLogger(["serve", "connection"]);

const MAX_SUBSCRIPTIONS_PER_CONNECTION = 2;
const SUBSCRIPTION_REAUTH_INTERVAL_MS = 60_000;

export function handleConnection(
  socket: WebSocket,
  ctx: ConnectionContext,
  principal: Principal | null,
): void {
  const activeRequests = new Map<string, AbortController>();
  const activeSubscriptions = new Set<string>();
  const subscriptionTimers = new Map<string, ReturnType<typeof setInterval>>();
  const workerAttachment = ctx.workerGateway?.attachTransport({
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      } else {
        let frameType = "unknown";
        let frameId = "unknown";
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (typeof parsed.type === "string") frameType = parsed.type;
          if (typeof parsed.id === "string") frameId = parsed.id;
        } catch { /* best-effort */ }
        logger.warn(
          "Dropped RPC frame {frameType} (id {frameId}): socket readyState is {readyState}",
          { frameType, frameId, readyState: socket.readyState },
        );
      }
    },
  }, () => socket.close());

  const sessionTimeout = principal
    ? setTimeout(() => {
      socket.close(
        4002,
        "Session expired after 8 hours — reconnect to re-authenticate",
      );
    }, MAX_SESSION_MS)
    : null;

  socket.onmessage = (event) => {
    if (
      workerAttachment && typeof event.data === "string" &&
      workerAttachment.feed(event.data)
    ) {
      return;
    }
    handleMessage(
      socket,
      ctx,
      activeRequests,
      event,
      principal,
      activeSubscriptions,
      subscriptionTimers,
    );
  };

  socket.onclose = () => {
    if (sessionTimeout) clearTimeout(sessionTimeout);
    workerAttachment?.closed();
    for (const controller of activeRequests.values()) {
      controller.abort();
    }
    activeRequests.clear();
    if (ctx.auditWebSocketSink) {
      for (const subId of activeSubscriptions) {
        ctx.auditWebSocketSink.unsubscribe(subId);
      }
    }
    for (const timer of subscriptionTimers.values()) {
      clearInterval(timer);
    }
    activeSubscriptions.clear();
    subscriptionTimers.clear();
  };

  socket.onerror = (event) => {
    logger.warn("WebSocket error: {error}", {
      error: event instanceof ErrorEvent ? event.message : "unknown",
    });
  };
}

/**
 * Parse, validate, and dispatch a single incoming WebSocket message.
 * Exported for unit testing.
 */
export function handleMessage(
  socket: WebSocket,
  ctx: ConnectionContext,
  activeRequests: Map<string, AbortController>,
  event: MessageEvent,
  principal: Principal | null = null,
  activeSubscriptions: Set<string> = new Set(),
  subscriptionTimers: Map<string, ReturnType<typeof setInterval>> = new Map(),
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data as string);
  } catch {
    sendError(socket, "unknown", "invalid_request", "Invalid JSON");
    return;
  }

  const requestId = extractRequestId(parsed);

  const validated = validateServerRequest(parsed);
  if (typeof validated === "string") {
    sendError(socket, requestId, "invalid_request", validated);
    return;
  }

  const request: ServerRequest = validated;

  if (request.type === "cancel") {
    const pendingController = activeRequests.get(request.id);
    if (pendingController) {
      pendingController.abort();
      return;
    }
    const run = ctx.activeRunRegistry?.get(request.id);
    if (!run) return;

    const cancelController = new AbortController();
    activeRequests.set(request.id, cancelController);

    const cancelTask = handleCancelRun(
      socket,
      ctx,
      request.id,
      run,
      principal,
    );
    cancelTask
      .catch((error: unknown) => {
        logger.error("Unhandled request error for {requestId}: {error}", {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => activeRequests.delete(request.id));
    return;
  }

  if (activeRequests.size >= MAX_ACTIVE_REQUESTS) {
    sendError(
      socket,
      request.id,
      "too_many_requests",
      `Too many concurrent requests (limit: ${MAX_ACTIVE_REQUESTS}); wait for active requests to complete`,
    );
    return;
  }

  if (activeRequests.has(request.id)) {
    sendError(
      socket,
      request.id,
      "duplicate_id",
      `Request id '${request.id}' is already active`,
    );
    return;
  }

  const controller = new AbortController();
  activeRequests.set(request.id, controller);

  if (
    ctx.auditEmitter && ctx.auditFailOpen === false &&
    (ctx.auditWal?.isFull === true ||
      ctx.auditWal?.hasDroppedEvents === true)
  ) {
    sendError(
      socket,
      request.id,
      "audit_unavailable",
      "Request rejected: audit subsystem cannot durably record events (fail-secure mode)",
    );
    activeRequests.delete(request.id);
    return;
  }

  if (
    isRestrictedCommand(request.type, ctx.authConfig.restrictedCommands)
  ) {
    if (
      !authorizeOrReject(
        socket,
        request.id,
        principal,
        "admin",
        {
          kind: "access",
          name: request.type,
          fields: {},
        },
        ctx,
      ).allowed
    ) {
      activeRequests.delete(request.id);
      return;
    }
  }

  function auditOpts(
    category: AuditedOptions["category"],
    resourceKind: string,
    resourceName: string,
    methodName?: string,
  ): AuditedOptions {
    return {
      emitter: ctx.auditEmitter,
      instanceId: ctx.instanceId ?? "unknown",
      category,
      action: request.type,
      resourceKind,
      resourceName,
      principal,
      sourceIp: getConnectionSourceIp(socket),
      requestId: request.id,
      methodName,
      resolvedUserNames: ctx.resolvedUserNames,
      socket,
    };
  }

  let task: Promise<void>;
  switch (request.type) {
    case "server.version":
      task = audited(
        Promise.resolve(
          send(socket, {
            type: "server.version",
            id: request.id,
            payload: { version: SERVER_VERSION, gitSha: SERVER_GIT_SHA },
          }),
        ),
        auditOpts("admin", "server", "*"),
      );
      break;
    case "workflow.run":
      task = audited(
        handleWorkflowRun(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts(
          "execution",
          "workflow",
          "*",
        ),
      );
      break;
    case "model.method.run":
      task = audited(
        handleModelMethodRun(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts(
          "execution",
          "model",
          request.payload?.modelIdOrName ?? "*",
          request.payload?.methodName,
        ),
      );
      break;
    case "access.grant.list":
      task = audited(
        handleAccessGrantList(
          socket,
          ctx,
          request.id,
          principal,
          request.payload,
        ),
        auditOpts("access", "access", "*"),
      );
      break;
    case "access.group.list":
      task = audited(
        handleAccessGroupList(
          socket,
          ctx,
          request.id,
          principal,
          request.payload,
        ),
        auditOpts("access", "access", "*"),
      );
      break;
    case "access.group.list-idp":
      task = audited(
        handleAccessGroupListIdp(
          socket,
          ctx,
          request.id,
          principal,
        ),
        auditOpts("access", "access", "*"),
      );
      break;
    case "access.check":
      task = audited(
        handleAccessCheck(
          socket,
          ctx,
          request.id,
          request.payload,
          principal,
        ),
        auditOpts("access", "access", "*"),
      );
      break;
    case "access.can-i":
      task = audited(
        handleAccessCanI(
          socket,
          ctx,
          request.id,
          request.payload,
          principal,
        ),
        auditOpts("access", "access", "*"),
      );
      break;
    case "access.reload":
      task = audited(
        handleAccessReload(socket, ctx, request.id, principal),
        auditOpts("admin", "access", "*"),
      );
      break;
    case "serve.reload":
      task = audited(
        handleServeReload(socket, ctx, request.id, principal),
        auditOpts("admin", "access", "*"),
      );
      break;
    case "data.get":
      task = audited(
        handleDataGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "data", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "data.query":
      task = audited(
        handleDataQuery(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "data", "*"),
      );
      break;
    case "data.list":
      task = audited(
        handleDataList(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "data", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "data.search":
      task = audited(
        handleDataSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "data", "*"),
      );
      break;
    case "data.versions":
      task = audited(
        handleDataVersions(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "data", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "data.delete":
      task = audited(
        handleDataDelete(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "data", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "data.rename":
      task = audited(
        handleDataRename(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "data", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "model.search":
      task = audited(
        handleModelSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.method.describe":
      task = audited(
        handleModelMethodDescribe(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "model", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "workflow.search":
      task = audited(
        handleWorkflowSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "workflow.approvals":
      task = audited(
        handleWorkflowApprovals(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "vault.get":
      task = audited(
        handleVaultGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("secrets", "vault", "*"),
      );
      break;
    case "vault.put":
      task = audited(
        handleVaultPut(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("secrets", "vault", request.payload?.vaultName ?? "*"),
      );
      break;
    case "vault.delete":
      task = audited(
        handleVaultDelete(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("secrets", "vault", request.payload?.vaultName ?? "*"),
      );
      break;
    case "audit.timeline":
      task = audited(
        handleAuditTimeline(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("admin", "audit", "*"),
      );
      break;
    case "audit.query":
      if (
        !authorizeOrReject(
          socket,
          request.id,
          principal,
          "admin",
          { kind: "access", name: "audit", fields: {} },
          ctx,
        ).allowed
      ) {
        task = Promise.resolve();
        activeRequests.delete(request.id);
        break;
      }
      task = audited(
        (async () => {
          if (!ctx.auditStores || ctx.auditStores.length === 0) {
            send(socket, {
              type: "audit.query",
              id: request.id,
              payload: { events: [], total: 0 },
            });
            return;
          }
          const queryService = new AuditQueryService(ctx.auditStores[0]);
          const result = await queryService.query(request.payload);
          send(socket, {
            type: "audit.query",
            id: request.id,
            payload: {
              events: result.events as unknown as Record<string, unknown>[],
              cursor: result.cursor,
              total: result.total,
            },
          });
        })(),
        auditOpts("admin", "access", "audit"),
      );
      break;
    case "audit.verify":
      if (
        !authorizeOrReject(
          socket,
          request.id,
          principal,
          "admin",
          { kind: "access", name: "audit", fields: {} },
          ctx,
        ).allowed
      ) {
        task = Promise.resolve();
        activeRequests.delete(request.id);
        break;
      }
      task = audited(
        (async () => {
          if (!ctx.auditStores || ctx.auditStores.length === 0) {
            send(socket, {
              type: "audit.verify",
              id: request.id,
              payload: {
                valid: true,
                eventsChecked: 0,
                message: "No audit stores configured",
              },
            });
            return;
          }
          const verifyService = new AuditQueryService(ctx.auditStores[0]);
          const verifyResult = await verifyService.verify(
            request.payload.since,
            request.payload.until,
          );
          send(socket, {
            type: "audit.verify",
            id: request.id,
            payload: verifyResult,
          });
        })(),
        auditOpts("admin", "access", "audit"),
      );
      break;
    case "audit.subscribe":
      if (
        !authorizeOrReject(
          socket,
          request.id,
          principal,
          "admin",
          { kind: "access", name: "audit", fields: {} },
          ctx,
        ).allowed
      ) {
        task = Promise.resolve();
        activeRequests.delete(request.id);
        break;
      }
      task = audited(
        (() => {
          if (!ctx.auditWebSocketSink) {
            sendError(
              socket,
              request.id,
              "audit_not_configured",
              "Audit subsystem is not enabled",
            );
            return Promise.resolve();
          }
          if (activeSubscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
            sendError(
              socket,
              request.id,
              "subscription_limit",
              `Maximum ${MAX_SUBSCRIPTIONS_PER_CONNECTION} audit subscriptions per connection`,
            );
            return Promise.resolve();
          }
          const filter: AuditSubscriptionFilter = request.payload
            ? {
              categories: request.payload.categories as
                | AuditSubscriptionFilter["categories"]
                | undefined,
              principals: request.payload.principals,
              actions: request.payload.actions,
              outcomes: request.payload.outcomes as
                | AuditSubscriptionFilter["outcomes"]
                | undefined,
              resourceKind: request.payload.resourceKind,
            }
            : {};
          const subscriptionId = crypto.randomUUID();
          ctx.auditWebSocketSink.subscribe({
            id: subscriptionId,
            socket,
            filter,
          });
          activeSubscriptions.add(subscriptionId);

          const reauthTimer = setInterval(() => {
            const result = authorizeOrReject(
              socket,
              subscriptionId,
              principal,
              "admin",
              { kind: "access", name: "audit", fields: {} },
              ctx,
            );
            if (!result.allowed) {
              ctx.auditWebSocketSink!.unsubscribe(subscriptionId);
              activeSubscriptions.delete(subscriptionId);
              clearInterval(reauthTimer);
              subscriptionTimers.delete(subscriptionId);
            }
          }, SUBSCRIPTION_REAUTH_INTERVAL_MS);
          Deno.unrefTimer(reauthTimer);
          subscriptionTimers.set(subscriptionId, reauthTimer);

          send(socket, {
            type: "audit.subscribe",
            id: request.id,
            payload: { subscriptionId },
          });
          return Promise.resolve();
        })(),
        auditOpts("admin", "access", "audit"),
      );
      break;
    case "audit.unsubscribe": {
      const subIds = ctx.auditWebSocketSink
        ? ctx.auditWebSocketSink.subscriptionsForSocket(socket)
        : [];
      for (const subId of subIds) {
        ctx.auditWebSocketSink!.unsubscribe(subId);
        activeSubscriptions.delete(subId);
        const timer = subscriptionTimers.get(subId);
        if (timer) {
          clearInterval(timer);
          subscriptionTimers.delete(subId);
        }
      }
      send(socket, { type: "audit.unsubscribe", id: request.id });
      task = Promise.resolve();
      activeRequests.delete(request.id);
      break;
    }
    case "summarise":
      task = audited(
        handleSummarise(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "data", "*"),
      );
      break;
    case "report.get":
      task = audited(
        handleReportGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "report", request.payload?.reportName ?? "*"),
      );
      break;
    case "report.search":
      task = audited(
        handleReportSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "report", "*"),
      );
      break;
    case "report.describe":
      task = audited(
        handleReportDescribe(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "report", request.payload?.reportName ?? "*"),
      );
      break;
    case "report.type.search":
      task = audited(
        handleReportTypeSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "report", "*"),
      );
      break;
    case "model.get":
      task = audited(
        handleModelGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "model", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "model.create":
      task = audited(
        handleModelCreate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "model", request.payload?.name ?? "*"),
      );
      break;
    case "model.delete":
      task = audited(
        handleModelDelete(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "model", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "model.output.get":
      task = audited(
        handleModelOutputGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.output.data":
      task = audited(
        handleModelOutputData(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.output.logs":
      task = audited(
        handleModelOutputLogs(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.output.search":
      task = audited(
        handleModelOutputSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.method.history.get":
      task = audited(
        handleModelMethodHistoryGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.method.history.logs":
      task = audited(
        handleModelMethodHistoryLogs(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.method.history.search":
      task = audited(
        handleModelMethodHistorySearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.validate":
      task = audited(
        handleModelValidate(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "model.evaluate":
      task = audited(
        handleModelEvaluate(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("execution", "model", "*"),
      );
      break;
    case "workflow.get":
      task = audited(
        handleWorkflowGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "workflow.history.get":
      task = audited(
        handleWorkflowHistoryGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "workflow.history.logs":
      task = audited(
        handleWorkflowHistoryLogs(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "workflow", request.payload?.runIdOrWorkflow ?? "*"),
      );
      break;
    case "workflow.history.search":
      task = audited(
        handleWorkflowHistorySearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "workflow.run.search":
      task = audited(
        handleWorkflowRunSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "workflow.schema":
      task = audited(
        handleWorkflowSchema(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "workflow.approve":
      task = audited(
        handleWorkflowApprove(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("execution", "workflow", request.payload?.runId ?? "*"),
      );
      break;
    case "workflow.reject":
      task = audited(
        handleWorkflowReject(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("execution", "workflow", request.payload?.runId ?? "*"),
      );
      break;
    case "workflow.resume":
      task = audited(
        handleWorkflowResume(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("execution", "workflow", request.payload?.runId ?? "*"),
      );
      break;
    case "vault.describe":
      task = audited(
        handleVaultDescribe(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("secrets", "vault", "*"),
      );
      break;
    case "vault.inspect":
      task = audited(
        handleVaultInspect(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("secrets", "vault", request.payload?.vaultName ?? "*"),
      );
      break;
    case "vault.list-keys":
      task = audited(
        handleVaultListKeys(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("secrets", "vault", "*"),
      );
      break;
    case "vault.search":
      task = audited(
        handleVaultSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("secrets", "vault", "*"),
      );
      break;
    case "vault.annotate":
      task = audited(
        handleVaultAnnotate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("secrets", "vault", request.payload?.vaultName ?? "*"),
      );
      break;
    case "worker.list":
      task = audited(
        handleWorkerList(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("admin", "worker", "*"),
      );
      break;
    case "worker.queue.list":
      task = audited(
        handleWorkerQueueList(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "worker", "*"),
      );
      break;
    case "worker.verify":
      task = audited(
        handleWorkerVerify(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "worker", "*"),
      );
      break;
    case "datastore.status":
      task = audited(
        handleDatastoreStatus(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "datastore", "*"),
      );
      break;
    case "datastore.setup.extension":
      task = audited(
        handleDatastoreSetupExtension(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "datastore", "*"),
      );
      break;
    case "vault.migrate":
      task = audited(
        handleVaultMigrate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "vault", "*"),
      );
      break;
    case "extension.list":
      task = audited(
        handleExtensionList(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "extension", "*"),
      );
      break;
    case "extension.search":
      task = audited(
        handleExtensionSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("admin", "extension", "*"),
      );
      break;
    case "extension.info":
      task = audited(
        handleExtensionInfo(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "extension", request.payload?.extensionName ?? "*"),
      );
      break;
    case "extension.install":
      task = audited(
        handleExtensionInstall(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "extension", "*"),
      );
      break;
    case "extension.pull":
      task = audited(
        handleExtensionPull(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "extension", request.payload?.extensionName ?? "*"),
      );
      break;
    case "extension.rm":
      task = audited(
        handleExtensionRm(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "extension", request.payload?.extensionName ?? "*"),
      );
      break;
    case "extension.outdated":
      task = audited(
        handleExtensionOutdated(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "extension", "*"),
      );
      break;
    case "extension.update":
      task = audited(
        handleExtensionUpdate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "extension", request.payload?.extensionName ?? "*"),
      );
      break;
    case "doctor.datastores":
      task = audited(
        handleDoctorDatastores(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "doctor", "*"),
      );
      break;
    case "doctor.vaults":
      task = audited(
        handleDoctorVaults(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "doctor", "*"),
      );
      break;
    case "doctor.secrets":
      task = audited(
        handleDoctorSecrets(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "doctor", "*"),
      );
      break;
    case "doctor.workflows":
      task = audited(
        handleDoctorWorkflows(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "doctor", "*"),
      );
      break;
    case "doctor.extensions":
      task = audited(
        handleDoctorExtensions(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "doctor", "*"),
      );
      break;
    case "run.history":
      task = audited(
        Promise.resolve(handleRunHistory(
          socket,
          ctx,
          request.id,
          request.payload,
          principal,
        )),
        auditOpts("execution", "run", "*"),
      );
      break;
    case "run.doctor":
      task = audited(
        Promise.resolve(handleRunDoctor(
          socket,
          ctx,
          request.id,
          request.payload,
          principal,
        )),
        auditOpts("execution", "run", "*"),
      );
      break;
    case "run.attach":
      task = audited(
        handleRunAttach(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("execution", "run", request.payload?.runId ?? "*"),
      );
      break;
    case "access.token.list":
      task = audited(
        handleAccessTokenList(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("access", "access", "*"),
      );
      break;
    case "access.token.revoke":
      task = audited(
        handleAccessTokenRevoke(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("access", "access", "*"),
      );
      break;
    case "access.token.rotate":
      task = audited(
        handleAccessTokenRotate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("access", "access", "*"),
      );
      break;
    case "model.edit":
      task = audited(
        handleModelEdit(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "model", request.payload?.modelIdOrName ?? "*"),
      );
      break;
    case "model.type.describe":
      task = audited(
        handleModelTypeDescribe(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "model", request.payload?.typeArg ?? "*"),
      );
      break;
    case "model.type.search":
      task = audited(
        handleModelTypeSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("data", "model", "*"),
      );
      break;
    case "workflow.create":
      task = audited(
        handleWorkflowCreate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "workflow", request.payload?.name ?? "*"),
      );
      break;
    case "workflow.delete":
      task = audited(
        handleWorkflowDelete(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts(
          "admin",
          "workflow",
          "*",
        ),
      );
      break;
    case "workflow.edit":
      task = audited(
        handleWorkflowEdit(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts(
          "admin",
          "workflow",
          "*",
        ),
      );
      break;
    case "workflow.validate":
      task = audited(
        handleWorkflowValidate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "workflow.evaluate":
      task = audited(
        handleWorkflowEvaluate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("execution", "workflow", "*"),
      );
      break;
    case "workflow.trigger.set":
      task = audited(
        handleWorkflowTriggerSet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "workflow", "*"),
      );
      break;
    case "workflow.trigger.get":
      task = audited(
        handleWorkflowTriggerGet(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("data", "workflow", "*"),
      );
      break;
    case "workflow.trigger.remove":
      task = audited(
        handleWorkflowTriggerRemove(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "workflow", "*"),
      );
      break;
    case "vault.create":
      task = audited(
        handleVaultCreate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "vault", request.payload?.name ?? "*"),
      );
      break;
    case "vault.edit":
      task = audited(
        handleVaultEdit(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "vault", "*"),
      );
      break;
    case "vault.audit-trail":
      task = audited(
        handleVaultAuditTrail(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("secrets", "vault", request.payload?.vaultName ?? "*"),
      );
      break;
    case "vault.read-secret":
      task = audited(
        handleVaultReadSecret(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("secrets", "vault", request.payload?.vaultName ?? "*"),
      );
      break;
    case "vault.type.search":
      task = audited(
        handleVaultTypeSearch(
          socket,
          ctx,
          request.id,
          controller,
          principal,
          request.payload,
        ),
        auditOpts("secrets", "vault", "*"),
      );
      break;
    case "worker.token.create":
      task = audited(
        handleWorkerTokenCreate(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "worker", "*"),
      );
      break;
    case "worker.token.list":
      task = audited(
        handleWorkerTokenList(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "worker", "*"),
      );
      break;
    case "worker.token.revoke":
      task = audited(
        handleWorkerTokenRevoke(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "worker", "*"),
      );
      break;
    case "data.gc":
      task = audited(
        handleDataGc(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "data", "*"),
      );
      break;
    case "data.prune":
      task = audited(
        handleDataPrune(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "data", "*"),
      );
      break;
    case "run.gc":
      task = audited(
        handleRunGc(
          socket,
          ctx,
          request.id,
          request.payload,
          controller,
          principal,
        ),
        auditOpts("admin", "run", "*"),
      );
      break;
    case "datastore.namespace.list":
      task = audited(
        handleDatastoreNamespaceList(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "datastore", "*"),
      );
      break;
    case "cluster.instances":
      task = audited(
        handleClusterInstances(
          socket,
          ctx,
          request.id,
          controller,
          principal,
        ),
        auditOpts("admin", "cluster", "*"),
      );
      break;
    case "serve.config":
      task = audited(
        Promise.resolve(
          handleServeConfig(
            socket,
            ctx,
            request.id,
            principal,
          ),
        ),
        auditOpts("admin", "server", "*"),
      );
      break;
    default: {
      const unhandled = request as { id: string; type: string };
      task = Promise.resolve(
        sendError(
          socket,
          unhandled.id,
          "unsupported_operation",
          `Operation '${unhandled.type}' is not supported by this server version`,
        ),
      );
      break;
    }
  }

  task
    .catch((error: unknown) => {
      logger.error("Unhandled request error for {requestId}: {error}", {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => activeRequests.delete(request.id));
}

// ── Run attach handler ───────────────────────────────────────────────

async function handleCancelRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  run: import("./active_run_registry.ts").ActiveRun,
  principal: Principal | null,
): Promise<void> {
  const resourceKind = run.kind === "method-run" ? "model" : "workflow";
  const cancelFields = await resolveRunFields(
    ctx,
    resourceKind,
    run.resourceName,
  );
  if (
    authorizeOrReject(
      socket,
      requestId,
      principal,
      "run",
      {
        kind: resourceKind,
        name: run.resourceName,
        fields: cancelFields,
      },
      ctx,
    ).allowed
  ) {
    ctx.activeRunRegistry!.cancel(requestId);
  }
}

async function resolveRunFields(
  ctx: ConnectionContext,
  resourceKind: "model" | "workflow",
  resourceName: string,
): Promise<Record<string, unknown>> {
  try {
    if (resourceKind === "model") {
      return await resolveDataFields(
        ctx.repoContext.definitionRepo,
        resourceName,
      );
    }
    return await resolveWorkflowFields(
      ctx.repoContext.workflowRepo,
      resourceName,
    );
  } catch {
    return { name: resourceName };
  }
}

async function handleRunAttach(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: { runId: string; afterSeq?: number },
  controller: AbortController,
  principal: import("../domain/access/principal.ts").Principal | null,
): Promise<void> {
  const run = ctx.activeRunRegistry?.get(payload.runId);
  if (!run) {
    if (ctx.controlPlaneStore) {
      const result = await findActiveRunByRunId(
        ctx.controlPlaneStore,
        payload.runId,
      );
      if (result) {
        const resourceKind = result.record.runKind === "method-run"
          ? "model"
          : "workflow";
        const remoteFields = await resolveRunFields(
          ctx,
          resourceKind,
          result.record.resourceName,
        );
        if (
          !authorizeOrReject(
            socket,
            requestId,
            principal,
            "run",
            {
              kind: resourceKind,
              name: result.record.resourceName,
              fields: remoteFields,
            },
            ctx,
          ).allowed
        ) return;

        const heartbeatData = await ctx.controlPlaneStore.get(
          `heartbeats/${result.instanceId}`,
        );
        if (heartbeatData) {
          const hb = InstanceHeartbeatService.parseRecord(heartbeatData);
          if (hb && !InstanceHeartbeatService.isStale(hb, ctx.staleTtlMs)) {
            send(socket, {
              type: "run.elsewhere",
              id: requestId,
              payload: {
                runId: payload.runId,
                instanceId: result.instanceId,
              },
            });
            return;
          }
        }
        send(socket, {
          type: "run.interrupted",
          id: requestId,
          payload: {
            runId: payload.runId,
            instanceId: result.instanceId,
            reason: "instance_dead",
          },
        });
        return;
      }
    }
    sendError(
      socket,
      requestId,
      "not_found",
      `No active run with id '${payload.runId}'`,
    );
    return;
  }

  const resourceKind = run.kind === "method-run" ? "model" : "workflow";
  const localFields = await resolveRunFields(
    ctx,
    resourceKind,
    run.resourceName,
  );
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "run",
      {
        kind: resourceKind,
        name: run.resourceName,
        fields: localFields,
      },
      ctx,
    ).allowed
  ) return;

  send(socket, {
    type: "run.attached",
    id: requestId,
    payload: {
      runId: run.runId,
      kind: run.kind,
      startedAt: run.startedAt.toISOString(),
    },
  });

  await subscribeUntilDetach(
    run.buffer,
    socket,
    requestId,
    controller,
    payload.afterSeq ?? 0,
  );
}

// ── Data handlers ─────────────────────────────────────────────────────

// ── Model handlers ────────────────────────────────────────────────────

// ── Workflow handlers ─────────────────────────────────────────────────

// ── Vault handlers ────────────────────────────────────────────────────

// ── Audit / Summary handlers ──────────────────────────────────────────

// ── Report handlers ───────────────────────────────────────────────────

// ── Model operation handlers ─────────────────────────────────────────

// ── Workflow operation handlers ──────────────────────────────────────

// ── Vault operation handlers ─────────────────────────────────────────

// ── Server admin handlers ────────────────────────────────────────────

// ── Extension handlers ───────────────────────────────────────────────

// ── Doctor handlers ──────────────────────────────────────────────────
