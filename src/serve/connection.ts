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
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { RunCancelRegistry } from "./run_cancel_registry.ts";
import {
  auditTimeline,
  consumeStream,
  createAuditTimelineDeps,
  createDataDeleteDeps,
  createDataGetDeps,
  createDataListDeps,
  createDataRenameDeps,
  createDataVersionsDeps,
  createDoctorSecretsDeps,
  createDoctorVaultsDeps,
  createExtensionInfoDeps,
  createExtensionListDeps,
  createLibSwampContext,
  createModelCreateDeps,
  createModelDeleteDeps,
  createModelEvaluateDeps,
  createModelGetDeps,
  createModelMethodDescribeDeps,
  createModelMethodHistoryLogsDeps,
  createModelOutputDataDeps,
  createModelOutputGetDeps,
  createModelOutputLogsDeps,
  createModelValidateDeps,
  createSummariseDeps,
  createVaultAnnotateDeps,
  createVaultDeleteDeps,
  createVaultDescribeDeps,
  createVaultGetDeps,
  createVaultInspectDeps,
  createVaultListKeysDeps,
  createVaultPutDeps,
  createWorkerListDeps,
  createWorkflowApproveDeps,
  createWorkflowGetDeps,
  createWorkflowHistoryGetDeps,
  createWorkflowHistoryLogsDeps,
  createWorkflowRejectDeps,
  dataDelete,
  dataGet,
  dataList,
  dataQuery,
  type DataQueryDeps,
  dataRename,
  dataSearch,
  type DataSearchDeps,
  dataVersions,
  doctorSecrets,
  doctorVaults,
  doctorWorkflows,
  type DoctorWorkflowsDeps,
  extensionInfo,
  extensionList,
  extensionSearch,
  type ExtensionSearchDeps,
  mapWorkflowExecutionEvent,
  modelCreate,
  modelDelete,
  modelDeletePreview,
  modelEvaluate,
  modelGet,
  modelMethodDescribe,
  modelMethodHistoryLogs,
  modelMethodRun,
  modelOutputData,
  modelOutputGet,
  modelOutputLogs,
  modelOutputSearch,
  type ModelOutputSearchDeps,
  modelSearch,
  type ModelSearchDeps,
  modelValidate,
  parseDuration,
  reportDescribe,
  type ReportDescribeDeps,
  reportGet,
  type ReportGetDeps,
  reportSearch,
  type ReportSearchDeps,
  reportTypeSearch,
  type ReportTypeSearchDeps,
  summarise,
  vaultAnnotate,
  vaultDelete,
  vaultDeletePreview,
  vaultDescribe,
  vaultGet,
  vaultInspect,
  vaultListKeys,
  vaultPut,
  vaultPutPreview,
  vaultSearch,
  type VaultSearchDeps,
  workerList,
  workflowApprove,
  workflowGet,
  workflowHistoryGet,
  workflowHistoryLogs,
  workflowHistorySearch,
  type WorkflowHistorySearchDeps,
  workflowReject,
  type WorkflowRunEvent,
  workflowRunSearch,
  type WorkflowRunSearchDeps,
  workflowSchema,
  workflowSearch,
  type WorkflowSearchDeps,
} from "../libswamp/mod.ts";
import {
  createModelMethodRunDeps,
  createWorkflowRunDeps,
  executeWorkflowWithLocks,
} from "./deps.ts";
import { serializeEvent } from "./serializer.ts";
import type {
  AccessCanIPayload,
  AccessCheckPayload,
  AccessGrantListPayload,
  AccessGroupListPayload,
  AuditTimelinePayload,
  DataDeletePayload,
  DataGetPayload,
  DataListPayload,
  DataQueryPayload,
  DataRenamePayload,
  DataSearchPayload,
  DataVersionsPayload,
  ExtensionInfoPayload,
  ExtensionRmPayload,
  ExtensionSearchPayload,
  ModelCreatePayload,
  ModelDeletePayload,
  ModelEvaluatePayload,
  ModelGetPayload,
  ModelMethodDescribePayload,
  ModelMethodHistoryGetPayload,
  ModelMethodHistoryLogsPayload,
  ModelMethodHistorySearchPayload,
  ModelMethodRunPayload,
  ModelOutputDataPayload,
  ModelOutputGetPayload,
  ModelOutputLogsPayload,
  ModelOutputSearchPayload,
  ModelSearchPayload,
  ModelValidatePayload,
  ReportDescribePayload,
  ReportGetPayload,
  ReportSearchPayload,
  ReportTypeSearchPayload,
  ServerMessage,
  ServerRequest,
  SummarisePayload,
  VaultAnnotatePayload,
  VaultDeletePayload,
  VaultDescribePayload,
  VaultGetPayload,
  VaultInspectPayload,
  VaultListKeysPayload,
  VaultPutPayload,
  VaultSearchPayload,
  WorkflowApprovePayload,
  WorkflowGetPayload,
  WorkflowHistoryGetPayload,
  WorkflowHistoryLogsPayload,
  WorkflowHistorySearchPayload,
  WorkflowRejectPayload,
  WorkflowResumePayload,
  WorkflowRunPayload,
  WorkflowRunSearchPayload,
  WorkflowSchemaPayload,
  WorkflowSearchPayload,
} from "./protocol.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { createDefinitionId } from "../domain/definitions/definition.ts";
import { acquireModelLocks, acquireVaultSync } from "../cli/repo_context.ts";
import { resolveSuspendedRun } from "../domain/workflows/suspended_run_resolver.ts";
import { createWorkflowId } from "../domain/workflows/workflow_id.ts";
import {
  type StepLockHook,
  WorkflowExecutionService,
} from "../domain/workflows/execution_service.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import { getReportTypes } from "../domain/reports/report_types.ts";
import { RepoMarkerRepository } from "../infrastructure/persistence/repo_marker_repository.ts";
import { resolvePrimaryTool } from "../domain/repo/primary_tool.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { WorkerGateway } from "./worker_gateway.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import type { ServeAuthConfig } from "../domain/access/serve_auth_config.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
  GrantSchema,
} from "../domain/models/access/grant_model.ts";
import {
  type Group,
  GROUP_MODEL_TYPE,
  GroupSchema,
} from "../domain/models/access/group_model.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../domain/models/access/server_token_model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import {
  parsePrincipal,
  type Principal,
  principalToString,
} from "../domain/access/principal.ts";
import { type Action, ActionSchema } from "../domain/access/action.ts";
import { parseResourceSelector } from "../domain/access/resource_selector.ts";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import { modelRegistry } from "../domain/models/model.ts";

const MAX_ACTIVE_REQUESTS = 100;
const MAX_SESSION_MS = 8 * 60 * 60 * 1000; // 8 hours

const MAX_CLIENT_ERROR_LENGTH = 200;

const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'`(])\/(?:opt|home|var|tmp|etc|usr|root|Users|private|proc|sys|mnt|srv|run)\//;
const WINDOWS_PATH_PATTERN = /[A-Z]:\\/i;
const SWAMP_INTERNAL_PATH_PATTERN = /\/.swamp\//;

export function sanitizeErrorForClient(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (
    ABSOLUTE_PATH_PATTERN.test(raw) ||
    WINDOWS_PATH_PATTERN.test(raw) ||
    SWAMP_INTERNAL_PATH_PATTERN.test(raw)
  ) {
    return "An internal error occurred";
  }
  if (raw.length > MAX_CLIENT_ERROR_LENGTH) {
    return raw.slice(0, MAX_CLIENT_ERROR_LENGTH) + "...";
  }
  return raw;
}

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

const MAX_PREDICATE_LENGTH = 4096;
const MAX_QUERY_RESULTS = 10_000;
const DEFAULT_QUERY_LIMIT = 1000;

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
    limit: z.number().int().positive().max(10_000).optional(),
  }).optional(),
});

const WorkflowSchemaRequestSchema = z.object({
  type: z.literal("workflow.schema"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string(),
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
    decidedBy: z.string().optional(),
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
    decidedBy: z.string().optional(),
  }),
});

const WorkflowResumeRequestSchema = z.object({
  type: z.literal("workflow.resume"),
  id: z.string().min(1).max(256),
  payload: z.object({
    workflowIdOrName: z.string(),
    runId: z.string().optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
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
});

const DatastoreStatusRequestSchema = z.object({
  type: z.literal("datastore.status"),
  id: z.string().min(1).max(256),
});

// ── Extension operation schemas ─────────────────────────────────────

const ExtensionListRequestSchema = z.object({
  type: z.literal("extension.list"),
  id: z.string().min(1).max(256),
});

const ExtensionSearchRequestSchema = z.object({
  type: z.literal("extension.search"),
  id: z.string().min(1).max(256),
  payload: z.object({
    query: z.string().optional(),
    collective: z.string().optional(),
    platform: z.string().optional(),
    label: z.string().optional(),
    contentType: z.string().optional(),
    channel: z.string().optional(),
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

const ServerRequestSchema = z.discriminatedUnion("type", [
  WorkflowRunRequestSchema,
  ModelMethodRunRequestSchema,
  AccessGrantListRequestSchema,
  AccessGroupListRequestSchema,
  AccessCheckRequestSchema,
  AccessCanIRequestSchema,
  AccessReloadRequestSchema,
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
  WorkflowApproveRequestSchema,
  WorkflowRejectRequestSchema,
  WorkflowResumeRequestSchema,
  VaultDescribeRequestSchema,
  VaultInspectRequestSchema,
  VaultListKeysRequestSchema,
  VaultSearchRequestSchema,
  VaultAnnotateRequestSchema,
  WorkerListRequestSchema,
  DatastoreStatusRequestSchema,
  ExtensionListRequestSchema,
  ExtensionSearchRequestSchema,
  ExtensionInfoRequestSchema,
  ExtensionInstallRequestSchema,
  ExtensionRmRequestSchema,
  ExtensionOutdatedRequestSchema,
  DoctorVaultsRequestSchema,
  DoctorSecretsRequestSchema,
  DoctorWorkflowsRequestSchema,
  DoctorExtensionsRequestSchema,
  CancelRequestSchema,
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

const logger = getSwampLogger(["serve", "connection"]);

export interface ConnectionContext {
  repoDir: string;
  repoContext: RepositoryContext;
  datastoreConfig: DatastoreConfig;
  /**
   * Shared sync service instance. Same one the repo context's markDirty hook
   * references — see `design/datastores.md`. Undefined for filesystem
   * datastores or custom datastores without a cache.
   */
  syncService?: DatastoreSyncService;
  /**
   * Remote-execution worker gateway. When present, `rpc.*` frames on this
   * socket are routed to it (worker enrollment and capability verbs); the
   * legacy client protocol on the same listener is unaffected. See
   * design/remote-execution.md.
   */
  workerGateway?: WorkerGateway;
  policySnapshotLoader?: PolicySnapshotLoader;
  authConfig: ServeAuthConfig;
  cancelRegistry?: RunCancelRegistry;
}

export function handleConnection(
  socket: WebSocket,
  ctx: ConnectionContext,
  principal: Principal | null,
): void {
  const activeRequests = new Map<string, AbortController>();
  const workerAttachment = ctx.workerGateway?.attachTransport({
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
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
    handleMessage(socket, ctx, activeRequests, event, principal);
  };

  socket.onclose = () => {
    if (sessionTimeout) clearTimeout(sessionTimeout);
    workerAttachment?.closed();
    for (const controller of activeRequests.values()) {
      controller.abort();
    }
    activeRequests.clear();
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
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data as string);
  } catch {
    sendError(socket, "unknown", "invalid_request", "Invalid JSON");
    return;
  }

  const validated = validateServerRequest(parsed);
  if (typeof validated === "string") {
    sendError(socket, "unknown", "invalid_request", validated);
    return;
  }

  const request: ServerRequest = validated;

  if (request.type === "cancel") {
    const controller = activeRequests.get(request.id);
    if (controller) {
      controller.abort();
    }
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

  let task: Promise<void>;
  switch (request.type) {
    case "workflow.run":
      task = handleWorkflowRun(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.method.run":
      task = handleModelMethodRun(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "access.grant.list":
      task = handleAccessGrantList(
        socket,
        ctx,
        request.id,
        principal,
        request.payload,
      );
      break;
    case "access.group.list":
      task = handleAccessGroupList(
        socket,
        ctx,
        request.id,
        principal,
        request.payload,
      );
      break;
    case "access.check":
      task = handleAccessCheck(
        socket,
        ctx,
        request.id,
        request.payload,
        principal,
      );
      break;
    case "access.can-i":
      task = handleAccessCanI(
        socket,
        ctx,
        request.id,
        request.payload,
        principal,
      );
      break;
    case "access.reload":
      task = handleAccessReload(socket, ctx, request.id, principal);
      break;
    case "data.get":
      task = handleDataGet(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "data.query":
      task = handleDataQuery(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "data.list":
      task = handleDataList(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "data.search":
      task = handleDataSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "data.versions":
      task = handleDataVersions(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "data.delete":
      task = handleDataDelete(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "data.rename":
      task = handleDataRename(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.search":
      task = handleModelSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "model.method.describe":
      task = handleModelMethodDescribe(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "workflow.search":
      task = handleWorkflowSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "vault.get":
      task = handleVaultGet(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "vault.put":
      task = handleVaultPut(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "vault.delete":
      task = handleVaultDelete(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "audit.timeline":
      task = handleAuditTimeline(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "summarise":
      task = handleSummarise(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "report.get":
      task = handleReportGet(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "report.search":
      task = handleReportSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "report.describe":
      task = handleReportDescribe(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "report.type.search":
      task = handleReportTypeSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "model.get":
      task = handleModelGet(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.create":
      task = handleModelCreate(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.delete":
      task = handleModelDelete(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.output.get":
      task = handleModelOutputGet(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.output.data":
      task = handleModelOutputData(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.output.logs":
      task = handleModelOutputLogs(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.output.search":
      task = handleModelOutputSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "model.method.history.get":
      task = handleModelMethodHistoryGet(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.method.history.logs":
      task = handleModelMethodHistoryLogs(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "model.method.history.search":
      task = handleModelMethodHistorySearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "model.validate":
      task = handleModelValidate(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "model.evaluate":
      task = handleModelEvaluate(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "workflow.get":
      task = handleWorkflowGet(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "workflow.history.get":
      task = handleWorkflowHistoryGet(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "workflow.history.logs":
      task = handleWorkflowHistoryLogs(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "workflow.history.search":
      task = handleWorkflowHistorySearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "workflow.run.search":
      task = handleWorkflowRunSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "workflow.schema":
      task = handleWorkflowSchema(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "workflow.approve":
      task = handleWorkflowApprove(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "workflow.reject":
      task = handleWorkflowReject(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "workflow.resume":
      task = handleWorkflowResume(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "vault.describe":
      task = handleVaultDescribe(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "vault.inspect":
      task = handleVaultInspect(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "vault.list-keys":
      task = handleVaultListKeys(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "vault.search":
      task = handleVaultSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "vault.annotate":
      task = handleVaultAnnotate(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "worker.list":
      task = handleWorkerList(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "datastore.status":
      task = handleDatastoreStatus(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "extension.list":
      task = handleExtensionList(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "extension.search":
      task = handleExtensionSearch(
        socket,
        ctx,
        request.id,
        controller,
        principal,
        request.payload,
      );
      break;
    case "extension.info":
      task = handleExtensionInfo(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "extension.install":
      task = handleExtensionInstall(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "extension.rm":
      task = handleExtensionRm(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
        principal,
      );
      break;
    case "extension.outdated":
      task = handleExtensionOutdated(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "doctor.vaults":
      task = handleDoctorVaults(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "doctor.secrets":
      task = handleDoctorSecrets(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "doctor.workflows":
      task = handleDoctorWorkflows(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "doctor.extensions":
      task = handleDoctorExtensions(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
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

// SECURITY: Authorization must operate on canonical (normalized) model types,
// never raw client input. ModelType.normalize() applies lowercasing, separator
// canonicalization (:: . whitespace → /), and deduplication. Any raw typeArg
// that normalizes to an access-control model type must require admin authority.
function isAccessModelType(
  typeArg: string | undefined,
  resolvedType: string | undefined,
): boolean {
  const grantType = GRANT_MODEL_TYPE.normalized;
  const groupType = GROUP_MODEL_TYPE.normalized;
  const serverTokenType = SERVER_TOKEN_MODEL_TYPE.normalized;
  if (typeArg) {
    const stripped = typeArg.startsWith("@") ? typeArg.slice(1) : typeArg;
    const normalized = ModelType.create(stripped).normalized;
    if (
      normalized === grantType || normalized === groupType ||
      normalized === serverTokenType
    ) return true;
  }
  if (resolvedType) {
    if (
      resolvedType === grantType || resolvedType === groupType ||
      resolvedType === serverTokenType
    ) return true;
  }
  return false;
}

function authorizeOrReject(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
): boolean {
  if (ctx.authConfig.mode === "none") return true;

  if (!ctx.policySnapshotLoader) {
    sendError(
      socket,
      requestId,
      "access_not_configured",
      "Authorization enforcement is enabled but no policy snapshot is available",
    );
    return false;
  }

  if (!principal) {
    sendError(
      socket,
      requestId,
      "unauthorized",
      `Access denied: no authenticated principal for '${action}' on ${resource.kind}:${resource.name}`,
    );
    return false;
  }

  const service = ctx.policySnapshotLoader.decisionService;
  const decision = service.decide(
    { principal, collectives: [] },
    action,
    resource,
  );

  if (decision && decision.effect === "allow") return true;

  if (!decision) {
    const adminDecision = service.decide(
      { principal, collectives: [] },
      "admin",
      { kind: "access", name: "*", fields: {} },
    );
    if (adminDecision && adminDecision.effect === "allow") return true;
  }

  const principalStr = principalToString(principal);
  if (decision && decision.effect === "deny") {
    sendError(
      socket,
      requestId,
      "unauthorized",
      `Access denied: ${principalStr} is explicitly denied '${action}' on ${resource.kind}:${resource.name}`,
    );
  } else {
    sendError(
      socket,
      requestId,
      "unauthorized",
      `Access denied: ${principalStr} does not have '${action}' on ${resource.kind}:${resource.name}`,
    );
  }
  return false;
}

async function handleWorkflowRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowRunPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "run", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: { name: payload.workflowIdOrName },
    }, ctx)
  ) return;

  let registeredRunId: string | undefined;
  try {
    await executeWorkflowWithLocks(
      ctx.repoDir,
      ctx.repoContext,
      ctx.datastoreConfig,
      {
        workflowIdOrName: payload.workflowIdOrName,
        inputs: payload.inputs,
        lastEvaluated: payload.lastEvaluated,
        verbose: payload.verbose,
        runtimeTags: payload.runtimeTags,
      },
      controller.signal,
      (event) => {
        if (
          event.kind === "started" && ctx.cancelRegistry
        ) {
          const startedEvent = event as { runId: string };
          registeredRunId = startedEvent.runId;
          ctx.cancelRegistry.register(
            "workflow-run",
            registeredRunId,
            controller,
          );
        }
        if (socket.readyState !== WebSocket.OPEN) return;
        const serialized = serializeEvent(
          event as { kind: string; [key: string]: unknown },
        );
        send(socket, { type: "event", id: requestId, event: serialized });
      },
      ctx.syncService,
    );
    send(socket, { type: "done", id: requestId });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else {
      const message = sanitizeErrorForClient(error);
      sendError(socket, requestId, "workflow_execution_failed", message);
    }
  } finally {
    if (registeredRunId && ctx.cancelRegistry) {
      ctx.cancelRegistry.deregister("workflow-run", registeredRunId);
    }
  }
}

async function handleModelMethodRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodRunPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  let flushLocks: (() => Promise<void>) | null = null;

  try {
    // Pre-lookup for per-model lock acquisition
    const preResult = await findDefinitionByIdOrName(
      ctx.repoContext.definitionRepo,
      payload.modelIdOrName,
    );

    const modelFields: Record<string, unknown> = {};
    if (preResult) {
      modelFields.modelType = preResult.type.normalized;
      modelFields.name = preResult.definition.name;
      const tags = preResult.definition.tags;
      if (tags && Object.keys(tags).length > 0) modelFields.tags = tags;
    }

    if (isAccessModelType(payload.typeArg, preResult?.type.normalized)) {
      if (
        !authorizeOrReject(socket, requestId, principal, "admin", {
          kind: "access",
          name: "*",
          fields: modelFields,
        }, ctx)
      ) return;
    } else {
      if (
        !authorizeOrReject(socket, requestId, principal, "run", {
          kind: "model",
          name: payload.modelIdOrName,
          fields: modelFields,
        }, ctx)
      ) return;

      // SECURITY: When typeArg is present, the execution path resolves the model
      // from typeArg, not modelIdOrName. Authorize the execution target separately
      // to prevent a mismatch bypass where a user authorized for one model supplies
      // a different typeArg (e.g. command/shell) to execute an unauthorized model.
      if (payload.typeArg) {
        const stripped = payload.typeArg.startsWith("@")
          ? payload.typeArg.slice(1)
          : payload.typeArg;
        const executionTarget = ModelType.create(stripped).normalized;
        if (
          !authorizeOrReject(socket, requestId, principal, "run", {
            kind: "model",
            name: executionTarget,
            fields: {},
          }, ctx)
        ) return;
      }
    }

    if (preResult) {
      const lockResult = await acquireModelLocks(
        ctx.datastoreConfig,
        [{
          modelType: preResult.type.normalized,
          modelId: preResult.definition.id,
        }],
        ctx.repoDir,
        ctx.syncService,
        ctx.repoContext.catalogStore,
      );
      if (lockResult.synced) ctx.repoContext.catalogStore.invalidate();
      flushLocks = lockResult.flush;
    }

    const isDirectExecution = payload.typeArg !== undefined;
    const deps = await createModelMethodRunDeps(
      ctx.repoDir,
      ctx.repoContext,
      { directExecution: isDirectExecution },
    );
    const libCtx = createLibSwampContext({ signal: controller.signal });

    // Register method run in cancel registry using the requestId as executionId
    if (ctx.cancelRegistry) {
      ctx.cancelRegistry.register("method-run", requestId, controller);
    }

    for await (
      const event of modelMethodRun(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        methodName: payload.methodName,
        inputs: payload.inputs ?? {},
        lastEvaluated: payload.lastEvaluated ?? false,
        runtimeTags: payload.runtimeTags,
        typeArg: payload.typeArg,
        definitionName: payload.definitionName,
        skipAllReports: isDirectExecution,
      })
    ) {
      if (socket.readyState !== WebSocket.OPEN) break;
      const serialized = serializeEvent(
        event as { kind: string; [key: string]: unknown },
      );
      send(socket, { type: "event", id: requestId, event: serialized });
    }
    send(socket, { type: "done", id: requestId });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else {
      const message = sanitizeErrorForClient(error);
      sendError(
        socket,
        requestId,
        "method_execution_failed",
        message,
      );
    }
  } finally {
    if (ctx.cancelRegistry) {
      ctx.cancelRegistry.deregister("method-run", requestId);
    }
    if (flushLocks) {
      try {
        await flushLocks();
      } catch (releaseError) {
        logger.warn("Failed to release locks: {error}", {
          error: releaseError instanceof Error
            ? releaseError.message
            : String(releaseError),
        });
      }
    }
  }
}

async function handleAccessGrantList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
  payload?: AccessGrantListPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "access",
      name: "grant",
      fields: {},
    }, ctx)
  ) return;

  try {
    await modelRegistry.ensureLoaded();
    const dataItems = await ctx.repoContext.unifiedDataRepo.findAllForType(
      GRANT_MODEL_TYPE,
    );

    let results: { grant: Grant; instanceName: string }[] = [];
    for (const { data, modelType, modelId } of dataItems) {
      if (data.isRenamed || data.isDeleted) continue;
      const content = await ctx.repoContext.unifiedDataRepo.getContent(
        modelType,
        modelId,
        data.name,
      );
      if (!content) continue;
      let attrs: Record<string, unknown>;
      try {
        attrs = JSON.parse(new TextDecoder().decode(content)) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }
      const parsed = GrantSchema.safeParse(attrs);
      if (parsed.success && parsed.data.state === "active") {
        results.push({
          grant: parsed.data,
          instanceName: data.tags["modelName"] ?? "",
        });
      }
    }

    if (payload?.subject) {
      results = results.filter((r) =>
        `${r.grant.subject.kind}:${r.grant.subject.name}` === payload.subject
      );
    }
    if (payload?.resource) {
      const sel = parseResourceSelector(payload.resource);
      results = results.filter((r) =>
        r.grant.resource.kind === sel.kind &&
        r.grant.resource.pattern === sel.pattern
      );
    }

    send(socket, {
      type: "access.grant.list",
      id: requestId,
      payload: {
        grants: results.map((r) => ({
          ...r.grant,
          instanceName: r.instanceName,
        })) as unknown as Record<string, unknown>[],
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_grant_list_failed", message);
  }
}

async function handleAccessGroupList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
  payload?: AccessGroupListPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "access",
      name: "group",
      fields: {},
    }, ctx)
  ) return;

  try {
    await modelRegistry.ensureLoaded();
    const dataItems = await ctx.repoContext.unifiedDataRepo.findAllForType(
      GROUP_MODEL_TYPE,
    );

    let groups: Group[] = [];
    for (const { data, modelType, modelId } of dataItems) {
      if (data.isRenamed || data.isDeleted) continue;
      const content = await ctx.repoContext.unifiedDataRepo.getContent(
        modelType,
        modelId,
        data.name,
      );
      if (!content) continue;
      let attrs: Record<string, unknown>;
      try {
        attrs = JSON.parse(new TextDecoder().decode(content)) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }
      const parsed = GroupSchema.safeParse(attrs);
      if (parsed.success) {
        groups.push(parsed.data);
      }
    }

    if (payload?.name) {
      groups = groups.filter((g) => g.name === payload.name);
    }

    send(socket, {
      type: "access.group.list",
      id: requestId,
      payload: {
        groups: groups as unknown as Record<string, unknown>[],
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_group_list_failed", message);
  }
}

function handleAccessCheck(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: AccessCheckPayload,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  try {
    if (!ctx.policySnapshotLoader) {
      sendError(
        socket,
        requestId,
        "access_not_configured",
        "Access control is not configured on this server",
      );
      return Promise.resolve();
    }

    const principal = parsePrincipal(payload.subject);
    const actionResult = ActionSchema.safeParse(payload.action);
    if (!actionResult.success) {
      sendError(
        socket,
        requestId,
        "invalid_action",
        `Invalid action "${payload.action}": must be one of run, read, write, admin`,
      );
      return Promise.resolve();
    }

    const resource = parseResourceSelector(payload.resource);
    const collectives = payload.collectives ?? [];

    const service = ctx.policySnapshotLoader.decisionService;
    const decisions = service.explain(
      { principal, collectives },
      actionResult.data,
      { kind: resource.kind, name: resource.pattern, fields: {} },
    );

    send(socket, {
      type: "access.check",
      id: requestId,
      payload: {
        subject: payload.subject,
        action: payload.action,
        resource: payload.resource,
        collectives,
        decisions: decisions as unknown as Record<string, unknown>[],
      },
    });
    return Promise.resolve();
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_check_failed", message);
    return Promise.resolve();
  }
}

function handleAccessCanI(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: AccessCanIPayload,
  principal: Principal | null,
): Promise<void> {
  if (!principal) {
    sendError(
      socket,
      requestId,
      "unauthorized",
      "can-i requires an authenticated connection — use --token or swamp auth server-login",
    );
    return Promise.resolve();
  }

  try {
    if (!ctx.policySnapshotLoader) {
      sendError(
        socket,
        requestId,
        "access_not_configured",
        "Access control is not configured on this server",
      );
      return Promise.resolve();
    }

    const snapshot = ctx.policySnapshotLoader.snapshot;
    const collectives = payload.collectives ?? [];
    const accessPrincipal = { principal, collectives };
    const principalStr = principalToString(principal);

    if (payload.action && payload.resource) {
      const actionResult = ActionSchema.safeParse(payload.action);
      if (!actionResult.success) {
        sendError(
          socket,
          requestId,
          "invalid_action",
          `Invalid action "${payload.action}": must be one of run, read, write, admin`,
        );
        return Promise.resolve();
      }

      const resource = parseResourceSelector(payload.resource);
      const service = ctx.policySnapshotLoader.decisionService;
      const decisions = service.explain(
        accessPrincipal,
        actionResult.data,
        { kind: resource.kind, name: resource.pattern, fields: {} },
      );

      send(socket, {
        type: "access.can-i",
        id: requestId,
        payload: {
          principal: principalStr,
          decisions: decisions.map((d) => ({
            action: payload.action!,
            resource: payload.resource!,
            effect: d.effect,
            grantId: d.grantId,
            via: `${d.subject.kind}:${d.subject.name}`,
            ...(d.condition ? { condition: d.condition } : {}),
          })),
        },
      });
    } else {
      const subjects: string[] = [principalStr];
      const localGroups = snapshot.groupsForPrincipal(principalStr);
      for (const groupName of localGroups) {
        subjects.push(`group:${groupName}`);
      }
      for (const collective of collectives) {
        subjects.push(`idp-group:${collective}`);
      }

      const grants = snapshot.grantsForSubjects(subjects);
      send(socket, {
        type: "access.can-i",
        id: requestId,
        payload: {
          principal: principalStr,
          decisions: grants.flatMap((g) =>
            g.actions.map((a) => ({
              action: a,
              resource: `${g.resource.kind}:${g.resource.pattern}`,
              effect: g.effect,
              grantId: g.id,
              via: `${g.subject.kind}:${g.subject.name}`,
              ...(g.condition ? { condition: g.condition } : {}),
            }))
          ),
        },
      });
    }
    return Promise.resolve();
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_can_i_failed", message);
    return Promise.resolve();
  }
}

async function handleAccessReload(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    if (!ctx.policySnapshotLoader) {
      sendError(
        socket,
        requestId,
        "access_not_configured",
        "Access control is not configured on this server",
      );
      return;
    }

    const result = await ctx.policySnapshotLoader.loadWithCounts();

    send(socket, {
      type: "access.reload",
      id: requestId,
      payload: {
        success: true,
        grantCount: result.grantCount,
        groupCount: result.groupCount,
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_reload_failed", message);
  }
}

// ── Data handlers ─────────────────────────────────────────────────────

async function handleDataGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const resourceName = payload.modelIdOrName ?? "*";
  const dataFields: Record<string, unknown> = {};
  if (payload.modelIdOrName) dataFields.name = payload.modelIdOrName;
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: resourceName,
      fields: dataFields,
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataGetDeps(
      ctx.repoDir,
      undefined,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataGet(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        dataName: payload.dataName,
        workflowName: payload.workflowName,
        runId: payload.runId,
        version: payload.version,
        includeContent: payload.includeContent ?? true,
        repoDir: ctx.repoDir,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Data not found");
      return;
    }

    send(socket, {
      type: "data.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_get_failed", message);
  }
}

async function handleDataQuery(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataQueryPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const queryService = ctx.repoContext.dataQueryService;
    const deps: DataQueryDeps = {
      query: (pred, opts) => queryService.query(pred, opts),
    };

    const limit = Math.min(
      payload.limit ?? DEFAULT_QUERY_LIMIT,
      MAX_QUERY_RESULTS,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataQuery(libCtx, deps, {
        predicate: payload.predicate,
        select: payload.select,
        limit,
      }),
      {
        resolving: () => {},
        match: () => {},
        projected_match: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "data.query",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_query_failed", message);
  }
}

async function handleDataList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataListPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const resourceName = payload.modelIdOrName ?? "*";
  const listFields: Record<string, unknown> = {};
  if (payload.modelIdOrName) listFields.name = payload.modelIdOrName;
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: resourceName,
      fields: listFields,
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataListDeps(
      ctx.repoDir,
      undefined,
      ctx.repoContext.unifiedDataRepo,
      undefined,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataList(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        workflowName: payload.workflowName,
        runId: payload.runId,
        typeFilter: payload.typeFilter,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "No data found");
      return;
    }

    send(socket, {
      type: "data.list",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_list_failed", message);
  }
}

async function handleDataSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: DataSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const definitionRepo = ctx.repoContext.definitionRepo;
    const dataRepo = ctx.repoContext.unifiedDataRepo;

    const deps: DataSearchDeps = {
      findAllGlobal: () => dataRepo.findAllGlobal(),
      findDefinitionById: (type, defId) =>
        definitionRepo.findById(
          ModelType.create(type.normalized),
          createDefinitionId(defId),
        ),
      findDefinitionByIdOrName: (idOrName) =>
        findDefinitionByIdOrName(definitionRepo, idOrName),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataSearch(libCtx, deps, {
        query: payload?.query,
        type: payload?.type,
        lifetime: payload?.lifetime,
        ownerType: payload?.ownerType,
        workflow: payload?.workflow,
        model: payload?.model,
        contentType: payload?.contentType,
        since: payload?.since,
        output: payload?.output,
        run: payload?.run,
        streaming: payload?.streaming,
        tags: payload?.tags,
        limit: payload?.limit ?? 50,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "data.search",
      id: requestId,
      payload: { data: result ?? { items: [], totalCount: 0 } },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_search_failed", message);
  }
}

async function handleDataVersions(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataVersionsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const resourceName = payload.modelIdOrName;
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: resourceName,
      fields: { name: resourceName },
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataVersionsDeps(
      ctx.repoDir,
      undefined,
      ctx.repoContext.unifiedDataRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataVersions(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        dataName: payload.dataName,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Data not found");
      return;
    }

    send(socket, {
      type: "data.versions",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_versions_failed", message);
  }
}

async function handleDataDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: payload.modelIdOrName,
      fields: { name: payload.modelIdOrName },
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataDeleteDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataDelete(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        dataName: payload.dataName,
        version: payload.version,
      }),
      {
        deleting: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Data not found");
      return;
    }

    send(socket, {
      type: "data.delete",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_delete_failed", message);
  }
}

async function handleDataRename(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: DataRenamePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: payload.modelIdOrName,
      fields: { name: payload.modelIdOrName },
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createDataRenameDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataRename(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        oldName: payload.oldName,
        newName: payload.newName,
      }),
      {
        renaming: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "rename_failed", "Rename operation failed");
      return;
    }

    send(socket, {
      type: "data.rename",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "data_rename_failed", message);
  }
}

// ── Model handlers ────────────────────────────────────────────────────

async function handleModelSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: ModelSearchDeps = {
      findAllGlobal: () => ctx.repoContext.definitionRepo.findAllGlobal(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "model.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_search_failed", message);
  }
}

async function handleModelMethodDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload.modelIdOrName,
      fields: {},
    }, ctx)
  ) return;

  try {
    await modelRegistry.ensureLoaded();
    const libCtx = createLibSwampContext();
    const deps = createModelMethodDescribeDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelMethodDescribe(
        libCtx,
        deps,
        payload.modelIdOrName,
        payload.methodName,
      ),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Method not found");
      return;
    }

    send(socket, {
      type: "model.method.describe",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_method_describe_failed", message);
  }
}

// ── Workflow handlers ─────────────────────────────────────────────────

async function handleWorkflowSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: WorkflowSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: WorkflowSearchDeps = {
      findAllWorkflows: () => ctx.repoContext.workflowRepo.findAll(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "workflow.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_search_failed", message);
  }
}

// ── Vault handlers ────────────────────────────────────────────────────

async function handleVaultGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultGetDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultGet(libCtx, deps, payload.vaultNameOrId, payload.vaultType),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Vault not found");
      return;
    }

    send(socket, {
      type: "vault.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_get_failed", message);
  }
}

async function handleVaultPut(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultPutPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (payload.refreshFrom !== undefined || payload.clearRefresh) {
    if (
      !authorizeOrReject(socket, requestId, principal, "admin", {
        kind: "data",
        name: "vault",
        fields: {},
      }, ctx)
    ) return;
  } else {
    if (
      !authorizeOrReject(socket, requestId, principal, "write", {
        kind: "data",
        name: "vault",
        fields: {},
      }, ctx)
    ) return;
  }

  let flush: (() => Promise<void>) | undefined;
  try {
    ({ flush } = await acquireVaultSync(
      ctx.datastoreConfig,
      ctx.syncService,
      ctx.repoDir,
    ));
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_put_failed", message);
    return;
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultPutDeps(ctx.repoDir, ctx.repoContext.eventBus);

    const preview = await vaultPutPreview(
      libCtx,
      deps,
      payload.vaultName,
      payload.key,
    );

    if (preview.secretExists && !payload.force) {
      sendError(
        socket,
        requestId,
        "secret_exists",
        `Secret '${payload.key}' already exists in vault '${payload.vaultName}'. Use --force (-f) to overwrite.`,
      );
      return;
    }

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultPut(libCtx, deps, {
        vaultName: payload.vaultName,
        key: payload.key,
        value: payload.value,
        overwritten: preview.secretExists,
        refreshFrom: payload.refreshFrom,
        refreshTtlMs: payload.refreshTtlMs,
        clearRefresh: payload.clearRefresh,
      }),
      {
        storing: () => {},
        warning: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.put",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else {
      const message = sanitizeErrorForClient(error);
      sendError(socket, requestId, "vault_put_failed", message);
    }
  } finally {
    if (flush) await flush();
  }
}

async function handleVaultDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx)
  ) return;

  let flush: (() => Promise<void>) | undefined;
  try {
    ({ flush } = await acquireVaultSync(
      ctx.datastoreConfig,
      ctx.syncService,
      ctx.repoDir,
    ));
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_delete_failed", message);
    return;
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultDeleteDeps(ctx.repoDir, ctx.repoContext.eventBus);

    const preview = await vaultDeletePreview(
      libCtx,
      deps,
      payload.vaultName,
      payload.key,
    );

    if (!preview.supportsDelete) {
      sendError(
        socket,
        requestId,
        "unsupported",
        `Vault '${payload.vaultName}' (type: ${preview.vaultType}) does not support deleting secrets`,
      );
      return;
    }

    if (!preview.secretExists && !payload.force) {
      sendError(
        socket,
        requestId,
        "not_found",
        `Secret '${payload.key}' not found in vault '${payload.vaultName}'`,
      );
      return;
    }

    if (!preview.secretExists && payload.force) {
      send(socket, {
        type: "vault.delete",
        id: requestId,
        payload: {
          data: {
            vaultName: payload.vaultName,
            secretKey: payload.key,
            vaultType: preview.vaultType,
            noOp: true,
            timestamp: new Date().toISOString(),
          },
        },
      });
      return;
    }

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultDelete(libCtx, deps, {
        vaultName: payload.vaultName,
        key: payload.key,
      }),
      {
        deleting: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.delete",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else {
      const message = sanitizeErrorForClient(error);
      sendError(socket, requestId, "vault_delete_failed", message);
    }
  } finally {
    if (flush) await flush();
  }
}

// ── Audit / Summary handlers ──────────────────────────────────────────

async function handleAuditTimeline(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: AuditTimelinePayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createAuditTimelineDeps(ctx.repoDir);

    const markerRepo = new RepoMarkerRepository();
    const marker = await markerRepo.read(RepoPath.create(ctx.repoDir));
    const configuredTool = resolvePrimaryTool(marker);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      auditTimeline(libCtx, deps, {
        hours: payload?.hours ?? 24,
        showAll: payload?.showAll ?? false,
        sessionId: payload?.sessionId,
        tool: configuredTool,
        includeDiagnostic: payload?.includeDiagnostic ?? false,
      }),
      {
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "audit.timeline",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "audit_timeline_failed", message);
  }
}

async function handleSummarise(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: SummarisePayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createSummariseDeps({
      outputRepo: ctx.repoContext.outputRepo,
      workflowRunRepo: ctx.repoContext.workflowRunRepo,
      dataRepo: ctx.repoContext.unifiedDataRepo,
      definitionRepo: ctx.repoContext.definitionRepo,
      workflowRepo: ctx.repoContext.workflowRepo,
    });

    const sinceLabel = payload?.since ?? "7d";
    const durationMs = parseDuration(sinceLabel);
    const cutoffDate = new Date(Date.now() - durationMs);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      summarise(libCtx, deps, {
        since: cutoffDate,
        sinceLabel,
        limit: payload?.limit,
      }),
      {
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "summarise",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "summarise_failed", message);
  }
}

// ── Report handlers ───────────────────────────────────────────────────

async function handleReportGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ReportGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: ReportGetDeps = {
      findAllGlobal: () => ctx.repoContext.unifiedDataRepo.findAllGlobal(),
      findAllForModel: (type, modelId) =>
        ctx.repoContext.unifiedDataRepo.findAllForModel(type, modelId),
      getContent: (type, modelId, dataName, version) =>
        ctx.repoContext.unifiedDataRepo.getContent(
          type,
          modelId,
          dataName,
          version,
        ),
      lookupDefinition: (idOrName) =>
        findDefinitionByIdOrName(ctx.repoContext.definitionRepo, idOrName),
      lookupDefinitionById: (type, id) =>
        ctx.repoContext.definitionRepo.findById(type, createDefinitionId(id)),
      findWorkflowByName: async (name) => {
        const wf = await ctx.repoContext.workflowRepo.findByName(name);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
      findWorkflowById: async (id) => {
        const all = await ctx.repoContext.workflowRepo.findAll();
        const wf = all.find((w) => w.id === id);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      reportGet(libCtx, deps, {
        reportName: payload.reportName,
        model: payload.model,
        workflow: payload.workflow,
        version: payload.version,
        variant: payload.variant,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Report not found");
      return;
    }

    send(socket, {
      type: "report.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "report_get_failed", message);
  }
}

async function handleReportSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ReportSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    await reportRegistry.ensureLoaded();
    const deps: ReportSearchDeps = {
      findAllGlobal: () => ctx.repoContext.unifiedDataRepo.findAllGlobal(),
      findAllForModel: (type, modelId) =>
        ctx.repoContext.unifiedDataRepo.findAllForModel(type, modelId),
      lookupDefinition: (idOrName) =>
        findDefinitionByIdOrName(ctx.repoContext.definitionRepo, idOrName),
      lookupDefinitionById: (type, id) =>
        ctx.repoContext.definitionRepo.findById(type, createDefinitionId(id)),
      findWorkflowByName: async (name) => {
        const wf = await ctx.repoContext.workflowRepo.findByName(name);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
      findWorkflowById: async (id) => {
        const all = await ctx.repoContext.workflowRepo.findAll();
        const wf = all.find((w) => w.id === id);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
      getReport: async (name) => {
        await reportRegistry.ensureTypeLoaded(name);
        return reportRegistry.get(name);
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      reportSearch(libCtx, deps, {
        query: payload?.query,
        model: payload?.model,
        workflow: payload?.workflow,
        scope: payload?.scope,
        type: payload?.type,
        labels: payload?.labels,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "report.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "report_search_failed", message);
  }
}

async function handleReportDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ReportDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    await reportRegistry.ensureLoaded();
    const libCtx = createLibSwampContext();
    const deps: ReportDescribeDeps = {
      getReport: async (name) => {
        await reportRegistry.ensureTypeLoaded(name);
        return reportRegistry.get(name);
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      reportDescribe(libCtx, deps, payload.reportName),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Report type not found");
      return;
    }

    send(socket, {
      type: "report.describe",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "report_describe_failed", message);
  }
}

async function handleReportTypeSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ReportTypeSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    await reportRegistry.ensureLoaded();
    for (const lazy of reportRegistry.getAllLazy()) {
      await reportRegistry.ensureTypeLoaded(lazy.type);
    }

    const deps: ReportTypeSearchDeps = {
      getReportTypes: () => getReportTypes(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      reportTypeSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "report.type.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "report_type_search_failed", message);
  }
}

// ── Model operation handlers ─────────────────────────────────────────

async function handleModelGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload.modelIdOrName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createModelGetDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelGet(libCtx, deps, payload.modelIdOrName),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Model not found");
      return;
    }

    send(socket, {
      type: "model.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_get_failed", message);
  }
}

async function handleModelCreate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelCreatePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (isAccessModelType(payload.typeArg, undefined)) {
    if (
      !authorizeOrReject(socket, requestId, principal, "admin", {
        kind: "access",
        name: "*",
        fields: {},
      }, ctx)
    ) return;
  } else {
    if (
      !authorizeOrReject(socket, requestId, principal, "write", {
        kind: "model",
        name: payload.name ?? payload.typeArg,
        fields: {},
      }, ctx)
    ) return;
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = await createModelCreateDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelCreate(libCtx, deps, {
        typeArg: payload.typeArg,
        name: payload.name ?? "",
        globalArguments: payload.globalArguments,
      }),
      {
        creating: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "model_create_failed",
        "Model creation failed",
      );
      return;
    }

    send(socket, {
      type: "model.create",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_create_failed", message);
  }
}

async function handleModelDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "model",
      name: payload.modelIdOrName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelDeleteDeps(ctx.repoDir);

    const preview = await modelDeletePreview(
      libCtx,
      deps,
      { modelIdOrName: payload.modelIdOrName, force: payload.force ?? false },
    );

    const hasData = preview.dataArtifactCount > 0 ||
      preview.outputCount > 0;
    if (!payload.force && hasData) {
      sendError(
        socket,
        requestId,
        "has_data",
        `Model has associated data (${preview.dataArtifactCount} artifacts, ${preview.outputCount} outputs). Use force to delete.`,
      );
      return;
    }

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelDelete(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        force: payload.force ?? false,
      }),
      {
        deleting: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "model_delete_failed",
        "Model deletion failed",
      );
      return;
    }

    send(socket, {
      type: "model.delete",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_delete_failed", message);
  }
}

async function handleModelOutputGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload.outputIdOrModelName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createModelOutputGetDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputGet(libCtx, deps, payload.outputIdOrModelName),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Output not found");
      return;
    }

    send(socket, {
      type: "model.output.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_get_failed", message);
  }
}

async function handleModelOutputData(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputDataPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload.outputIdArg,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelOutputDataDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputData(libCtx, deps, {
        outputIdArg: payload.outputIdArg,
        name: payload.name,
        field: payload.field,
        version: payload.version,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Output data not found");
      return;
    }

    send(socket, {
      type: "model.output.data",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_data_failed", message);
  }
}

async function handleModelOutputLogs(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputLogsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload.outputIdArg,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelOutputLogsDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputLogs(libCtx, deps, {
        outputIdArg: payload.outputIdArg,
        tail: payload.tail,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Output logs not found");
      return;
    }

    send(socket, {
      type: "model.output.logs",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_logs_failed", message);
  }
}

async function handleModelOutputSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelOutputSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const outputRepo = ctx.repoContext.outputRepo;
    const definitionRepo = ctx.repoContext.definitionRepo;

    const deps: ModelOutputSearchDeps = {
      findAllOutputsGlobal: () => outputRepo.findAllGlobal(),
      findDefinitionById: (type, definitionId) =>
        definitionRepo.findById(
          ModelType.create(type.normalized),
          createDefinitionId(definitionId),
        ),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "model.output.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_search_failed", message);
  }
}

async function handleModelMethodHistoryGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodHistoryGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload.outputIdOrModelName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createModelOutputGetDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputGet(libCtx, deps, payload.outputIdOrModelName),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Method history not found");
      return;
    }

    send(socket, {
      type: "model.method.history.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "model_method_history_get_failed",
      message,
    );
  }
}

async function handleModelMethodHistoryLogs(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodHistoryLogsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload.outputIdOrModelName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createModelMethodHistoryLogsDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelMethodHistoryLogs(libCtx, deps, {
        outputIdOrModelName: payload.outputIdOrModelName,
        tail: payload.tail,
        repoDir: ctx.repoDir,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "not_found",
        "Method history logs not found",
      );
      return;
    }

    send(socket, {
      type: "model.method.history.logs",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "model_method_history_logs_failed",
      message,
    );
  }
}

async function handleModelMethodHistorySearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelMethodHistorySearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const outputRepo = ctx.repoContext.outputRepo;
    const definitionRepo = ctx.repoContext.definitionRepo;

    const deps: ModelOutputSearchDeps = {
      findAllOutputsGlobal: () => outputRepo.findAllGlobal(),
      findDefinitionById: (type, definitionId) =>
        definitionRepo.findById(
          ModelType.create(type.normalized),
          createDefinitionId(definitionId),
        ),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "model.method.history.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "model_method_history_search_failed",
      message,
    );
  }
}

async function handleModelValidate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelValidatePayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload?.modelIdOrName ?? "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelValidateDeps(ctx.repoDir, {
      labels: payload?.labels,
      method: payload?.method,
    });

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelValidate(libCtx, deps, {
        modelIdOrName: payload?.modelIdOrName,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "model.validate",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_validate_failed", message);
  }
}

async function handleModelEvaluate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelEvaluatePayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: payload?.modelIdOrName ?? "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelEvaluateDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelEvaluate(libCtx, deps, {
        modelIdOrName: payload?.modelIdOrName,
      }),
      {
        evaluating: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "model.evaluate",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_evaluate_failed", message);
  }
}

// ── Workflow operation handlers ──────────────────────────────────────

async function handleWorkflowGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowGetDeps(ctx.repoContext.workflowRepo);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowGet(libCtx, deps, payload.workflowIdOrName),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Workflow not found");
      return;
    }

    send(socket, {
      type: "workflow.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_get_failed", message);
  }
}

async function handleWorkflowHistoryGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowHistoryGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowHistoryGetDeps(
      ctx.repoDir,
      undefined,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowHistoryGet(libCtx, deps, payload.workflowIdOrName),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "not_found",
        "Workflow history not found",
      );
      return;
    }

    send(socket, {
      type: "workflow.history.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_history_get_failed", message);
  }
}

async function handleWorkflowHistoryLogs(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowHistoryLogsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload.runIdOrWorkflow,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowHistoryLogsDeps(
      ctx.repoDir,
      undefined,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowHistoryLogs(libCtx, deps, {
        runIdOrWorkflow: payload.runIdOrWorkflow,
        tail: payload.tail,
        repoDir: ctx.repoDir,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "not_found",
        "Workflow history logs not found",
      );
      return;
    }

    send(socket, {
      type: "workflow.history.logs",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_history_logs_failed", message);
  }
}

async function handleWorkflowHistorySearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: WorkflowHistorySearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: WorkflowHistorySearchDeps = {
      findAllWorkflows: () => ctx.repoContext.workflowRepo.findAll(),
      findAllRunsByWorkflowId: (id) =>
        ctx.repoContext.workflowRunRepo.findAllByWorkflowId(
          createWorkflowId(id),
        ),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowHistorySearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "workflow.history.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "workflow_history_search_failed",
      message,
    );
  }
}

async function handleWorkflowRunSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: WorkflowRunSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: WorkflowRunSearchDeps = {
      findAllWorkflows: () => ctx.repoContext.workflowRepo.findAll(),
      findAllRunsByWorkflowId: (id) =>
        ctx.repoContext.workflowRunRepo.findAllByWorkflowId(
          createWorkflowId(id),
        ),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowRunSearch(libCtx, deps, {
        query: payload?.query,
        since: payload?.since,
        status: payload?.status,
        workflow: payload?.workflow,
        tags: payload?.tags,
        limit: payload?.limit,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "workflow.run.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_run_search_failed", message);
  }
}

async function handleWorkflowSchema(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _payload: WorkflowSchemaPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowSchema(libCtx),
      {
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "workflow.schema",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_schema_failed", message);
  }
}

async function handleWorkflowApprove(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowApprovePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "run", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowApproveDeps(
      ctx.repoContext.workflowRepo,
      ctx.repoContext.workflowRunRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowApprove(libCtx, deps, {
        workflowIdOrName: payload.workflowIdOrName,
        stepName: payload.stepName,
        reason: payload.reason,
        runId: payload.runId,
        decidedBy: payload.decidedBy,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "workflow_approve_failed",
        "Workflow approval failed",
      );
      return;
    }

    send(socket, {
      type: "workflow.approve",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_approve_failed", message);
  }
}

async function handleWorkflowReject(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowRejectPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "run", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowRejectDeps(
      ctx.repoContext.workflowRepo,
      ctx.repoContext.workflowRunRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowReject(libCtx, deps, {
        workflowIdOrName: payload.workflowIdOrName,
        stepName: payload.stepName,
        reason: payload.reason,
        runId: payload.runId,
        decidedBy: payload.decidedBy,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "workflow_reject_failed",
        "Workflow rejection failed",
      );
      return;
    }

    send(socket, {
      type: "workflow.reject",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_reject_failed", message);
  }
}

async function handleWorkflowResume(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowResumePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "run", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: { name: payload.workflowIdOrName },
    }, ctx)
  ) return;

  try {
    const workflowRepo = ctx.repoContext.workflowRepo;
    const runRepo = ctx.repoContext.workflowRunRepo;

    const { run, workflowName } = await resolveSuspendedRun(
      workflowRepo,
      runRepo,
      payload.workflowIdOrName,
      payload.runId,
    );

    const stepLockHook: StepLockHook = async (modelType, modelId) => {
      const lockResult = await acquireModelLocks(
        ctx.datastoreConfig,
        [{ modelType, modelId }],
        ctx.repoDir,
        ctx.syncService,
        ctx.repoContext.catalogStore,
      );
      if (lockResult.synced) ctx.repoContext.catalogStore.invalidate();
      return lockResult;
    };

    // Ensure model/vault/report registries are loaded (mirrors
    // createWorkflowRunDeps).
    await createWorkflowRunDeps(ctx.repoDir, ctx.repoContext, stepLockHook);

    const resumeInputs = payload.inputs ?? {};
    const service = new WorkflowExecutionService(
      workflowRepo,
      runRepo,
      ctx.repoDir,
      undefined,
      undefined,
      ctx.repoContext.catalogStore,
      undefined,
      ctx.repoContext.markDirty,
      ctx.repoContext.unifiedDataRepo.namespace,
      stepLockHook,
    );

    const resumeGenerator = async function* (): AsyncGenerator<
      WorkflowRunEvent
    > {
      for await (
        const event of service.resume(workflowName, run.id, {
          signal: controller.signal,
          inputs: resumeInputs,
        })
      ) {
        yield mapWorkflowExecutionEvent(event, runRepo);
      }
    };

    for await (const event of resumeGenerator()) {
      if (socket.readyState !== WebSocket.OPEN) break;
      const serialized = serializeEvent(
        event as { kind: string; [key: string]: unknown },
      );
      send(socket, { type: "event", id: requestId, event: serialized });
    }
    send(socket, { type: "done", id: requestId });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else {
      const message = sanitizeErrorForClient(error);
      sendError(socket, requestId, "workflow_resume_failed", message);
    }
  }
}

// ── Vault operation handlers ─────────────────────────────────────────

async function handleVaultDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultDescribeDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultDescribe(libCtx, deps, payload.vaultNameOrId, payload.vaultType),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Vault not found");
      return;
    }

    send(socket, {
      type: "vault.describe",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_describe_failed", message);
  }
}

async function handleVaultInspect(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultInspectPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultInspectDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultInspect(libCtx, deps, payload.vaultName, payload.key),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Secret not found");
      return;
    }

    send(socket, {
      type: "vault.inspect",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_inspect_failed", message);
  }
}

async function handleVaultListKeys(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: VaultListKeysPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createVaultListKeysDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultListKeys(libCtx, deps, {
        vaultName: payload?.vaultName ?? "",
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.list-keys",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_list_keys_failed", message);
  }
}

async function handleVaultSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: VaultSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: VaultSearchDeps = {
      findAllVaults: () => ctx.repoContext.vaultConfigRepo.findAll(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_search_failed", message);
  }
}

async function handleVaultAnnotate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultAnnotatePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultAnnotateDeps(
      ctx.repoDir,
      ctx.repoContext.eventBus,
    );

    // Convert labels from string[] to Record<string,string> if provided
    const labelsRecord: Record<string, string> | undefined = payload.labels
      ? Object.fromEntries(payload.labels.map((l) => [l, ""]))
      : undefined;

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultAnnotate(libCtx, deps, {
        vaultName: payload.vaultName,
        key: payload.key,
        url: payload.url,
        notes: payload.notes,
        labels: labelsRecord,
        removeLabels: payload.removeLabels,
        clear: payload.clear ?? false,
      }),
      {
        annotating: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "vault_annotate_failed",
        "Vault annotation failed",
      );
      return;
    }

    send(socket, {
      type: "vault.annotate",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_annotate_failed", message);
  }
}

// ── Server admin handlers ────────────────────────────────────────────

async function handleWorkerList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkerListDeps(ctx.repoContext.dataQueryService);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workerList(libCtx, deps),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "worker.list",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "worker_list_failed", message);
  }
}

function handleDatastoreStatus(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: datastoreStatus requires a DatastorePathResolver which the
  // ConnectionContext does not currently expose. Send a minimal status
  // response until the resolver is wired through.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "datastore.status is not yet available over the WebSocket API",
  );
  return Promise.resolve();
}

// ── Extension handlers ───────────────────────────────────────────────

async function handleExtensionList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createExtensionListDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      extensionList(libCtx, deps),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.list",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_list_failed", message);
  }
}

async function handleExtensionSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ExtensionSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    // TODO: ExtensionSearchDeps requires an API client with auth identity.
    // The server would need to forward the principal's credentials to the
    // swamp-club API. For now, construct deps without auth.
    const deps: ExtensionSearchDeps = {
      searchExtensions: (_params) => {
        // Until the API client is wired through the serve layer, return
        // an empty result set. A real implementation would use
        // ExtensionApiClient with the principal's identity.
        return Promise.resolve({
          extensions: [],
          meta: { total: 0, page: 1, perPage: 20 },
        });
      },
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      extensionSearch(libCtx, deps, {
        query: payload?.query,
        collective: payload?.collective,
        platform: payload?.platform ? [payload.platform] : undefined,
        label: payload?.label ? [payload.label] : undefined,
        contentType: payload?.contentType ? [payload.contentType] : undefined,
        channel: payload?.channel ? [payload.channel] : undefined,
        sort: payload?.sort,
        perPage: payload?.perPage,
        page: payload?.page,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "extension.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_search_failed", message);
  }
}

async function handleExtensionInfo(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ExtensionInfoPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    // TODO: createExtensionInfoDeps takes apiKey/identity for the
    // swamp-club API. Pass undefined for now until auth forwarding is
    // wired through the serve layer.
    const deps = createExtensionInfoDeps();

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      extensionInfo(libCtx, deps, {
        extensionName: payload.extensionName,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        not_found: () => {},
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "not_found",
        `Extension not found: ${payload.extensionName}`,
      );
      return;
    }

    send(socket, {
      type: "extension.info",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "extension_info_failed", message);
  }
}

function handleExtensionInstall(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: ExtensionInstallDeps requires complex infrastructure wiring
  // (lockfilePath, createInstallContext, etc.) that is not yet available
  // in the serve context. Return not_implemented until wired.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "extension.install is not yet available over the WebSocket API",
  );
  return Promise.resolve();
}

function handleExtensionRm(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _payload: ExtensionRmPayload,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: createExtensionRmDeps requires a lockfilePath resolved from
  // the repo marker. Wire this through ConnectionContext.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "extension.rm is not yet available over the WebSocket API",
  );
  return Promise.resolve();
}

function handleExtensionOutdated(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: extensionOutdated wraps extensionUpdate with checkOnly=true.
  // It requires a lockfilePath and identity for the swamp-club API.
  // Wire these through ConnectionContext.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "extension.outdated is not yet available over the WebSocket API",
  );
  return Promise.resolve();
}

// ── Doctor handlers ──────────────────────────────────────────────────

async function handleDoctorVaults(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createDoctorVaultsDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      doctorVaults(libCtx, deps),
      {
        scanning: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "doctor.vaults",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "doctor_vaults_failed", message);
  }
}

async function handleDoctorSecrets(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createDoctorSecretsDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      doctorSecrets(libCtx, deps),
      {
        scanning: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "doctor.secrets",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "doctor_secrets_failed", message);
  }
}

async function handleDoctorWorkflows(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const workflowsDir = swampPath(ctx.repoDir, SWAMP_SUBDIRS.workflows);

    const deps: DoctorWorkflowsDeps = {
      workflowDirs: [workflowsDir],
      abortSignal: controller.signal,
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      doctorWorkflows(deps),
      {
        "workflow-checked": () => {},
        completed: (e) => {
          result = e.report as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "doctor.workflows",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "doctor_workflows_failed", message);
  }
}

function handleDoctorExtensions(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  // TODO: DoctorExtensionsDeps requires complex infrastructure wiring
  // (registries, lockfileRepository, skillsDir, etc.) that is not yet
  // available in the serve context. Return not_implemented until wired.
  sendError(
    socket,
    requestId,
    "not_implemented",
    "doctor.extensions is not yet available over the WebSocket API",
  );
  return Promise.resolve();
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendError(
  socket: WebSocket,
  id: string,
  code: string,
  message: string,
): void {
  send(socket, { type: "error", id, error: { code, message } });
}
