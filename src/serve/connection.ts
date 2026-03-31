// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import {
  createLibSwampContext,
  modelMethodRun,
  workflowRun,
} from "../libswamp/mod.ts";
import { createModelMethodRunDeps, createWorkflowRunDeps } from "./deps.ts";
import { serializeEvent } from "./serializer.ts";
import type {
  ModelMethodRunPayload,
  ServerMessage,
  ServerRequest,
  WorkflowRunPayload,
} from "./protocol.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { extractModelReferencesFromWorkflow } from "../domain/workflows/model_reference_extractor.ts";
import { createWorkflowId } from "../domain/workflows/workflow_id.ts";
import { acquireModelLocks } from "../cli/repo_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

// ── Zod schemas for incoming WebSocket messages ─────────────────────────

const WorkflowRunRequestSchema = z.object({
  type: z.literal("workflow.run"),
  id: z.string().min(1),
  payload: z.object({
    workflowIdOrName: z.string(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    lastEvaluated: z.boolean().optional(),
    driver: z.string().optional(),
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
    driver: z.string().optional(),
    runtimeTags: z.record(z.string(), z.string()).optional(),
  }),
});

const CancelRequestSchema = z.object({
  type: z.literal("cancel"),
  id: z.string().min(1),
});

const ServerRequestSchema = z.discriminatedUnion("type", [
  WorkflowRunRequestSchema,
  ModelMethodRunRequestSchema,
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
}

export function handleConnection(
  socket: WebSocket,
  ctx: ConnectionContext,
): void {
  const activeRequests = new Map<string, AbortController>();

  socket.onmessage = (event) => {
    handleMessage(socket, ctx, activeRequests, event);
  };

  socket.onclose = () => {
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

  const task = request.type === "workflow.run"
    ? handleWorkflowRun(
      socket,
      ctx,
      request.id,
      request.payload,
      controller,
    )
    : handleModelMethodRun(
      socket,
      ctx,
      request.id,
      request.payload,
      controller,
    );

  task.finally(() => activeRequests.delete(request.id));
}

async function handleWorkflowRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowRunPayload,
  controller: AbortController,
): Promise<void> {
  let flushLocks: (() => Promise<void>) | null = null;

  try {
    // Pre-lookup workflow for per-model lock acquisition
    const workflowRepo = ctx.repoContext.workflowRepo;
    const workflow = await workflowRepo.findByName(
      payload.workflowIdOrName,
    ) ?? await workflowRepo.findById(
      createWorkflowId(payload.workflowIdOrName),
    );

    if (workflow) {
      const modelRefs = await extractModelReferencesFromWorkflow(
        workflow,
        workflowRepo,
      );
      if (modelRefs !== null && modelRefs.length > 0) {
        const resolvedModels: Array<{ modelType: string; modelId: string }> =
          [];
        for (const ref of modelRefs) {
          const result = await findDefinitionByIdOrName(
            ctx.repoContext.definitionRepo,
            ref,
          );
          if (result) {
            resolvedModels.push({
              modelType: result.type.normalized,
              modelId: result.definition.id,
            });
          }
        }
        if (resolvedModels.length > 0) {
          const lockResult = await acquireModelLocks(
            ctx.datastoreConfig,
            resolvedModels,
            ctx.repoDir,
          );
          if (lockResult.synced) ctx.repoContext.catalogStore?.invalidate();
          flushLocks = lockResult.flush;
        }
      }
    }

    const deps = createWorkflowRunDeps(ctx.repoDir, ctx.repoContext);
    const libCtx = createLibSwampContext({ signal: controller.signal });

    for await (
      const event of workflowRun(libCtx, deps, {
        workflowIdOrName: payload.workflowIdOrName,
        inputs: payload.inputs,
        lastEvaluated: payload.lastEvaluated,
        driver: payload.driver,
        verbose: payload.verbose,
        runtimeTags: payload.runtimeTags,
      })
    ) {
      if (socket.readyState !== WebSocket.OPEN) break;
      const serialized = serializeEvent(
        event as { kind: string; [key: string]: unknown },
      );
      send(socket, { type: "event", id: requestId, event: serialized });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      sendError(socket, requestId, "workflow_execution_failed", message);
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
      );
      if (lockResult.synced) ctx.repoContext.catalogStore?.invalidate();
      flushLocks = lockResult.flush;
    }

    const deps = createModelMethodRunDeps(ctx.repoDir, ctx.repoContext);
    const libCtx = createLibSwampContext({ signal: controller.signal });

    for await (
      const event of modelMethodRun(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        methodName: payload.methodName,
        inputs: payload.inputs ?? {},
        lastEvaluated: payload.lastEvaluated ?? false,
        runtimeTags: payload.runtimeTags,
        driver: payload.driver,
      })
    ) {
      if (socket.readyState !== WebSocket.OPEN) break;
      const serialized = serializeEvent(
        event as { kind: string; [key: string]: unknown },
      );
      send(socket, { type: "event", id: requestId, event: serialized });
    }
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
