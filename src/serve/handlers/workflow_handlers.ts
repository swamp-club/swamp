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
import {
  resolveResumableRun,
  resolveSuspendedRun,
} from "../../domain/workflows/suspended_run_resolver.ts";
import {
  createWorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  type StepLockHook,
  WorkflowExecutionService,
} from "../../domain/workflows/execution_service.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { createEphemeralStore } from "../../infrastructure/persistence/ephemeral_store.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  extractTraceContext,
  runWithParentTrace,
} from "../../infrastructure/tracing/mod.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { RegistryCapacityError } from "../active_run_registry.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import {
  deleteActiveRun,
  rekeyActiveRun,
  writeActiveRun,
} from "../active_run_tracker.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  sanitizeErrorForClient,
  send,
  sendError,
  subscribeUntilDetach,
} from "./shared.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { join } from "@std/path";
import {
  readServeConfigFile,
  SERVE_CONFIG_PATH,
  type TriggerOverrideEntry,
  validateTriggerOverrideEntry,
  writeServeConfigFile,
} from "../serve_config.ts";

const logger = getSwampLogger(["serve", "connection"]);
const DEFAULT_BUFFER_CAPACITY = 10_000;

export async function handleWorkflowRun(
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
      } else {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "workflow_execution_failed", message);
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
      } else {
        buffer.finish({
          kind: "error",
          code: "workflow_execution_failed",
          message: sanitizeErrorForClient(error),
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

export async function handleWorkflowApprovals(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
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

    send(socket, {
      type: "workflow.approvals",
      id: requestId,
      payload: { data: result ?? {} },
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

export async function handleWorkflowHistoryGet(
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

export async function handleWorkflowHistoryLogs(
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

export async function handleWorkflowHistorySearch(
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
        ctx.repoContext.workflowRunRepo.findAllSummariesFromIndex(
          createWorkflowId(id),
        ),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowHistorySearch(libCtx, deps, {
        query: payload?.query,
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

export async function handleWorkflowRunSearch(
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

export async function handleWorkflowSchema(
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

export async function handleWorkflowApprove(
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

export async function handleWorkflowReject(
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
  if (
    !authorizeOrReject(socket, requestId, principal, "run", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: { name: payload.workflowIdOrName },
    }, ctx)
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

      await createWorkflowRunDeps(
        ctx.repoDir,
        ctx.repoContext,
        ctx.datastoreConfig,
        stepLockHook,
      );

      const resumeInputs = payload.inputs ?? {};
      const ephemeral = createEphemeralStore(
        ctx.repoContext.unifiedDataRepo.namespace,
        { isResume: true },
      );

      const resolver = new DefaultDatastorePathResolver(
        ctx.repoDir,
        ctx.datastoreConfig,
      );
      const service = new WorkflowExecutionService(
        workflowRepo,
        runRepo,
        ctx.repoDir,
        undefined,
        resolver.resolvePath(SWAMP_SUBDIRS.data),
        ctx.repoContext.catalogStore,
        undefined,
        ctx.repoContext.markDirty,
        ctx.repoContext.unifiedDataRepo.namespace,
        stepLockHook,
        ctx.runTracker,
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
      } else {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "workflow_resume_failed", message);
      }
    }
    return;
  }

  // Resolve the run before spawning the detached task so we can fail
  // fast with an error frame if the run doesn't exist.
  const workflowRepo = ctx.repoContext.workflowRepo;
  const runRepo = ctx.repoContext.workflowRunRepo;

  let resolvedRun: WorkflowRun;
  let workflowName: string;
  try {
    const result = payload.from
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
    resolvedRun = result.run;
    workflowName = result.workflowName;
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_resume_failed", message);
    return;
  }

  const buffer = new RunEventBuffer(DEFAULT_BUFFER_CAPACITY);
  const runController = new AbortController();
  const runId: string = resolvedRun.id;
  const startedAt = new Date();

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  try {
    registry.register({
      runId,
      kind: "workflow-resume",
      resourceName: payload.workflowIdOrName,
      buffer,
      controller: runController,
      startedAt,
      completion,
      principalId: principal ? principalToString(principal) : null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("Detached workflow resume rejected: {error}", {
      error: detail,
    });
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

    let ephemeral: ReturnType<typeof createEphemeralStore> | null = null;
    try {
      await createWorkflowRunDeps(
        ctx.repoDir,
        ctx.repoContext,
        ctx.datastoreConfig,
        stepLockHook,
      );

      ephemeral = createEphemeralStore(
        ctx.repoContext.unifiedDataRepo.namespace,
        { isResume: true },
      );

      const resolver = new DefaultDatastorePathResolver(
        ctx.repoDir,
        ctx.datastoreConfig,
      );
      const service = new WorkflowExecutionService(
        workflowRepo,
        runRepo,
        ctx.repoDir,
        undefined,
        resolver.resolvePath(SWAMP_SUBDIRS.data),
        ctx.repoContext.catalogStore,
        undefined,
        ctx.repoContext.markDirty,
        ctx.repoContext.unifiedDataRepo.namespace,
        stepLockHook,
        ctx.runTracker,
        ephemeral.repo,
        ephemeral.catalog,
      );

      const doResume = async () => {
        for await (
          const event of service.resume(workflowName, resolvedRun.id, {
            signal: runController.signal,
            inputs: payload.inputs ?? {},
            fromStep: payload.from,
          })
        ) {
          const mapped = mapWorkflowExecutionEvent(event, runRepo);
          const serialized = serializeEvent(
            mapped as { kind: string; [key: string]: unknown },
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
        await runWithParentTrace(traceCtx, doResume);
      } else {
        await doResume();
      }

      buffer.finish({ kind: "done" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        buffer.finish({
          kind: "error",
          code: "cancelled",
          message: "Operation was cancelled",
        });
      } else {
        buffer.finish({
          kind: "error",
          code: "workflow_resume_failed",
          message: sanitizeErrorForClient(error),
        });
      }
    } finally {
      try {
        ephemeral?.dispose();
      } catch (disposeErr) {
        logger.warn("Failed to dispose ephemeral store: {error}", {
          error: disposeErr instanceof Error
            ? disposeErr.message
            : String(disposeErr),
        });
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
    logger.warn("Unhandled error in detached workflow resume: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (ctx.controlPlaneStore && ctx.instanceId) {
    writeActiveRun(ctx.controlPlaneStore, ctx.instanceId, runId, {
      resourceName: payload.workflowIdOrName,
      runKind: "workflow-resume",
      startedAt: startedAt.toISOString(),
    });
  }

  await subscribeUntilDetach(buffer, socket, requestId, controller);
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
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowCreateDeps(ctx.repoDir);

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
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowDeleteDeps(ctx.repoDir, ctx.datastoreResolver);

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
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.workflowIdOrName,
      fields: {},
    }, ctx)
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
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload?.workflowIdOrName ?? "*",
      fields: {},
    }, ctx)
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
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload?.workflowIdOrName ?? "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createWorkflowEvaluateDeps(
      ctx.repoDir,
      ctx.repoContext.workflowRepo,
      ctx.datastoreResolver,
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
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.workflowName,
      fields: {},
    }, ctx)
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
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "workflow",
      name: payload.workflowName,
      fields: {},
    }, ctx)
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
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: payload.workflowName,
      fields: {},
    }, ctx)
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
