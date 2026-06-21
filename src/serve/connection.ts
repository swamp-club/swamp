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
import {
  auditTimeline,
  consumeStream,
  createAuditTimelineDeps,
  createDataGetDeps,
  createDataListDeps,
  createLibSwampContext,
  createModelMethodDescribeDeps,
  createSummariseDeps,
  createVaultGetDeps,
  createVaultPutDeps,
  dataGet,
  dataList,
  dataQuery,
  type DataQueryDeps,
  modelMethodDescribe,
  modelMethodRun,
  modelSearch,
  type ModelSearchDeps,
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
  vaultGet,
  vaultPut,
  vaultPutPreview,
  workflowSearch,
  type WorkflowSearchDeps,
} from "../libswamp/mod.ts";
import { createModelMethodRunDeps, executeWorkflowWithLocks } from "./deps.ts";
import { serializeEvent } from "./serializer.ts";
import type {
  AccessCanIPayload,
  AccessCheckPayload,
  AccessGrantListPayload,
  AccessGroupListPayload,
  AuditTimelinePayload,
  DataGetPayload,
  DataListPayload,
  DataQueryPayload,
  ModelMethodDescribePayload,
  ModelMethodRunPayload,
  ModelSearchPayload,
  ReportDescribePayload,
  ReportGetPayload,
  ReportSearchPayload,
  ReportTypeSearchPayload,
  ServerMessage,
  ServerRequest,
  SummarisePayload,
  VaultGetPayload,
  VaultPutPayload,
  WorkflowRunPayload,
  WorkflowSearchPayload,
} from "./protocol.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { createDefinitionId } from "../domain/definitions/definition.ts";
import { acquireModelLocks, acquireVaultSync } from "../cli/repo_context.ts";
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
import type { DataRecord } from "../domain/data/data_record.ts";
import {
  parsePrincipal,
  type Principal,
  principalToString,
} from "../domain/access/principal.ts";
import { type Action, ActionSchema } from "../domain/access/action.ts";
import { parseResourceSelector } from "../domain/access/resource_selector.ts";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import { GrantBasedAccessDecisionService } from "../domain/access/grant_based_access_decision_service.ts";
import { modelRegistry } from "../domain/models/model.ts";

// ── Zod schemas for incoming WebSocket messages ─────────────────────────

const WorkflowRunRequestSchema = z.object({
  type: z.literal("workflow.run"),
  id: z.string().min(1),
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
  id: z.string().min(1),
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
  id: z.string().min(1),
  payload: z.object({
    subject: z.string().optional(),
    resource: z.string().optional(),
  }).optional(),
});

const AccessGroupListRequestSchema = z.object({
  type: z.literal("access.group.list"),
  id: z.string().min(1),
  payload: z.object({
    name: z.string().optional(),
  }).optional(),
});

const AccessCheckRequestSchema = z.object({
  type: z.literal("access.check"),
  id: z.string().min(1),
  payload: z.object({
    subject: z.string(),
    action: z.string(),
    resource: z.string(),
    collectives: z.array(z.string()).optional(),
  }),
});

const AccessCanIRequestSchema = z.object({
  type: z.literal("access.can-i"),
  id: z.string().min(1),
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
  id: z.string().min(1),
});

const CancelRequestSchema = z.object({
  type: z.literal("cancel"),
  id: z.string().min(1),
});

const DataGetRequestSchema = z.object({
  type: z.literal("data.get"),
  id: z.string().min(1),
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
  id: z.string().min(1),
  payload: z.object({
    predicate: z.string(),
    limit: z.number().optional(),
    select: z.string().optional(),
  }),
});

const DataListRequestSchema = z.object({
  type: z.literal("data.list"),
  id: z.string().min(1),
  payload: z.object({
    modelIdOrName: z.string().optional(),
    workflowName: z.string().optional(),
    runId: z.string().optional(),
    typeFilter: z.string().optional(),
  }),
});

const ModelSearchRequestSchema = z.object({
  type: z.literal("model.search"),
  id: z.string().min(1),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const ModelMethodDescribeRequestSchema = z.object({
  type: z.literal("model.method.describe"),
  id: z.string().min(1),
  payload: z.object({
    modelIdOrName: z.string(),
    methodName: z.string(),
  }),
});

const WorkflowSearchRequestSchema = z.object({
  type: z.literal("workflow.search"),
  id: z.string().min(1),
  payload: z.object({
    query: z.string().optional(),
  }).optional(),
});

const VaultGetRequestSchema = z.object({
  type: z.literal("vault.get"),
  id: z.string().min(1),
  payload: z.object({
    vaultNameOrId: z.string(),
    vaultType: z.string().optional(),
  }),
});

const VaultPutRequestSchema = z.object({
  type: z.literal("vault.put"),
  id: z.string().min(1),
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

const AuditTimelineRequestSchema = z.object({
  type: z.literal("audit.timeline"),
  id: z.string().min(1),
  payload: z.object({
    hours: z.number().optional(),
    showAll: z.boolean().optional(),
    sessionId: z.string().optional(),
    includeDiagnostic: z.boolean().optional(),
  }).optional(),
});

const SummariseRequestSchema = z.object({
  type: z.literal("summarise"),
  id: z.string().min(1),
  payload: z.object({
    since: z.string().optional(),
    limit: z.number().optional(),
  }).optional(),
});

const ReportGetRequestSchema = z.object({
  type: z.literal("report.get"),
  id: z.string().min(1),
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
  id: z.string().min(1),
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
  id: z.string().min(1),
  payload: z.object({
    reportName: z.string(),
  }),
});

const ReportTypeSearchRequestSchema = z.object({
  type: z.literal("report.type.search"),
  id: z.string().min(1),
  payload: z.object({
    query: z.string().optional(),
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
  ModelSearchRequestSchema,
  ModelMethodDescribeRequestSchema,
  WorkflowSearchRequestSchema,
  VaultGetRequestSchema,
  VaultPutRequestSchema,
  AuditTimelineRequestSchema,
  SummariseRequestSchema,
  ReportGetRequestSchema,
  ReportSearchRequestSchema,
  ReportDescribeRequestSchema,
  ReportTypeSearchRequestSchema,
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

  const snapshot = ctx.policySnapshotLoader.snapshot;
  const service = new GrantBasedAccessDecisionService(snapshot);
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
      fields: {},
    }, ctx)
  ) return;

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
      const message = error instanceof Error ? error.message : String(error);
      sendError(socket, requestId, "workflow_execution_failed", message);
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

    if (isAccessModelType(payload.typeArg, preResult?.type.normalized)) {
      if (
        !authorizeOrReject(socket, requestId, principal, "admin", {
          kind: "access",
          name: "*",
          fields: {},
        }, ctx)
      ) return;
    } else {
      if (
        !authorizeOrReject(socket, requestId, principal, "run", {
          kind: "model",
          name: payload.modelIdOrName,
          fields: {},
        }, ctx)
      ) return;
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
      const message = error instanceof Error ? error.message : String(error);
      sendError(
        socket,
        requestId,
        "method_execution_failed",
        message,
      );
    }
  } finally {
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
    const records = await ctx.repoContext.dataQueryService.query(
      `modelType == "${GRANT_MODEL_TYPE.normalized}"`,
      { loadAttributes: true },
    );

    let results: { grant: Grant; instanceName: string }[] = [];
    for (const record of records) {
      const dataRecord = record as DataRecord;
      const parsed = GrantSchema.safeParse(dataRecord.attributes);
      if (parsed.success && parsed.data.state === "active") {
        results.push({
          grant: parsed.data,
          instanceName: dataRecord.modelName ?? "",
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
    const message = error instanceof Error ? error.message : String(error);
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
    const records = await ctx.repoContext.dataQueryService.query(
      `modelType == "${GROUP_MODEL_TYPE.normalized}"`,
      { loadAttributes: true },
    );

    let groups: Group[] = [];
    for (const record of records) {
      const parsed = GroupSchema.safeParse(
        (record as DataRecord).attributes,
      );
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
    const message = error instanceof Error ? error.message : String(error);
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

    const snapshot = ctx.policySnapshotLoader.snapshot;
    const service = new GrantBasedAccessDecisionService(snapshot);
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
    const message = error instanceof Error ? error.message : String(error);
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
      const service = new GrantBasedAccessDecisionService(snapshot);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: resourceName,
      fields: {},
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
    const message = error instanceof Error ? error.message : String(error);
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

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      dataQuery(libCtx, deps, {
        predicate: payload.predicate,
        select: payload.select,
        limit: payload.limit,
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
    const message = error instanceof Error ? error.message : String(error);
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
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: resourceName,
      fields: {},
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
    const message = error instanceof Error ? error.message : String(error);
    sendError(socket, requestId, "data_list_failed", message);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
      const message = error instanceof Error ? error.message : String(error);
      sendError(socket, requestId, "vault_put_failed", message);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
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
    const message = error instanceof Error ? error.message : String(error);
    sendError(socket, requestId, "report_type_search_failed", message);
  }
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
