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
import { createLibSwampContext, modelMethodRun } from "../libswamp/mod.ts";
import { createModelMethodRunDeps, executeWorkflowWithLocks } from "./deps.ts";
import { serializeEvent } from "./serializer.ts";
import type {
  AccessCheckPayload,
  AccessGrantListPayload,
  AccessGroupListPayload,
  ModelMethodRunPayload,
  ServerMessage,
  ServerRequest,
  WorkflowRunPayload,
} from "./protocol.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { acquireModelLocks } from "../cli/repo_context.ts";
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
import type { DataRecord } from "../domain/data/data_record.ts";
import { parsePrincipal, type Principal } from "../domain/access/principal.ts";
import { ActionSchema } from "../domain/access/action.ts";
import { parseResourceSelector } from "../domain/access/resource_selector.ts";
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

const AccessReloadRequestSchema = z.object({
  type: z.literal("access.reload"),
  id: z.string().min(1),
});

const CancelRequestSchema = z.object({
  type: z.literal("cancel"),
  id: z.string().min(1),
});

const ServerRequestSchema = z.discriminatedUnion("type", [
  WorkflowRunRequestSchema,
  ModelMethodRunRequestSchema,
  AccessGrantListRequestSchema,
  AccessGroupListRequestSchema,
  AccessCheckRequestSchema,
  AccessReloadRequestSchema,
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
  _principal: Principal | null,
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
    handleMessage(socket, ctx, activeRequests, event);
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
      );
      break;
    case "model.method.run":
      task = handleModelMethodRun(
        socket,
        ctx,
        request.id,
        request.payload,
        controller,
      );
      break;
    case "access.grant.list":
      task = handleAccessGrantList(socket, ctx, request.id, request.payload);
      break;
    case "access.group.list":
      task = handleAccessGroupList(socket, ctx, request.id, request.payload);
      break;
    case "access.check":
      task = handleAccessCheck(socket, ctx, request.id, request.payload);
      break;
    case "access.reload":
      task = handleAccessReload(socket, ctx, request.id);
      break;
  }

  task.finally(() => activeRequests.delete(request.id));
}

async function handleWorkflowRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowRunPayload,
  controller: AbortController,
): Promise<void> {
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
): Promise<void> {
  let flushLocks: (() => Promise<void>) | null = null;

  try {
    // Pre-lookup for per-model lock acquisition
    const preResult = await findDefinitionByIdOrName(
      ctx.repoContext.definitionRepo,
      payload.modelIdOrName,
    );
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
  payload?: AccessGrantListPayload,
): Promise<void> {
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
  payload?: AccessGroupListPayload,
): Promise<void> {
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
): Promise<void> {
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

async function handleAccessReload(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
): Promise<void> {
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
