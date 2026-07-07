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
import {
  handleDataDelete,
  handleDataGet,
  handleDataList,
  handleDataQuery,
  handleDataRename,
  handleDataSearch,
  handleDataVersions,
  handleSummarise,
} from "./handlers/data_handlers.ts";
import {
  handleModelCreate,
  handleModelDelete,
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
  handleModelValidate,
} from "./handlers/model_handlers.ts";
import {
  handleWorkflowApprove,
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
} from "./handlers/workflow_handlers.ts";
import {
  handleVaultAnnotate,
  handleVaultDelete,
  handleVaultDescribe,
  handleVaultGet,
  handleVaultInspect,
  handleVaultListKeys,
  handleVaultPut,
  handleVaultSearch,
} from "./handlers/vault_handlers.ts";
import {
  handleAccessCanI,
  handleAccessCheck,
  handleAccessGrantList,
  handleAccessGroupList,
  handleAccessReload,
} from "./handlers/access_handlers.ts";
import {
  handleReportDescribe,
  handleReportGet,
  handleReportSearch,
  handleReportTypeSearch,
} from "./handlers/report_handlers.ts";
import {
  handleAuditTimeline,
  handleDatastoreStatus,
  handleDoctorExtensions,
  handleDoctorSecrets,
  handleDoctorVaults,
  handleDoctorWorkflows,
  handleExtensionInfo,
  handleExtensionInstall,
  handleExtensionList,
  handleExtensionOutdated,
  handleExtensionRm,
  handleExtensionSearch,
  handleRunDoctor,
  handleRunHistory,
  handleWorkerList,
  handleWorkerQueueList,
  handleWorkerVerify,
} from "./handlers/admin_handlers.ts";
import {
  type ConnectionContext,
  MAX_PREDICATE_LENGTH,
  MAX_QUERY_RESULTS,
  sendError,
} from "./handlers/shared.ts";

export { sanitizeErrorForClient } from "./handlers/shared.ts";
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
  WorkerQueueListRequestSchema,
  WorkerVerifyRequestSchema,
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
  RunHistoryRequestSchema,
  RunDoctorRequestSchema,
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
        request.payload,
      );
      break;
    case "worker.queue.list":
      task = handleWorkerQueueList(
        socket,
        ctx,
        request.id,
        controller,
        principal,
      );
      break;
    case "worker.verify":
      task = handleWorkerVerify(
        socket,
        ctx,
        request.id,
        request.payload,
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
    case "run.history":
      task = Promise.resolve(handleRunHistory(
        socket,
        ctx,
        request.id,
        request.payload,
        principal,
      ));
      break;
    case "run.doctor":
      task = Promise.resolve(handleRunDoctor(
        socket,
        ctx,
        request.id,
        request.payload,
        principal,
      ));
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
