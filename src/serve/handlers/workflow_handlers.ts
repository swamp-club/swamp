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
 * Workflow-domain request handlers (workflow.* verbs).
 */

import {
  consumeStream,
  createLibSwampContext,
  createWorkflowApprovalsDeps,
  createWorkflowApproveDeps,
  createWorkflowCreateDeps,
  createWorkflowDeleteDeps,
  createWorkflowEditDeps,
  createWorkflowEvaluateDeps,
  createWorkflowGetDeps,
  createWorkflowHistoryGetDeps,
  createWorkflowHistoryLogsDeps,
  createWorkflowRejectDeps,
  createWorkflowValidateDeps,
  mapWorkflowExecutionEvent,
  workflowApprovals,
  type WorkflowApprovalsEvent,
  workflowApprove,
  type WorkflowApproveData,
  workflowCreate,
  workflowDelete,
  workflowEdit,
  workflowEvaluate,
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
  workflowsDirFor,
  workflowSearch,
  type WorkflowSearchDeps,
  workflowValidate,
} from "../../libswamp/mod.ts";
import { createWorkflowRunDeps, executeWorkflowWithLocks } from "../deps.ts";
import { serializeEvent } from "../serializer.ts";
import type {
  WorkflowApprovePayload,
  WorkflowCreatePayload,
  WorkflowDeletePayload,
  WorkflowEditPayload,
  WorkflowEvaluatePayload,
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
  WorkflowTriggerGetPayload,
  WorkflowTriggerRemovePayload,
  WorkflowTriggerSetPayload,
  WorkflowValidatePayload,
} from "../protocol.ts";
import { acquireModelLocks } from "../../cli/repo_context.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import {
  resolveResumableRun,
  resolveSuspendedRun,
} from "../../domain/workflows/suspended_run_resolver.ts";
import {
  createWorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type { StepLockHook } from "../../domain/workflows/execution_service.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { createEphemeralStore } from "../../infrastructure/persistence/ephemeral_store.ts";
import {
  extractTraceContext,
  runWithParentTrace,
} from "../../infrastructure/tracing/mod.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { RegistryCapacityError } from "../active_run_registry.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import {
  autoResumeAfterApproval,
  startDetachedResume,
} from "../resume_launcher.ts";
import {
  deleteActiveRun,
  rekeyActiveRun,
  writeActiveRun,
} from "../active_run_tracker.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  type ConnectionContext,
  exceptionTypeForClient,
  filterByAuthorization,
  lockTimeoutErrorForClient,
  paginate,
  pushChangedToRemote,
  sanitizeErrorForClient,
  send,
  sendError,
  subscribeUntilDetach,
} from "./shared.ts";
import { resolveDataFields } from "./data_handlers.ts";
import type { ResourceReadPolicy } from "../../domain/workflows/step_output_resolver.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import {
  readServeConfigFile,
  SERVE_CONFIG_PATH,
  type ServeConfigFile,
  type TriggerOverrideEntry,
  validateTriggerOverrideEntry,
  writeServeConfigFile,
} from "../serve_config.ts";
import type { TriggerOverride } from "../../libswamp/mod.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";

const logger = getSwampLogger(["serve", "connection"]);
const DEFAULT_BUFFER_CAPACITY = 10_000;
/** Page size for `workflow.run.search` when the client sends no limit. */
export const WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT = 500;

export async function resolveWorkflowFields(
  workflowRepo: WorkflowRepository,
  idOrName: string,
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = { name: idOrName };
  try {
    const workflow = await workflowRepo.findByName(idOrName) ??
      await workflowRepo.findById(createWorkflowId(idOrName));
    if (workflow) {
      fields.name = workflow.name;
      const tags = workflow.tags;
      if (tags && Object.keys(tags).length > 0) fields.tags = tags;
    }
  } catch {
    // Fall back to name-only fields on lookup failure
  }
  return fields;
}

export async function handleWorkflowRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowRunPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "run", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  const initiatedBy = principal ? principalToString(principal) : "ghost";
  const registry = ctx.activeRunRegistry;
  if (!registry) {
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
          skipAllReports: payload.skipAllReports,
          skipReportNames: payload.skipReportNames,
          skipReportLabels: payload.skipReportLabels,
          reportNames: payload.reportNames,
          reportLabels: payload.reportLabels,
          skipAllChecks: payload.skipAllChecks,
          skipCheckNames: payload.skipCheckNames,
          skipCheckLabels: payload.skipCheckLabels,
          traceparent: payload.traceparent,
          tracestate: payload.tracestate,
          noSupersede: payload.noSupersede,
          initiatedBy,
          instanceId: ctx.instanceId,
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
        ctx.runTracker,
        { triggerSource: "api", initiatedBy },
      );
      send(socket, { type: "done", id: requestId });
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
          "workflow_execution_failed",
          message,
          exType !== undefined ? { exceptionType: exType } : undefined,
        );
      }
    } finally {
      if (registeredRunId && ctx.cancelRegistry) {
        ctx.cancelRegistry.deregister("workflow-run", registeredRunId);
      }
    }
    return;
  }

  const buffer = new RunEventBuffer(DEFAULT_BUFFER_CAPACITY);
  const runController = new AbortController();
  let runId: string = crypto.randomUUID();
  const startedAt = new Date();

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  try {
    registry.register({
      runId,
      kind: "workflow-run",
      resourceName: payload.workflowIdOrName,
      buffer,
      controller: runController,
      startedAt,
      completion,
      principalId: principal ? principalToString(principal) : null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("Detached workflow run rejected: {error}", { error: detail });
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

  (async () => {
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
          skipAllReports: payload.skipAllReports,
          skipReportNames: payload.skipReportNames,
          skipReportLabels: payload.skipReportLabels,
          reportNames: payload.reportNames,
          reportLabels: payload.reportLabels,
          skipAllChecks: payload.skipAllChecks,
          skipCheckNames: payload.skipCheckNames,
          skipCheckLabels: payload.skipCheckLabels,
          traceparent: payload.traceparent,
          tracestate: payload.tracestate,
          noSupersede: payload.noSupersede,
          initiatedBy,
          instanceId: ctx.instanceId,
        },
        runController.signal,
        (event) => {
          if (event.kind === "started") {
            const domainRunId = (event as { runId: string }).runId;
            if (domainRunId && domainRunId !== runId) {
              if (registry.rekey(runId, domainRunId)) {
                const oldRunId = runId;
                runId = domainRunId;
                if (ctx.controlPlaneStore && ctx.instanceId) {
                  rekeyActiveRun(
                    ctx.controlPlaneStore,
                    ctx.instanceId,
                    oldRunId,
                    domainRunId,
                    {
                      resourceName: payload.workflowIdOrName,
                      runKind: "workflow-run",
                      startedAt: startedAt.toISOString(),
                    },
                  );
                }
              }
            }
          }
          const serialized = serializeEvent(
            event as { kind: string; [key: string]: unknown },
          );
          buffer.push(serialized);
        },
        ctx.syncService,
        ctx.runTracker,
        { triggerSource: "api", initiatedBy },
      );
      buffer.finish({ kind: "done" });
    } catch (error) {
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
          code: "workflow_execution_failed",
          message: sanitizeErrorForClient(error),
          ...(exType !== undefined && {
            details: { exceptionType: exType },
          }),
        });
      }
    } finally {
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
    logger.warn("Unhandled error in detached workflow run: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (ctx.controlPlaneStore && ctx.instanceId) {
    writeActiveRun(ctx.controlPlaneStore, ctx.instanceId, runId, {
      resourceName: payload.workflowIdOrName,
      runKind: "workflow-run",
      startedAt: startedAt.toISOString(),
    });
  }

  await subscribeUntilDetach(buffer, socket, requestId, controller);
}

export async function handleWorkflowSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: WorkflowSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "workflow",
      ctx,
    )
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

    const data = (result ?? {}) as {
      results?: Array<{ name: string }>;
    };
    const { page, total } = paginate(
      filterByAuthorization(
        data.results ?? [],
        (item) => item.name,
        (item) => ({ name: item.name }),
        socket,
        principal,
        "read",
        "workflow",
        ctx,
      ),
      payload?.offset,
      payload?.limit,
    );
    data.results = page;

    send(socket, {
      type: "workflow.search",
      id: requestId,
      payload: { data, total },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_search_failed", message);
  }
}

export async function handleWorkflowApprovals(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "workflow",
      ctx,
    )
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const runRepo = ctx.repoContext.workflowRunRepo;
    const evaluatedRepo = new YamlEvaluatedWorkflowRepository(ctx.repoDir);
    const deps = createWorkflowApprovalsDeps(
      ctx.repoContext.workflowRepo,
      runRepo,
      async (workflowId) => {
        const suspended = await runRepo
          .findSummariesByStatus(workflowId, "suspended");
        const runs = await Promise.all(
          suspended.map((s) =>
            runRepo.findById(workflowId, s.id as WorkflowRunId)
          ),
        );
        return runs.filter((r): r is WorkflowRun => r !== null);
      },
      (workflowId) => evaluatedRepo.findById(workflowId),
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream<WorkflowApprovalsEvent>(
      workflowApprovals(libCtx, deps),
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
      approvals?: Array<{ workflowName: string }>;
    };
    if (data.approvals) {
      data.approvals = filterByAuthorization(
        data.approvals,
        (item) => item.workflowName,
        (item) => ({ name: item.workflowName }),
        socket,
        principal,
        "read",
        "workflow",
        ctx,
      );
    }

    send(socket, {
      type: "workflow.approvals",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_approvals_failed", message);
  }
}

export async function handleWorkflowGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: workflowFields,
    }, ctx).allowed
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

/**
 * Limits step outputs in workflow history to resources the principal may
 * read as data. Reading a workflow's history must not reveal a model's data
 * that `data.get` would refuse, so each resource goes through the same data
 * read decision, keyed by the model's definition fields.
 */
function dataReadPolicy(
  socket: WebSocket,
  ctx: ConnectionContext,
  principal: Principal | null,
): ResourceReadPolicy {
  const fieldsByModel = new Map<string, Promise<Record<string, unknown>>>();
  return async (ref) => {
    let fields = fieldsByModel.get(ref.modelId);
    if (!fields) {
      fields = resolveDataFields(ctx.repoContext.definitionRepo, ref.modelId);
      fieldsByModel.set(ref.modelId, fields);
    }
    const resolved = await fields;
    return filterByAuthorization(
      [ref],
      () => resolved.name as string,
      () => resolved,
      socket,
      principal,
      "read",
      "data",
      ctx,
    ).length === 1;
  };
}

export async function handleWorkflowHistoryGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowHistoryGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowHistoryGetDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.workflowRepo,
      dataReadPolicy(socket, ctx, principal),
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowHistoryGet(libCtx, deps, payload.workflowIdOrName, {
        includeOutputs: true,
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

export async function handleWorkflowHistoryLogs(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowHistoryLogsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.runIdOrWorkflow,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload.runIdOrWorkflow,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowHistoryLogsDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
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

export async function handleWorkflowHistorySearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: WorkflowHistorySearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "workflow",
      ctx,
    )
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: WorkflowHistorySearchDeps = {
      findAllWorkflows: () => ctx.repoContext.workflowRepo.findAll(),
      findAllRunsByWorkflowId: (id) =>
        ctx.repoContext.workflowRunRepo.findAllSummariesFromIndex(
          createWorkflowId(id),
        ),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowHistorySearch(libCtx, deps, {
        query: payload?.query,
        workflow: payload?.workflow,
        inputs: payload?.inputs,
        filter: payload?.filter,
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
      results?: Array<{ workflowName: string }>;
    };
    if (data.results) {
      data.results = filterByAuthorization(
        data.results,
        (item) => item.workflowName,
        (item) => ({ name: item.workflowName }),
        socket,
        principal,
        "read",
        "workflow",
        ctx,
      );
    }

    send(socket, {
      type: "workflow.history.search",
      id: requestId,
      payload: { data },
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

export async function handleWorkflowRunSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: WorkflowRunSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "workflow",
      ctx,
    )
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps: WorkflowRunSearchDeps = {
      findAllWorkflows: () => ctx.repoContext.workflowRepo.findAll(),
      findAllRunsByWorkflowId: (id) =>
        ctx.repoContext.workflowRunRepo
          .findAllSummariesFromIndex(createWorkflowId(id)),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowRunSearch(libCtx, deps, {
        query: payload?.query,
        since: payload?.since,
        status: payload?.status,
        workflow: payload?.workflow,
        tags: payload?.tags,
        inputs: payload?.inputs,
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
      results?: Array<{ workflowName: string }>;
    };
    // Page after the authorization filter, never inside libswamp: slicing
    // first would let unreadable runs shorten a page and skew `total`.
    const { page, total } = paginate(
      filterByAuthorization(
        data.results ?? [],
        (item) => item.workflowName,
        (item) => ({ name: item.workflowName }),
        socket,
        principal,
        "read",
        "workflow",
        ctx,
      ),
      payload?.offset,
      payload?.limit ?? WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT,
    );
    data.results = page;

    send(socket, {
      type: "workflow.run.search",
      id: requestId,
      payload: { data, total },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_run_search_failed", message);
  }
}

export async function handleWorkflowSchema(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  _payload: WorkflowSchemaPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "workflow",
      ctx,
    )
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

export async function handleWorkflowApprove(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowApprovePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "approve", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  let result: WorkflowApproveData | undefined;
  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowApproveDeps(
      ctx.repoContext.workflowRepo,
      ctx.repoContext.workflowRunRepo,
    );

    await consumeStream(
      workflowApprove(libCtx, deps, {
        workflowIdOrName: payload.workflowIdOrName,
        stepName: payload.stepName,
        reason: payload.reason,
        runId: payload.runId,
        decidedBy: principal ? principalToString(principal) : payload.decidedBy,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data;
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
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_approve_failed", message);
    return;
  } finally {
    await pushChangedToRemote(ctx);
  }

  // Launched only once the approval is saved and pushed. The resume runs
  // detached and is never awaited here: this handler holds the sync gate,
  // which is not reentrant.
  // The approval is already saved: a failure deciding or launching the
  // auto-resume must not cost the client its reply.
  let autoResumed = false;
  try {
    autoResumed = await autoResumeAfterApproval(
      ctx,
      result,
      principal ? principalToString(principal) : null,
    );
  } catch (error) {
    logger.warn("Auto-resume after approval of run {runId} failed: {error}", {
      runId: result.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  send(socket, {
    type: "workflow.approve",
    id: requestId,
    payload: { data: { ...result, autoResumed } },
  });
}

export async function handleWorkflowReject(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowRejectPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "approve", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowRejectDeps(
      ctx.repoContext.workflowRepo,
      ctx.repoContext.workflowRunRepo,
      ctx.runTracker,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowReject(libCtx, deps, {
        workflowIdOrName: payload.workflowIdOrName,
        stepName: payload.stepName,
        reason: payload.reason,
        runId: payload.runId,
        decidedBy: principal ? principalToString(principal) : payload.decidedBy,
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
  } finally {
    await pushChangedToRemote(ctx);
  }
}

export async function handleWorkflowResume(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowResumePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "run", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  const registry = ctx.activeRunRegistry;
  if (!registry) {
    try {
      const workflowRepo = ctx.repoContext.workflowRepo;
      const runRepo = ctx.repoContext.workflowRunRepo;

      const { run, workflowName } = payload.from
        ? await resolveResumableRun(
          workflowRepo,
          runRepo,
          payload.workflowIdOrName,
          payload.runId,
        )
        : await resolveSuspendedRun(
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

      const deps = await createWorkflowRunDeps(
        ctx.repoDir,
        ctx.repoContext,
        ctx.datastoreConfig,
        stepLockHook,
        ctx.runTracker,
      );

      const resumeInputs = payload.inputs ?? {};
      const ephemeral = createEphemeralStore(
        ctx.repoContext.unifiedDataRepo.namespace,
        { isResume: true },
      );

      const service = deps.createExecutionService(
        workflowRepo,
        runRepo,
        ctx.repoDir,
        ctx.repoContext.catalogStore,
        ephemeral.repo,
        ephemeral.catalog,
      );

      const resumeGenerator = async function* (): AsyncGenerator<
        WorkflowRunEvent
      > {
        for await (
          const event of service.resume(workflowName, run.id, {
            signal: controller.signal,
            inputs: resumeInputs,
            fromStep: payload.from,
          })
        ) {
          yield mapWorkflowExecutionEvent(event, runRepo);
        }
      };

      const run_ = async () => {
        try {
          for await (const event of resumeGenerator()) {
            if (socket.readyState !== WebSocket.OPEN) break;
            const serialized = serializeEvent(
              event as { kind: string; [key: string]: unknown },
            );
            send(socket, { type: "event", id: requestId, event: serialized });
          }
        } finally {
          ephemeral.dispose();
        }
        send(socket, { type: "done", id: requestId });
      };

      if (payload.traceparent) {
        const headers: Record<string, string> = {
          traceparent: payload.traceparent,
        };
        if (payload.tracestate) headers.tracestate = payload.tracestate;
        const traceCtx = extractTraceContext(headers);
        await runWithParentTrace(traceCtx, run_);
      } else {
        await run_();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        sendError(socket, requestId, "cancelled", "Operation was cancelled");
      } else if (error instanceof LockTimeoutError) {
        const lt = lockTimeoutErrorForClient(error);
        sendError(socket, requestId, lt.code, lt.message, lt.details);
      } else {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "workflow_resume_failed", message);
      }
    } finally {
      if (ctx.syncService) {
        const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
          ? ctx.datastoreConfig.namespace
          : undefined;
        try {
          await ctx.syncService.pushChanged({ namespace });
        } catch (pushErr) {
          logger.warn(
            "Post-resume push failed; terminal status may be delayed: {error}",
            {
              error: pushErr instanceof Error
                ? pushErr.message
                : String(pushErr),
            },
          );
        }
      }
    }
    return;
  }

  const launched = await startDetachedResume(ctx, registry, {
    workflowIdOrName: payload.workflowIdOrName,
    runId: payload.runId,
    from: payload.from,
    inputs: payload.inputs,
    traceparent: payload.traceparent,
    tracestate: payload.tracestate,
    principalId: principal ? principalToString(principal) : null,
  });
  if (!launched.ok) {
    sendError(socket, requestId, launched.code, launched.message);
    return;
  }

  await subscribeUntilDetach(launched.buffer, socket, requestId, controller);
}

export async function handleWorkflowCreate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowCreatePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.name,
      fields: { name: payload.name },
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowCreateDeps(
      ctx.repoDir,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowCreate(libCtx, deps, { name: payload.name }),
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

    send(socket, {
      type: "workflow.create",
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
          "Failed to push workflow create to remote datastore: {error}",
          {
            error: pushError instanceof Error
              ? pushError.message
              : String(pushError),
          },
        );
      }
    }
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_create_failed", message);
  }
}

export async function handleWorkflowDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowDeleteDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.markDirty,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowDelete(libCtx, deps, {
        workflowIdOrName: payload.workflowIdOrName,
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
      type: "workflow.delete",
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
          "Failed to push workflow delete to remote datastore: {error}",
          {
            error: pushError instanceof Error
              ? pushError.message
              : String(pushError),
          },
        );
      }
    }
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_delete_failed", message);
  }
}

export async function handleWorkflowEdit(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowEditPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowEditDeps(
      ctx.repoDir,
      ctx.repoContext.workflowRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowEdit(libCtx, deps, {
        workflowIdOrName: payload.workflowIdOrName,
        stdinContent: payload.content,
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
      type: "workflow.edit",
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
          "Failed to push workflow edit to remote datastore: {error}",
          {
            error: pushError instanceof Error
              ? pushError.message
              : String(pushError),
          },
        );
      }
    }
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_edit_failed", message);
  }
}

export async function handleWorkflowValidate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowValidatePayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const resourceName = payload?.workflowIdOrName ?? "*";
  const workflowFields = resourceName !== "*"
    ? await resolveWorkflowFields(ctx.repoContext.workflowRepo, resourceName)
    : {};
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: resourceName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowValidateDeps(
      ctx.repoContext.workflowRepo,
      ctx.repoContext.definitionRepo,
      workflowsDirFor(ctx.repoDir),
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowValidate(libCtx, deps, {
        workflowIdOrName: payload?.workflowIdOrName,
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
      type: "workflow.validate",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_validate_failed", message);
  }
}

export async function handleWorkflowEvaluate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowEvaluatePayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const resourceName = payload?.workflowIdOrName ?? "*";
  const workflowFields = resourceName !== "*"
    ? await resolveWorkflowFields(ctx.repoContext.workflowRepo, resourceName)
    : {};
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: resourceName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowEvaluateDeps(
      ctx.repoDir,
      ctx.repoContext.workflowRepo,
      ctx.datastoreResolver,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowEvaluate(libCtx, deps, {
        workflowIdOrName: payload?.workflowIdOrName,
        inputs: payload?.inputs ?? {},
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
      type: "workflow.evaluate",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_evaluate_failed", message);
  }
}

// ── Workflow trigger override handlers ──────────────────────────────

export async function handleWorkflowTriggerSet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowTriggerSetPayload,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.workflowName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const entry: TriggerOverrideEntry = {
      schedule: payload.schedule,
      ...(payload.inputs && Object.keys(payload.inputs).length > 0
        ? { inputs: payload.inputs }
        : {}),
    };

    const configPath = join(ctx.repoDir, SERVE_CONFIG_PATH);
    validateTriggerOverrideEntry(entry, configPath, payload.workflowName);

    const config = await readServeConfigFile(ctx.repoDir) ?? {};
    const triggers = config.triggers ?? {};
    triggers[payload.workflowName] = entry;
    config.triggers = triggers;
    await writeServeConfigFile(ctx.repoDir, config);

    await applyTriggerOverrides(ctx, config);

    send(socket, {
      type: "workflow.trigger.set",
      id: requestId,
      payload: {
        data: { workflowName: payload.workflowName, entry },
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_trigger_set_failed", message);
  }
}

export async function handleWorkflowTriggerGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowTriggerGetPayload,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload.workflowName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const config = await readServeConfigFile(ctx.repoDir);
    const override: TriggerOverrideEntry | null =
      config?.triggers?.[payload.workflowName] ?? null;

    let builtIn:
      | { schedule: string | null; inputs: Record<string, unknown> }
      | null = null;
    const workflow = await ctx.repoContext.workflowRepo.findByName(
      payload.workflowName,
    );
    if (workflow) {
      builtIn = {
        schedule: workflow.schedule ?? null,
        inputs: workflow.triggerInputs ?? {},
      };
    }

    const effective = {
      schedule: override?.schedule ?? builtIn?.schedule ?? null,
      inputs: {
        ...(builtIn?.inputs ?? {}),
        ...(override?.inputs ?? {}),
      },
    };

    send(socket, {
      type: "workflow.trigger.get",
      id: requestId,
      payload: {
        data: {
          workflowName: payload.workflowName,
          builtIn,
          override,
          effective,
        },
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_trigger_get_failed", message);
  }
}

export async function handleWorkflowTriggerRemove(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowTriggerRemovePayload,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const workflowFields = await resolveWorkflowFields(
    ctx.repoContext.workflowRepo,
    payload.workflowName,
  );
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.workflowName,
      fields: workflowFields,
    }, ctx).allowed
  ) return;

  try {
    const config = await readServeConfigFile(ctx.repoDir);
    if (!config?.triggers?.[payload.workflowName]) {
      sendError(
        socket,
        requestId,
        "not_found",
        `No trigger override found for workflow '${payload.workflowName}' in serve.yaml`,
      );
      return;
    }

    delete config.triggers[payload.workflowName];
    if (Object.keys(config.triggers).length === 0) {
      delete config.triggers;
    }
    await writeServeConfigFile(ctx.repoDir, config);

    await applyTriggerOverrides(ctx, config);

    send(socket, {
      type: "workflow.trigger.remove",
      id: requestId,
      payload: {
        data: { workflowName: payload.workflowName },
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_trigger_remove_failed", message);
  }
}

export async function applyTriggerOverrides(
  ctx: ConnectionContext,
  config: ServeConfigFile,
): Promise<void> {
  if (!ctx.scheduledExecution) return;
  try {
    const overrides = new Map<string, TriggerOverride>(
      config.triggers ? Object.entries(config.triggers) : [],
    );
    await ctx.scheduledExecution.updateTriggerOverrides(overrides);
  } catch (err: unknown) {
    logger.warn(
      "Failed to apply trigger overrides to running scheduler: {error}",
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}
