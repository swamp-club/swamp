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
 * Model-domain request handlers (model.* verbs).
 */

import { isControlPlaneModelType } from "../../domain/models/control_plane_types.ts";
import { controlPlaneRecordResource } from "../../domain/access/control_plane_records.ts";
import {
  consumeStream,
  createLibSwampContext,
  createModelCreateDeps,
  createModelDeleteDeps,
  createModelEditDeps,
  createModelEvaluateDeps,
  createModelGetDeps,
  createModelMethodDescribeDeps,
  createModelMethodHistoryLogsDeps,
  createModelOutputDataDeps,
  createModelOutputGetDeps,
  createModelOutputLogsDeps,
  createModelValidateDeps,
  createTypeDescribeDeps,
  isSwampError,
  modelCreate,
  modelDelete,
  modelDeletePreview,
  modelEdit,
  type ModelEditTarget,
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
  type ModelOutputSearchItem,
  modelSearch,
  type ModelSearchDeps,
  modelValidate,
  resolveOutputIdReference,
  resolveOutputReference,
  typeDescribe,
  typeSearch,
  type TypeSearchDeps,
} from "../../libswamp/mod.ts";
import { createModelMethodRunDeps } from "../deps.ts";
import { withSharedSyncGate } from "../sync_gate.ts";
import { createCommandTelemetry } from "../telemetry.ts";
import { serializeEvent } from "../serializer.ts";
import type {
  ModelCreatePayload,
  ModelDeletePayload,
  ModelEditPayload,
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
  ModelTypeDescribePayload,
  ModelTypeSearchPayload,
  ModelValidatePayload,
} from "../protocol.ts";
import {
  type DefinitionLookupResult,
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import {
  acquireModelLocks,
  type ModelLockResult,
  runUnderModelLocks,
} from "../../cli/repo_context.ts";
import {
  extractTraceContext,
  runWithParentTrace,
} from "../../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import {
  inferMethodKind,
  isMutatingKind,
  modelRegistry,
} from "../../domain/models/model.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { RegistryCapacityError } from "../active_run_registry.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import { deleteActiveRun, writeActiveRun } from "../active_run_tracker.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  clientErrorDetails,
  type ConnectionContext,
  exceptionTypeForClient,
  filterByResources,
  isAdminOnlyModelType,
  LibSwampStreamError,
  lockTimeoutErrorForClient,
  rejectEditWithoutContent,
  resourceDecider,
  sanitizeErrorForClient,
  send,
  sendError,
  subscribeUntilDetach,
  wasRequestErrored,
} from "./shared.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import {
  authorizeReferenceAccess,
  authorizeResolved,
  canonicalResources,
  modelAccessResource,
  recordedRunModel,
  resolveModelTarget,
  resolveOutputAccess,
  type ResourceResolution,
  targetArgument,
  unresolvedAccessResource,
} from "./resource_resolution.ts";

const logger = getSwampLogger(["serve", "connection"]);

const DEFAULT_BUFFER_CAPACITY = 10_000;

export async function isMethodMutating(
  modelType: string,
  methodName: string,
): Promise<boolean> {
  try {
    const modelDef = await resolveModelType(modelType, getAutoResolver());
    if (!modelDef) return true;
    const method = modelDef.methods[methodName];
    return isMutatingKind(inferMethodKind(methodName, method));
  } catch {
    return true;
  }
}

/** What a method run is authorized as, and what it then acts on. */
interface MethodRunTarget {
  /** The existing definition, when the reference resolves to one. */
  definition: DefinitionLookupResult | null;
  /** The resource `run` is authorized on. */
  resource: AccessResource;
  /** The argument and lookup mode handed to modelMethodRun. */
  modelIdOrName: string;
  byId: boolean;
  /** The name the model was authorized on, when acting by id. */
  expectedName?: string;
  /** The id of the model run by id, recorded for cancel and attach. */
  resourceId?: string;
}

/**
 * Resolves a method run's model. The standard path authorizes the model's
 * canonical name and full fields, then runs it by id (swamp-club#2674). A
 * direct type execution (a type and a definition name) may create its
 * definition, so it keeps authorizing the requested name and running by it;
 * how that path authorizes the definition it writes is swamp-club#2672.
 * Throws when the lookup fails.
 */
async function resolveMethodRunTarget(
  ctx: ConnectionContext,
  payload: ModelMethodRunPayload,
): Promise<MethodRunTarget> {
  const definition = await findDefinitionByIdOrName(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  const methodName = payload.methodName;
  if (payload.typeArg && payload.definitionName) {
    // A definition not created yet has no tags; its type is the one named.
    // An existing one's fields are its own, even for a control-plane type
    // whose access resource names the type instead (swamp-club#2756).
    const fields: Record<string, unknown> = definition
      ? {
        name: definition.definition.name,
        modelType: definition.type.normalized,
        tags: definition.definition.tags ?? {},
      }
      : {
        name: payload.modelIdOrName,
        modelType: normalizedTypeOrRaw(payload.typeArg),
        tags: {},
      };
    return {
      definition,
      resource: {
        kind: "model",
        name: payload.modelIdOrName,
        fields: { ...fields, methodName },
      },
      modelIdOrName: payload.modelIdOrName,
      byId: false,
    };
  }
  const resolution: ResourceResolution = definition
    ? {
      status: "found",
      resource: modelAccessResource(definition),
      id: definition.definition.id,
      name: definition.definition.name,
    }
    : {
      status: "missing",
      resource: unresolvedAccessResource("model", payload.modelIdOrName),
    };
  const { idOrName, byId, expectedName } = targetArgument(
    resolution,
    payload.modelIdOrName,
  );
  return {
    definition,
    resource: {
      ...resolution.resource,
      fields: { ...resolution.resource.fields, methodName },
    },
    modelIdOrName: idOrName,
    byId,
    expectedName,
    resourceId: definition?.definition.id,
  };
}

/**
 * Authorizes a method run: admin for a restricted model type, otherwise run
 * on the target model and, for a direct type execution, on the type.
 */
function authorizeMethodRun(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  payload: ModelMethodRunPayload,
  target: MethodRunTarget,
  ctx: ConnectionContext,
): boolean {
  if (
    isAdminOnlyModelType(
      payload.typeArg,
      target.definition?.type.normalized,
      ctx.authConfig.restrictedModelTypes,
    )
  ) {
    return authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: target.resource.fields,
    }, ctx).allowed;
  }
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "run",
      target.resource,
      ctx,
    )
      .allowed
  ) return false;
  if (payload.typeArg) {
    const executionTarget = ModelType.create(payload.typeArg).normalized;
    // A type carries no tags; every resource field is present so a
    // conditional deny decides on it rather than failing closed.
    return authorizeOrReject(socket, requestId, principal, "run", {
      kind: "model",
      name: executionTarget,
      fields: {
        name: executionTarget,
        modelType: executionTarget,
        tags: {},
        methodName: payload.methodName,
      },
    }, ctx).allowed;
  }
  return true;
}

export async function handleModelMethodRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodRunPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const registry = ctx.activeRunRegistry;
  if (!registry) {
    let flushLocks: (() => Promise<void>) | null = null;
    let modelLocks: ModelLockResult | undefined;
    let mutating = true;
    const initiatedBy = principal ? principalToString(principal) : "ghost";
    const telemetry = createCommandTelemetry(
      {
        modelName: payload.modelIdOrName,
        methodName: payload.methodName,
      },
      initiatedBy,
    );
    try {
      const target = await resolveMethodRunTarget(ctx, payload);
      if (
        !authorizeMethodRun(socket, requestId, principal, payload, target, ctx)
      ) return;
      const preResult = target.definition;

      if (preResult) {
        mutating = await isMethodMutating(
          preResult.type.normalized,
          payload.methodName,
        );
        if (mutating) {
          const lockResult = await acquireModelLocks(
            ctx.datastoreConfig,
            [{
              modelType: preResult.type.normalized,
              modelId: preResult.definition.id,
            }],
            ctx.repoDir,
            ctx.syncService,
            ctx.repoContext.catalogStore,
            undefined,
            { wrapSync: (fn) => withSharedSyncGate(ctx.syncGate, fn) },
          );
          if (lockResult.synced) ctx.repoContext.catalogStore.invalidate();
          flushLocks = lockResult.flush;
          modelLocks = lockResult;
        }
      }

      const isDirectExecution = payload.typeArg !== undefined;
      const deps = await createModelMethodRunDeps(
        ctx.repoDir,
        ctx.repoContext,
        {
          directExecution: isDirectExecution,
          runTracker: ctx.runTracker,
          defaultVault: ctx.defaultVault,
        },
      );
      const libCtx = createLibSwampContext({ signal: controller.signal });

      if (ctx.cancelRegistry) {
        ctx.cancelRegistry.register("method-run", requestId, controller);
      }

      const runMethod = async () => {
        for await (
          const event of modelMethodRun(libCtx, deps, {
            modelIdOrName: target.modelIdOrName,
            byId: target.byId,
            expectedName: target.expectedName,
            methodName: payload.methodName,
            inputs: payload.inputs ?? {},
            lastEvaluated: payload.lastEvaluated ?? false,
            runtimeTags: payload.runtimeTags,
            typeArg: payload.typeArg,
            definitionName: payload.definitionName,
            skipAllReports: payload.skipAllReports || isDirectExecution,
            skipReportNames: payload.skipReportNames,
            skipReportLabels: payload.skipReportLabels,
            reportNames: payload.reportNames,
            reportLabels: payload.reportLabels,
            skipAllChecks: payload.skipAllChecks,
            skipCheckNames: payload.skipCheckNames,
            skipCheckLabels: payload.skipCheckLabels,
            traceparent: payload.traceparent,
            tracestate: payload.tracestate,
            initiatedBy,
            instanceId: ctx.instanceId,
          })
        ) {
          if (socket.readyState !== WebSocket.OPEN) break;
          const serialized = serializeEvent(
            event as { kind: string; [key: string]: unknown },
          );
          send(socket, { type: "event", id: requestId, event: serialized });
        }
        send(socket, { type: "done", id: requestId });
      };

      if (payload.traceparent) {
        const headers: Record<string, string> = {
          traceparent: payload.traceparent,
        };
        if (payload.tracestate) headers.tracestate = payload.tracestate;
        const traceCtx = extractTraceContext(headers);
        await runUnderModelLocks(
          modelLocks,
          () => runWithParentTrace(traceCtx, runMethod),
        );
      } else {
        await runUnderModelLocks(modelLocks, runMethod);
      }
      if (ctx.syncService && !flushLocks && mutating) {
        const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
          ? ctx.datastoreConfig.namespace
          : undefined;
        const syncService = ctx.syncService;
        try {
          await withSharedSyncGate(
            ctx.syncGate,
            () => syncService.pushChanged({ namespace }),
          );
        } catch (pushError) {
          logger.warn("Failed to push changes to remote datastore: {error}", {
            error: pushError instanceof Error
              ? pushError.message
              : String(pushError),
          });
        }
      }
      await telemetry?.finish(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        sendError(socket, requestId, "cancelled", "Operation was cancelled");
      } else if (error instanceof LockTimeoutError) {
        const lt = lockTimeoutErrorForClient(error);
        sendError(socket, requestId, lt.code, lt.message, lt.details);
      } else {
        const message = sanitizeErrorForClient(error);
        const exType = exceptionTypeForClient(error);
        sendError(
          socket,
          requestId,
          "method_execution_failed",
          message,
          exType !== undefined ? { exceptionType: exType } : undefined,
        );
      }
      await telemetry?.finish(
        error instanceof Error ? error : new Error(String(error)),
      );
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
    return;
  }

  // Pre-lookup and authorization for the detached path
  let target: MethodRunTarget;
  try {
    target = await resolveMethodRunTarget(ctx, payload);
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "method_execution_failed", message);
    return;
  }
  if (
    !authorizeMethodRun(socket, requestId, principal, payload, target, ctx)
  ) return;
  const preResult = target.definition;
  const recorded = recordedRunModel(
    target.definition,
    target.resource.name,
    payload.typeArg,
  );

  const initiatedBy = principal ? principalToString(principal) : "ghost";
  const buffer = new RunEventBuffer(DEFAULT_BUFFER_CAPACITY);
  const runController = new AbortController();
  const runId: string = crypto.randomUUID();
  const startedAt = new Date();

  buffer.push({ kind: "run.accepted", runId });

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  try {
    registry.register({
      runId,
      kind: "method-run",
      resourceName: recorded.name,
      resourceId: target.resourceId,
      methodName: payload.methodName,
      resourceType: recorded.type,
      buffer,
      controller: runController,
      startedAt,
      completion,
      principalId: principal ? principalToString(principal) : null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("Detached method run rejected: {error}", { error: detail });
    resolveCompletion();
    if (err instanceof RegistryCapacityError) {
      const clientMsg = err.code === "already_registered"
        ? "A run with this ID is already in progress"
        : err.code === "draining"
        ? "Serve is shutting down; try again once it is back"
        : "Too many concurrent runs; wait for active runs to complete";
      sendError(socket, requestId, err.code, clientMsg);
    } else {
      sendError(socket, requestId, "internal_error", "Run registration failed");
    }
    return;
  }

  const detachedTelemetry = createCommandTelemetry(
    {
      modelName: payload.modelIdOrName,
      methodName: payload.methodName,
    },
    initiatedBy,
  );

  const detachedMutating = preResult
    ? await isMethodMutating(preResult.type.normalized, payload.methodName)
    : true;

  (async () => {
    let flushLocks: (() => Promise<void>) | null = null;
    let modelLocks: ModelLockResult | undefined;
    try {
      if (preResult && detachedMutating) {
        const lockResult = await acquireModelLocks(
          ctx.datastoreConfig,
          [{
            modelType: preResult.type.normalized,
            modelId: preResult.definition.id,
          }],
          ctx.repoDir,
          ctx.syncService,
          ctx.repoContext.catalogStore,
          undefined,
          { wrapSync: (fn) => withSharedSyncGate(ctx.syncGate, fn) },
        );
        if (lockResult.synced) ctx.repoContext.catalogStore.invalidate();
        flushLocks = lockResult.flush;
        modelLocks = lockResult;
      }

      const isDirectExecution = payload.typeArg !== undefined;
      const deps = await createModelMethodRunDeps(
        ctx.repoDir,
        ctx.repoContext,
        {
          directExecution: isDirectExecution,
          runTracker: ctx.runTracker,
          defaultVault: ctx.defaultVault,
        },
      );
      const libCtx = createLibSwampContext({
        signal: runController.signal,
      });

      const doRun = async () => {
        for await (
          const event of modelMethodRun(libCtx, deps, {
            modelIdOrName: target.modelIdOrName,
            byId: target.byId,
            expectedName: target.expectedName,
            methodName: payload.methodName,
            inputs: payload.inputs ?? {},
            lastEvaluated: payload.lastEvaluated ?? false,
            runtimeTags: payload.runtimeTags,
            typeArg: payload.typeArg,
            definitionName: payload.definitionName,
            skipAllReports: payload.skipAllReports || isDirectExecution,
            skipReportNames: payload.skipReportNames,
            skipReportLabels: payload.skipReportLabels,
            reportNames: payload.reportNames,
            reportLabels: payload.reportLabels,
            skipAllChecks: payload.skipAllChecks,
            skipCheckNames: payload.skipCheckNames,
            skipCheckLabels: payload.skipCheckLabels,
            traceparent: payload.traceparent,
            tracestate: payload.tracestate,
            initiatedBy,
            instanceId: ctx.instanceId,
          })
        ) {
          const serialized = serializeEvent(
            event as { kind: string; [key: string]: unknown },
          );
          buffer.push(serialized);
        }
      };

      if (payload.traceparent) {
        const headers: Record<string, string> = {
          traceparent: payload.traceparent,
        };
        if (payload.tracestate) headers.tracestate = payload.tracestate;
        const traceCtx = extractTraceContext(headers);
        await runUnderModelLocks(
          modelLocks,
          () => runWithParentTrace(traceCtx, doRun),
        );
      } else {
        await runUnderModelLocks(modelLocks, doRun);
      }

      if (ctx.syncService && !flushLocks && detachedMutating) {
        const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
          ? ctx.datastoreConfig.namespace
          : undefined;
        const syncService = ctx.syncService;
        try {
          await withSharedSyncGate(
            ctx.syncGate,
            () => syncService.pushChanged({ namespace }),
          );
        } catch (pushError) {
          logger.warn("Failed to push changes to remote datastore: {error}", {
            error: pushError instanceof Error
              ? pushError.message
              : String(pushError),
          });
        }
      }
      buffer.finish({ kind: "done" });
      await detachedTelemetry?.finish(null);
    } catch (error) {
      await detachedTelemetry?.finish(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (error instanceof DOMException && error.name === "AbortError") {
        buffer.finish({
          kind: "error",
          code: "cancelled",
          message: "Operation was cancelled",
        });
      } else if (error instanceof LockTimeoutError) {
        const lt = lockTimeoutErrorForClient(error);
        buffer.finish({
          kind: "error",
          code: lt.code,
          message: lt.message,
          details: lt.details,
        });
      } else {
        const exType = exceptionTypeForClient(error);
        buffer.finish({
          kind: "error",
          code: "method_execution_failed",
          message: sanitizeErrorForClient(error),
          ...(exType !== undefined && {
            details: { exceptionType: exType },
          }),
        });
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
      registry.deregister(runId);
      try {
        if (ctx.controlPlaneStore && ctx.instanceId) {
          deleteActiveRun(ctx.controlPlaneStore, ctx.instanceId, runId);
        }
      } catch (cleanupErr) {
        logger.warn("Failed to delete active run record: {error}", {
          error: cleanupErr instanceof Error
            ? cleanupErr.message
            : String(cleanupErr),
        });
      }
      resolveCompletion();
    }
  })().catch((err) => {
    logger.warn("Unhandled error in detached method run: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (ctx.controlPlaneStore && ctx.instanceId) {
    writeActiveRun(ctx.controlPlaneStore, ctx.instanceId, runId, {
      resourceName: recorded.name,
      resourceId: target.resourceId,
      methodName: payload.methodName,
      resourceType: recorded.type,
      runKind: "method-run",
      startedAt: startedAt.toISOString(),
    });
  }

  await subscribeUntilDetach(buffer, socket, requestId, controller);
}

export async function handleModelSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: ModelSearchDeps = {
      findAllGlobal: () => ctx.repoContext.definitionRepo.findAllGlobal(),
      isInternalType: (type: string) => modelRegistry.isInternal(type),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelSearch(libCtx, deps, {
        query: payload?.query,
        includeInternal: payload?.includeInternal,
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

    const data = (result ?? {}) as {
      results?: Array<{ id: string; name: string; type: string }>;
    };
    if (data.results) {
      const canonical = canonicalResources(ctx);
      data.results = await filterByResources(
        data.results,
        (item) => canonical.model(item.id, item.name, item.type),
        socket,
        principal,
        "read",
        ctx,
      );
    }

    send(socket, {
      type: "model.search",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_search_failed", message);
  }
}

export async function handleModelMethodDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "read",
      target,
      payload.modelIdOrName,
      "model",
      ctx,
      "model_method_describe_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  try {
    await modelRegistry.ensureLoaded();
    const libCtx = createLibSwampContext();
    const deps = createModelMethodDescribeDeps(
      ctx.repoDir,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelMethodDescribe(
        libCtx,
        deps,
        model.idOrName,
        payload.methodName,
        { byId: model.byId, expectedName: model.expectedName },
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

export async function handleModelGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "read",
      target,
      payload.modelIdOrName,
      "model",
      ctx,
      "model_get_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  try {
    const libCtx = createLibSwampContext();
    const deps = await createModelGetDeps(
      ctx.repoDir,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelGet(libCtx, deps, model.idOrName, {
        byId: model.byId,
        expectedName: model.expectedName,
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

export async function handleModelCreate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelCreatePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    isAdminOnlyModelType(
      payload.typeArg,
      undefined,
      ctx.authConfig.restrictedModelTypes,
    )
  ) {
    if (
      !authorizeOrReject(socket, requestId, principal, "admin", {
        kind: "access",
        name: "*",
        fields: {},
      }, ctx).allowed
    ) return;
  } else {
    if (
      !authorizeOrReject(socket, requestId, principal, "write", {
        kind: "model",
        name: payload.name ?? payload.typeArg,
        // A model being created has no tags yet; its type is the one named.
        fields: {
          name: payload.name ?? payload.typeArg,
          modelType: normalizedTypeOrRaw(payload.typeArg),
          tags: {},
        },
      }, ctx).allowed
    ) return;
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = await createModelCreateDeps(
      ctx.repoDir,
      ctx.managedDefinitionsDir,
      ctx.repoContext.definitionRepo,
    );

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

    if (ctx.syncService) {
      const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
        ? ctx.datastoreConfig.namespace
        : undefined;
      try {
        await ctx.syncService.pushChanged({ namespace });
      } catch (pushError) {
        logger.warn("Failed to push changes to remote datastore: {error}", {
          error: pushError instanceof Error
            ? pushError.message
            : String(pushError),
        });
      }
    }
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_create_failed", message);
  }
}

export async function handleModelDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "write",
      target,
      payload.modelIdOrName,
      "model",
      ctx,
      "model_delete_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelDeleteDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.markDirty,
      ctx.repoContext.definitionRepo,
    );

    const preview = await modelDeletePreview(
      libCtx,
      deps,
      {
        modelIdOrName: model.idOrName,
        byId: model.byId,
        expectedName: model.expectedName,
        force: payload.force ?? false,
      },
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
        modelIdOrName: model.idOrName,
        byId: model.byId,
        expectedName: model.expectedName,
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

    if (ctx.syncService) {
      const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
        ? ctx.datastoreConfig.namespace
        : undefined;
      try {
        await ctx.syncService.pushChanged({ namespace });
      } catch (pushError) {
        logger.warn("Failed to push changes to remote datastore: {error}", {
          error: pushError instanceof Error
            ? pushError.message
            : String(pushError),
        });
      }
    }
  } catch (error) {
    // modelDeletePreview throws a SwampError (e.g. notFound) rather than an
    // Error; wrap it so the client gets its message and allow-listed reason.
    const clientError = isSwampError(error)
      ? new LibSwampStreamError(error)
      : error;
    sendError(
      socket,
      requestId,
      "model_delete_failed",
      sanitizeErrorForClient(clientError),
      clientErrorDetails(clientError),
    );
  }
}

export async function handleModelOutputGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output read, not
  // the raw argument: an output id prefix matches across every model
  // (swamp-club#2673).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = await createModelOutputGetDeps(
        ctx.repoDir,
        undefined,
        ctx.repoContext.definitionRepo,
      );
      return {
        deps,
        reference: await resolveOutputReference(
          deps,
          payload.outputIdOrModelName,
        ),
      };
    },
    payload.outputIdOrModelName,
    ["model"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdOrModelName,
    ["model"],
    ctx,
    "model_output_get_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = createLibSwampContext();

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputGet(libCtx, deps, payload.outputIdOrModelName, { reference }),
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

export async function handleModelOutputData(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputDataPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output, not the
  // raw id prefix (swamp-club#2673). The read returns data artifact content,
  // so it needs a data read on those models too, as data.get does
  // (swamp-club#2739).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = createModelOutputDataDeps(
        ctx.repoDir,
        ctx.datastoreResolver,
        ctx.repoContext.unifiedDataRepo,
        ctx.repoContext.definitionRepo,
      );
      return {
        deps,
        reference: await resolveOutputIdReference(deps, payload.outputIdArg),
      };
    },
    payload.outputIdArg,
    ["model", "data"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdArg,
    ["model", "data"],
    ctx,
    "model_output_data_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = createLibSwampContext();

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputData(libCtx, deps, {
        outputIdArg: payload.outputIdArg,
        name: payload.name,
        field: payload.field,
        version: payload.version,
        reference,
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

export async function handleModelOutputLogs(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputLogsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output, not the
  // raw id prefix (swamp-club#2673). The read returns log data artifacts, so
  // it needs a data read on those models too, as data.get does
  // (swamp-club#2739).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = createModelOutputLogsDeps(
        ctx.repoDir,
        ctx.datastoreResolver,
        ctx.repoContext.unifiedDataRepo,
      );
      return {
        deps,
        reference: await resolveOutputIdReference(deps, payload.outputIdArg),
      };
    },
    payload.outputIdArg,
    ["model", "data"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdArg,
    ["model", "data"],
    ctx,
    "model_output_logs_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = createLibSwampContext();

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputLogs(libCtx, deps, {
        outputIdArg: payload.outputIdArg,
        tail: payload.tail,
        reference,
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

export async function handleModelOutputSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelOutputSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
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

    const data = (result ?? {}) as {
      results?: ModelOutputSearchItem[];
    };
    if (data.results) {
      data.results = await filterOutputItems(
        data.results,
        socket,
        principal,
        ctx,
      );
    }

    send(socket, {
      type: "model.output.search",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_search_failed", message);
  }
}

export async function handleModelMethodHistoryGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodHistoryGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output read, not
  // the raw argument (swamp-club#2673).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = await createModelOutputGetDeps(
        ctx.repoDir,
        undefined,
        ctx.repoContext.definitionRepo,
      );
      return {
        deps,
        reference: await resolveOutputReference(
          deps,
          payload.outputIdOrModelName,
        ),
      };
    },
    payload.outputIdOrModelName,
    ["model"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdOrModelName,
    ["model"],
    ctx,
    "model_method_history_get_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = createLibSwampContext();

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputGet(libCtx, deps, payload.outputIdOrModelName, { reference }),
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

export async function handleModelMethodHistoryLogs(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodHistoryLogsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output read, not
  // the raw argument (swamp-club#2673).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = await createModelMethodHistoryLogsDeps(
        ctx.repoDir,
        undefined,
        ctx.repoContext.definitionRepo,
      );
      return {
        deps,
        reference: await resolveOutputReference(
          deps,
          payload.outputIdOrModelName,
        ),
      };
    },
    payload.outputIdOrModelName,
    ["model"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdOrModelName,
    ["model"],
    ctx,
    "model_method_history_logs_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = createLibSwampContext();

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelMethodHistoryLogs(libCtx, deps, {
        outputIdOrModelName: payload.outputIdOrModelName,
        tail: payload.tail,
        repoDir: ctx.repoDir,
        reference,
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

export async function handleModelMethodHistorySearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelMethodHistorySearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
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

    const data = (result ?? {}) as {
      results?: ModelOutputSearchItem[];
    };
    if (data.results) {
      data.results = await filterOutputItems(
        data.results,
        socket,
        principal,
        ctx,
      );
    }

    send(socket, {
      type: "model.method.history.search",
      id: requestId,
      payload: { data },
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

export async function handleModelValidate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelValidatePayload,
): Promise<void> {
  // Without a model this validates every model the caller may read, and only
  // those (swamp-club#2675). A named model is resolved first.
  const modelIdOrName = payload?.modelIdOrName;
  let model:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  let include:
    | ((entry: DefinitionLookupResult) => boolean)
    | undefined;
  // An empty string reads as absent, exactly as libswamp reads it.
  if (!modelIdOrName) {
    if (
      !authorizeAnyOrReject(socket, requestId, principal, "read", "model", ctx)
    ) return;
    const readable = resourceDecider(socket, principal, "read", ctx);
    include = (entry) => readable(modelAccessResource(entry, "model"));
  } else {
    const target = await resolveModelTarget(
      ctx.repoContext.definitionRepo,
      modelIdOrName,
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        modelIdOrName,
        "model",
        ctx,
        "model_validate_failed",
      )
    ) return;
    model = targetArgument(target, modelIdOrName);
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelValidateDeps(
      ctx.repoDir,
      {
        labels: payload?.labels,
        method: payload?.method,
      },
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.catalogStore,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelValidate(libCtx, deps, {
        modelIdOrName: model?.idOrName,
        byId: model?.byId,
        expectedName: model?.expectedName,
        include,
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

export async function handleModelEvaluate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelEvaluatePayload,
): Promise<void> {
  // Without a model this evaluates every model — evaluation orders them all
  // in one dependency graph — but saves and returns only those the caller
  // may read (swamp-club#2675). A named model is resolved first.
  const modelIdOrName = payload?.modelIdOrName;
  let model:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  let include:
    | ((entry: DefinitionLookupResult) => boolean)
    | undefined;
  // An empty string reads as absent, exactly as libswamp reads it.
  if (!modelIdOrName) {
    if (
      !authorizeAnyOrReject(socket, requestId, principal, "read", "model", ctx)
    ) return;
    const readable = resourceDecider(socket, principal, "read", ctx);
    include = (entry) => readable(modelAccessResource(entry, "model"));
  } else {
    const target = await resolveModelTarget(
      ctx.repoContext.definitionRepo,
      modelIdOrName,
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        modelIdOrName,
        "model",
        ctx,
        "model_evaluate_failed",
      )
    ) return;
    model = targetArgument(target, modelIdOrName);
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelEvaluateDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.catalogStore,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelEvaluate(libCtx, deps, {
        modelIdOrName: model?.idOrName,
        byId: model?.byId,
        expectedName: model?.expectedName,
        include,
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

    const data = result ?? {};

    send(socket, {
      type: "model.evaluate",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    // Evaluating every model can fail on one the caller may not read, and
    // the error may name it, so such a caller gets no detail.
    const message = !model &&
        !(await readsEveryModel(socket, principal, ctx))
      ? "Evaluating every model failed"
      : sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_evaluate_failed", message);
  }
}

/** Whether the caller may read every model definition in the repository. */
async function readsEveryModel(
  socket: WebSocket,
  principal: Principal | null,
  ctx: ConnectionContext,
): Promise<boolean> {
  try {
    const readable = resourceDecider(socket, principal, "read", ctx);
    const all = await ctx.repoContext.definitionRepo.findAllGlobal();
    return all.every((entry) => readable(modelAccessResource(entry, "model")));
  } catch {
    return false;
  }
}

export async function handleModelEdit(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelEditPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectEditWithoutContent(socket, requestId, payload.content)) return;

  // Authorize the model the edit will act on, by its canonical name and full
  // fields, not the raw id-or-name: a grant matches the resource name, so an
  // id would sidestep name-scoped denies (swamp-club#2426, swamp-club#2674).
  let resolved: Awaited<ReturnType<typeof findDefinitionByIdOrName>> = null;
  try {
    resolved = await findDefinitionByIdOrName(
      ctx.repoContext.definitionRepo,
      payload.modelIdOrName,
    );
  } catch {
    // A model that cannot be loaded is authorized by the requested name and
    // then reported as not found.
  }
  const current: ModelEditTarget | null = resolved
    ? {
      name: resolved.definition.name,
      modelType: resolved.type.normalized,
      tags: { ...resolved.definition.tags },
    }
    : null;
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "write",
      current
        ? modelEditResource(current)
        : unresolvedAccessResource("model", payload.modelIdOrName),
      ctx,
    ).allowed
  ) return;
  if (!resolved) {
    sendError(
      socket,
      requestId,
      "not_found",
      `Model not found: ${payload.modelIdOrName}`,
    );
    return;
  }

  try {
    const libCtx = createLibSwampContext();
    const deps = createModelEditDeps(
      ctx.repoDir,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelEdit(libCtx, deps, {
        modelIdOrName: resolved.definition.id,
        byId: true,
        expectedName: resolved.definition.name,
        stdinContent: payload.content,
        // Every save is authorized against the edited model too, so a rename
        // or retag needs write on the result. It runs on every save rather
        // than only on a detected change, so a concurrent retag between the
        // lookup above and the save cannot skip it.
        authorizeUpdate: (_before, after) =>
          authorizeOrReject(
            socket,
            requestId,
            principal,
            "write",
            modelEditResource(after),
            ctx,
          ).allowed,
      }),
      {
        resolving: () => {},
        launching: () => {},
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
      type: "model.edit",
      id: requestId,
      payload: { data: result ?? {} },
    });

    if (ctx.syncService) {
      const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
        ? ctx.datastoreConfig.namespace
        : undefined;
      try {
        await ctx.syncService.pushChanged({ namespace });
      } catch (pushError) {
        logger.warn(
          "Failed to push model edit to remote datastore: {error}",
          {
            error: pushError instanceof Error
              ? pushError.message
              : String(pushError),
          },
        );
      }
    }
  } catch (error) {
    // A denied rename or retag was already reported by authorizeOrReject.
    if (wasRequestErrored(socket, requestId)) return;
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_edit_failed", message);
  }
}

/**
 * The resource an edit is authorized on, before and after. A control-plane
 * model (grant, group, token, worker) is its access record, so editing one —
 * or editing a model into one — needs admin (swamp-club#2756).
 */
function modelEditResource(target: ModelEditTarget): AccessResource {
  if (isControlPlaneModelType(target.modelType)) {
    return controlPlaneRecordResource(target.modelType, {
      name: target.name,
      tags: target.tags,
    });
  }
  return {
    kind: "model",
    name: target.name,
    fields: {
      modelType: target.modelType,
      name: target.name,
      tags: target.tags,
    },
  };
}

export async function handleModelTypeDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelTypeDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createTypeDescribeDeps();
    const modelType = ModelType.create(payload.typeArg);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      typeDescribe(libCtx, deps, modelType),
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
      type: "model.type.describe",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_type_describe_failed", message);
  }
}

export async function handleModelTypeSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelTypeSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
  ) return;

  try {
    const libCtx = createLibSwampContext();
    await modelRegistry.ensureLoaded();
    const deps: TypeSearchDeps = {
      getRegisteredTypes: () => modelRegistry.publicTypes(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      typeSearch(libCtx, deps, { query: payload?.query }),
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
      type: "model.type.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_type_search_failed", message);
  }
}

/**
 * Keeps the output or method-run items the caller may read: each is judged on
 * every model owning its definition id, with the method it ran, so a
 * methods-scoped or tag-conditioned grant applies to it (swamp-club#2675).
 */
function filterOutputItems(
  items: ModelOutputSearchItem[],
  socket: WebSocket,
  principal: Principal | null,
  ctx: ConnectionContext,
): Promise<ModelOutputSearchItem[]> {
  const canonical = canonicalResources(ctx);
  return filterByResources(
    items,
    async (item) =>
      (await canonical.modelOwners(
        item.definitionId,
        item.type,
        item.modelName ?? item.definitionId,
        "model",
      )).map((owner) => ({
        ...owner,
        fields: { ...owner.fields, methodName: item.methodName },
      })),
    socket,
    principal,
    "read",
    ctx,
  );
}

/**
 * The normalized model type for authorization, or the raw string when it
 * does not parse — the operation then reports the invalid type itself,
 * inside its own error handling.
 */
function normalizedTypeOrRaw(typeArg: string): string {
  try {
    return ModelType.create(typeArg).normalized;
  } catch {
    return typeArg;
  }
}
