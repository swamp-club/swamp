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
  createWorkflowApproveDeps,
  createWorkflowGetDeps,
  createWorkflowHistoryGetDeps,
  createWorkflowHistoryLogsDeps,
  createWorkflowRejectDeps,
  mapWorkflowExecutionEvent,
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
} from "../../libswamp/mod.ts";
import { createWorkflowRunDeps, executeWorkflowWithLocks } from "../deps.ts";
import { serializeEvent } from "../serializer.ts";
import type {
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
} from "../protocol.ts";
import { acquireModelLocks } from "../../cli/repo_context.ts";
import { resolveSuspendedRun } from "../../domain/workflows/suspended_run_resolver.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
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
  authorizeOrReject,
  type ConnectionContext,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";

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
        })
      ) {
        yield mapWorkflowExecutionEvent(event, runRepo);
      }
    };

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
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else {
      const message = sanitizeErrorForClient(error);
      sendError(socket, requestId, "workflow_resume_failed", message);
    }
  }
}
