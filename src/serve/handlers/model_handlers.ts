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
  modelCreate,
  modelDelete,
  modelDeletePreview,
  modelEdit,
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
  typeDescribe,
  typeSearch,
  type TypeSearchDeps,
} from "../../libswamp/mod.ts";
import { createModelMethodRunDeps } from "../deps.ts";
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
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { acquireModelLocks } from "../../cli/repo_context.ts";
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
import { modelRegistry } from "../../domain/models/model.ts";
import { RegistryCapacityError } from "../active_run_registry.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import { deleteActiveRun, writeActiveRun } from "../active_run_tracker.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  isAdminOnlyModelType,
  sanitizeErrorForClient,
  send,
  sendError,
  subscribeUntilDetach,
} from "./shared.ts";

const logger = getSwampLogger(["serve", "connection"]);

const DEFAULT_BUFFER_CAPACITY = 10_000;

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
    const initiatedBy = principal ? principalToString(principal) : "ghost";
    const telemetry = createCommandTelemetry(initiatedBy);
    try {
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

      if (
        isAdminOnlyModelType(
          payload.typeArg,
          preResult?.type.normalized,
          ctx.authConfig.restrictedModelTypes,
        )
      ) {
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
            modelIdOrName: payload.modelIdOrName,
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
        await runWithParentTrace(traceCtx, runMethod);
      } else {
        await runMethod();
      }
      await telemetry?.finish(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        sendError(socket, requestId, "cancelled", "Operation was cancelled");
      } else {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "method_execution_failed", message);
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
  let preResult: Awaited<
    ReturnType<typeof findDefinitionByIdOrName>
  >;
  try {
    preResult = await findDefinitionByIdOrName(
      ctx.repoContext.definitionRepo,
      payload.modelIdOrName,
    );
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "method_execution_failed", message);
    return;
  }

  const modelFields: Record<string, unknown> = {};
  if (preResult) {
    modelFields.modelType = preResult.type.normalized;
    modelFields.name = preResult.definition.name;
    const tags = preResult.definition.tags;
    if (tags && Object.keys(tags).length > 0) modelFields.tags = tags;
  }

  if (
    isAdminOnlyModelType(
      payload.typeArg,
      preResult?.type.normalized,
      ctx.authConfig.restrictedModelTypes,
    )
  ) {
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
      resourceName: payload.modelIdOrName,
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
        : "Too many concurrent runs; wait for active runs to complete";
      sendError(socket, requestId, err.code, clientMsg);
    } else {
      sendError(socket, requestId, "internal_error", "Run registration failed");
    }
    return;
  }

  const detachedTelemetry = createCommandTelemetry(initiatedBy);

  (async () => {
    let flushLocks: (() => Promise<void>) | null = null;
    try {
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
            modelIdOrName: payload.modelIdOrName,
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
        await runWithParentTrace(traceCtx, doRun);
      } else {
        await doRun();
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
      } else {
        buffer.finish({
          kind: "error",
          code: "method_execution_failed",
          message: sanitizeErrorForClient(error),
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
      resourceName: payload.modelIdOrName,
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

export async function handleModelMethodDescribe(
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

export async function handleModelGet(
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
    const deps = await createModelCreateDeps(
      ctx.repoDir,
      ctx.managedDefinitionsDir,
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

    if (ctx.syncService) {
      ctx.syncService.markDirty();
      await ctx.syncService.pushChanged();
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

export async function handleModelDelete(
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
    const deps = createModelDeleteDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
    );

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

    if (ctx.syncService) {
      ctx.syncService.markDirty();
      await ctx.syncService.pushChanged();
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

export async function handleModelOutputGet(
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

export async function handleModelOutputData(
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
    const deps = createModelOutputDataDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
    );

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

export async function handleModelOutputLogs(
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
    const deps = createModelOutputLogsDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
    );

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

export async function handleModelOutputSearch(
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

export async function handleModelMethodHistoryGet(
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

export async function handleModelMethodHistoryLogs(
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

export async function handleModelMethodHistorySearch(
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

export async function handleModelValidate(
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
    const deps = createModelValidateDeps(
      ctx.repoDir,
      {
        labels: payload?.labels,
        method: payload?.method,
      },
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.catalogStore,
    );

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

export async function handleModelEvaluate(
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
    const deps = createModelEvaluateDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.catalogStore,
    );

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

export async function handleModelEdit(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelEditPayload,
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
    const deps = createModelEditDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelEdit(libCtx, deps, {
        modelIdOrName: payload.modelIdOrName,
        stdinContent: payload.content,
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
      type: "model.edit",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_edit_failed", message);
  }
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "model",
      name: "*",
      fields: {},
    }, ctx)
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
