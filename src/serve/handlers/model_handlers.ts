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
  createModelEvaluateDeps,
  createModelGetDeps,
  createModelMethodDescribeDeps,
  createModelMethodHistoryLogsDeps,
  createModelOutputDataDeps,
  createModelOutputGetDeps,
  createModelOutputLogsDeps,
  createModelValidateDeps,
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
} from "../../libswamp/mod.ts";
import { createModelMethodRunDeps } from "../deps.ts";
import { serializeEvent } from "../serializer.ts";
import type {
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
import type { Principal } from "../../domain/access/principal.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  isAccessModelType,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";

const logger = getSwampLogger(["serve", "connection"]);

export async function handleModelMethodRun(
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
      { directExecution: isDirectExecution, runTracker: ctx.runTracker },
    );
    const libCtx = createLibSwampContext({ signal: controller.signal });

    // Register method run in cancel registry using the requestId as executionId
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
