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

import { consumeStream } from "../../libswamp/stream.ts";
import {
  createWorkflowApprovalsDeps,
  workflowApprovals,
  type WorkflowApprovalsEvent,
} from "../../libswamp/workflows/approvals.ts";
import {
  createWorkflowApproveDeps,
  workflowApprove,
  type WorkflowApproveData,
} from "../../libswamp/workflows/approve.ts";
import {
  createWorkflowCreateDeps,
  workflowCreate,
} from "../../libswamp/workflows/create.ts";
import {
  createWorkflowDeleteDeps,
  workflowDelete,
} from "../../libswamp/workflows/delete.ts";
import {
  createWorkflowEditDeps,
  workflowEdit,
  type WorkflowEditTarget,
} from "../../libswamp/workflows/edit.ts";
import {
  createWorkflowEvaluateDeps,
  workflowEvaluate,
} from "../../libswamp/workflows/evaluate.ts";
import {
  createWorkflowGetDeps,
  workflowGet,
} from "../../libswamp/workflows/get.ts";
import {
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
} from "../../libswamp/workflows/history_get.ts";
import {
  createWorkflowHistoryLogsDeps,
  workflowHistoryLogs,
} from "../../libswamp/workflows/history_logs.ts";
import {
  createWorkflowRejectDeps,
  workflowReject,
  type WorkflowRejectData,
} from "../../libswamp/workflows/reject.ts";
import {
  createWorkflowValidateDeps,
  workflowValidate,
} from "../../libswamp/workflows/validate.ts";
import {
  createWorkflowWaitsDeps,
  workflowWaits,
  type WorkflowWaitsData,
  type WorkflowWaitsEvent,
} from "../../libswamp/workflows/waits.ts";
import type { DetachedNestedRunData } from "../../libswamp/workflows/nested_runs.ts";
import {
  mapWorkflowExecutionEvent,
  type WorkflowRunEvent,
} from "../../libswamp/workflows/run.ts";
import { resolveRunReference } from "../../libswamp/workflows/run_reference.ts";
import {
  workflowHistorySearch,
  type WorkflowHistorySearchDeps,
} from "../../libswamp/workflows/history_search.ts";
import {
  workflowRunSearch,
  type WorkflowRunSearchDeps,
} from "../../libswamp/workflows/run_search.ts";
import { workflowSchema } from "../../libswamp/workflows/schema.ts";
import { workflowsDirFor } from "../../libswamp/workflows/broken_workflow.ts";
import {
  workflowSearch,
  type WorkflowSearchDeps,
} from "../../libswamp/workflows/search.ts";
import {
  createStepLockHook,
  createWorkflowRunDeps,
  executeWorkflowWithLocks,
} from "../deps.ts";
import {
  requestRunVaultScope,
  resumeRunVaultScope,
  runVaultScopeContext,
} from "../run_vault_access_policy.ts";
import { runGeneratorWithVaultAccess } from "../../domain/vaults/run_vault_access.ts";
import { withSharedSyncGate } from "../sync_gate.ts";
import { isWireEvent, serializeEvent } from "../serializer.ts";
import type {
  WorkflowApprovePayload,
  WorkflowCancelPayload,
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
  WorkflowSignalPayload,
  WorkflowTriggerGetPayload,
  WorkflowTriggerRemovePayload,
  WorkflowTriggerSetPayload,
  WorkflowValidatePayload,
} from "../protocol.ts";
import {
  resolveResumableRun,
  resolveSuspendedRun,
} from "../../domain/workflows/suspended_run_resolver.ts";
import {
  createWorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { unclaimedRuns } from "../../domain/workflows/run_claim.ts";
import { NestedRunPendingError } from "../../domain/workflows/nested_run_link.ts";
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
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { runInRootUnitOfWork } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import { RegistryCapacityError } from "../active_run_registry.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import {
  type NamedWorkflow,
  nestedGateRefusalForClient,
  nestedPendingRefusalForClient,
  nestedRunReadDecider,
  readableNestedRuns,
  redactingFor,
  redactParentRun,
  redactRunViewLinks,
  redactStreamEvent,
} from "./nested_run_redaction.ts";
import {
  autoResumeAfterApproval,
  autoResumeParentAfterChild,
  startDetachedResume,
} from "../resume_launcher.ts";
import {
  awaitAbortedRun,
  cancelSuspendedRunAndPush,
  SUSPENDED_RUN_BUSY_MESSAGE,
  type SuspendedRunCancelResult,
} from "../suspended_run_cancel.ts";
import {
  deleteActiveRun,
  rekeyActiveRun,
  writeActiveRun,
} from "../active_run_tracker.ts";
import {
  accessCallerOf,
  authorizeAnyOrReject,
  authorizeOrReject,
  cancelActor,
  cancelReasonFor,
  captureDecisionSubject,
  clientErrorDetails,
  type ConnectionContext,
  exceptionTypeForClient,
  filterByResources,
  handlerLibSwampContext,
  isAuthorized,
  LibSwampStreamError,
  lockTimeoutErrorForClient,
  paginate,
  pushChangedToRemote,
  recordAuditedResource,
  rejectEditWithoutContent,
  resourceDecider,
  sanitizeErrorForClient,
  send,
  sendError,
  subscribeUntilDetach,
  wasRequestErrored,
} from "./shared.ts";
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
import type { TriggerOverride } from "../../libswamp/workflows/scheduled_execution.ts";
import type { WorkflowRunView } from "../../libswamp/workflows/workflow_run_view.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../../domain/workflows/workflow_lookup.ts";
import {
  authorizeReferenceAccess,
  authorizeResolved,
  canonicalResources,
  resolveRecordedWorkflow,
  resolveRunAccess,
  resolveWorkflowTarget,
  type ResourceResolution,
  targetArgument,
  unresolvedAccessResource,
  workflowAccessResource,
} from "./resource_resolution.ts";
import { expressionsAddedByEdit } from "../../domain/expressions/expression_references.ts";
import {
  analyzeWorkflowExpressions,
  isComputedStepTarget,
  readsSelfOrInputs,
  stepRetargetSourcesChanged,
  type StepTarget,
  stepTargetKey,
  workflowStepTargets,
} from "../../domain/workflows/step_targets.ts";
import { authorizeExpressionReferences } from "./expression_reference_authorization.ts";
import { deliverSignalForCaller } from "../signal_delivery.ts";
import { SIGNAL_WAITS_NOT_CONFIGURED } from "../../domain/workflows/signal_wait_store.ts";
import { authorizeStepTargets } from "./workflow_step_authorization.ts";

const logger = getSwampLogger(["serve", "connection"]);
const DEFAULT_BUFFER_CAPACITY = 10_000;
/** Page size for `workflow.run.search` when the client sends no limit. */
export const WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT = 500;

/**
 * Finds a workflow by name, then by id. Returns null when neither matches or
 * the lookup fails.
 */
export async function resolveWorkflow(
  workflowRepo: WorkflowRepository,
  idOrName: string,
): Promise<Workflow | null> {
  try {
    return await findWorkflowByIdOrName(workflowRepo, idOrName);
  } catch {
    return null;
  }
}

/**
 * Resolves the workflow a request names — including a workflow file that
 * fails to parse — so the handler authorizes its canonical name
 * (swamp-club#2674).
 */
function resolveWorkflowRequest(
  ctx: ConnectionContext,
  idOrName: string,
): Promise<ResourceResolution> {
  return resolveWorkflowTarget(
    ctx.repoContext.workflowRepo,
    idOrName,
    workflowsDirFor(ctx.repoDir),
  );
}

/**
 * The refusal for a workflow edit, or undefined when the writer may add
 * everything it adds: expressions that read only what they may read, and
 * steps that run only what they may run. A change to the workflow's inputs
 * or a step's forEach re-checks computed targets that read `inputs` or
 * `self`, since those are what can retarget them.
 */
async function authorizeWorkflowEdit(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
  before: Workflow,
  after: Workflow,
): Promise<string | undefined> {
  // A workflow's inputs.* and self.* come from its input defaults and its
  // steps' forEach, so only a change there can retarget what is stored.
  const retargetable = stepRetargetSourcesChanged(before, after);
  // A step now running a different target sends its inputs somewhere new,
  // so every expression in it is checked again.
  const storedAt = new Map(
    workflowStepTargets(before).map((t) => [t.location, stepTargetKey(t)]),
  );
  const retargetedSteps = workflowStepTargets(after)
    .filter((t) => storedAt.get(t.location) !== stepTargetKey(t))
    .flatMap((t) => (t.location ? [t.location] : []));
  const added = expressionsAddedByEdit(
    analyzeWorkflowExpressions(before),
    analyzeWorkflowExpressions(after),
    retargetable,
    retargetedSteps,
  );
  const refusal = await authorizeExpressionReferences(
    socket,
    requestId,
    principal,
    ctx,
    added,
    "allowed",
  );
  if (refusal) return refusal.message;
  const stored = new Set(workflowStepTargets(before).map(stepTargetKey));
  // A guard or assert that calls model.method runs that method as a step
  // does, so it is held to the same check.
  const expressionRuns: StepTarget[] = added.flatMap(({ references }) =>
    references.runTargets.map(({ model, method }) => ({
      kind: "model" as const,
      modelIdOrName: model,
      methodName: method,
    }))
  );
  return await authorizeStepTargets(
    socket,
    requestId,
    principal,
    ctx,
    [
      ...workflowStepTargets(after).filter((target) =>
        !stored.has(stepTargetKey(target)) ||
        (retargetable && isComputedStepTarget(target) &&
          readsSelfOrInputs(target))
      ),
      ...expressionRuns,
    ],
    ((computed) =>
      computed && {
        raw: computed.raw,
        unanalyzable: computed.references.unanalyzable,
      })(added.find(({ references }) => references.runsComputed)),
  );
}

export function workflowAccessFields(
  target: WorkflowEditTarget,
): Record<string, unknown> {
  return { name: target.name, tags: target.tags ?? {} };
}

export async function handleWorkflowRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowRunPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveWorkflowRequest(ctx, payload.workflowIdOrName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "run",
      target,
      payload.workflowIdOrName,
      "workflow",
      ctx,
      "workflow_execution_failed",
    )
  ) return;
  const workflow = targetArgument(target, payload.workflowIdOrName);
  const resourceName = target.resource.name;
  const resourceId = target.status === "found" ? target.id : undefined;

  const initiatedBy = principal ? principalToString(principal) : "ghost";
  // Captured now, while the socket's memberships are at hand: the run's
  // vault operations are decided for this principal (swamp-club#2676).
  const vaultAccess = requestRunVaultScope(ctx, socket, principal);
  const registry = ctx.activeRunRegistry;
  if (!registry) {
    let registeredRunId: string | undefined;
    // Events are redacted per client before they are sent (swamp-club#2736),
    // which may wait: sends are chained so they keep the run's order, and
    // drained before the request's own reply.
    const redact = redactingFor(ctx, socket, principal);
    let sending = Promise.resolve();
    try {
      await executeWorkflowWithLocks(
        ctx.repoDir,
        ctx.repoContext,
        ctx.datastoreConfig,
        {
          workflowIdOrName: workflow.idOrName,
          byId: workflow.byId,
          expectedName: workflow.expectedName,
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
          // A nested workflow's started event carries the child's run id;
          // the cancel handle belongs to the run this request started.
          if (
            event.kind === "started" && event.parentRunId === undefined &&
            ctx.cancelRegistry
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
          if (!isWireEvent(event)) return;
          const serialized = serializeEvent(
            event as { kind: string; [key: string]: unknown },
          );
          sending = sending.then(async () => {
            const visible = redact ? await redact(serialized) : serialized;
            if (socket.readyState !== WebSocket.OPEN) return;
            send(socket, { type: "event", id: requestId, event: visible });
          }).catch((error) => {
            logger.warn("Failed to send a workflow run event: {error}", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
        ctx.syncService,
        ctx.runTracker,
        {
          syncGate: ctx.syncGate,
          triggerSource: "api",
          initiatedBy,
          vaultAccess,
        },
      );
      await sending;
      send(socket, { type: "done", id: requestId });
    } catch (error) {
      await sending;
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
      resourceName,
      resourceId,
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
        : err.code === "draining"
        ? "Serve is shutting down; try again once it is back"
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
          workflowIdOrName: workflow.idOrName,
          byId: workflow.byId,
          expectedName: workflow.expectedName,
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
          // A nested workflow's started event carries the child's run id;
          // the registry entry stays keyed on the run this request started,
          // and a client reattaching by the child's id finds it.
          if (event.kind === "started" && event.parentRunId !== undefined) {
            registry.addNestedRun(runId, event.runId);
          } else if (event.kind === "started") {
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
                      resourceName,
                      resourceId,
                      runKind: "workflow-run",
                      startedAt: startedAt.toISOString(),
                    },
                  );
                }
              }
            }
          }
          if (!isWireEvent(event)) return;
          const serialized = serializeEvent(
            event as { kind: string; [key: string]: unknown },
          );
          buffer.push(serialized);
        },
        ctx.syncService,
        ctx.runTracker,
        {
          syncGate: ctx.syncGate,
          triggerSource: "api",
          initiatedBy,
          vaultAccess,
        },
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
      resourceName,
      resourceId,
      runKind: "workflow-run",
      startedAt: startedAt.toISOString(),
    });
  }

  await subscribeUntilDetach(
    buffer,
    socket,
    requestId,
    controller,
    0,
    redactingFor(ctx, socket, principal),
  );
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
    const libCtx = handlerLibSwampContext(ctx);
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
      results?: Array<{ id: string; name: string }>;
    };
    const canonical = canonicalResources(ctx);
    const { page, total } = paginate(
      await filterByResources(
        data.results ?? [],
        (item) => canonical.workflowOwners(item.id, item.name),
        socket,
        principal,
        "read",
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
    const libCtx = handlerLibSwampContext(ctx);
    const runRepo = ctx.repoContext.workflowRunRepo;
    const evaluatedRepo = new YamlEvaluatedWorkflowRepository(
      ctx.repoDir,
      ctx.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
    );
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
      approvals?: Array<
        {
          workflowId: string;
          workflowName: string;
          parentRun?: NamedWorkflow;
          parentWaiting?: boolean;
        }
      >;
    };
    if (data.approvals) {
      const canonical = canonicalResources(ctx);
      data.approvals = await filterByResources(
        data.approvals,
        (item) => canonical.workflowOwners(item.workflowId, item.workflowName),
        socket,
        principal,
        "read",
        ctx,
      );
      // A nested run's row names its parent only to a reader of the
      // parent's workflow (swamp-club#2736).
      const canRead = nestedRunReadDecider(ctx, socket, principal);
      for (const item of data.approvals) {
        await redactParentRun(item, canRead);
      }
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
  const target = await resolveWorkflowRequest(ctx, payload.workflowIdOrName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "read",
      target,
      payload.workflowIdOrName,
      "workflow",
      ctx,
      "workflow_get_failed",
    )
  ) return;
  const workflow = targetArgument(target, payload.workflowIdOrName);

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createWorkflowGetDeps(ctx.repoContext.workflowRepo);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowGet(libCtx, deps, workflow.idOrName, {
        byId: workflow.byId,
        expectedName: workflow.expectedName,
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
  const canonical = canonicalResources(ctx);
  return async (ref) =>
    (await filterByResources(
      [ref],
      (item) => canonical.dataOwners(item),
      socket,
      principal,
      "read",
      ctx,
    )).length === 1;
}

export async function handleWorkflowHistoryGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowHistoryGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize the workflow of the run read, not the raw
  // argument: a run id prefix matches across every workflow
  // (swamp-club#2673).
  const access = await resolveRunAccess(
    ctx.repoContext.workflowRepo,
    async () => {
      const deps = createWorkflowHistoryGetDeps(
        ctx.repoDir,
        ctx.datastoreResolver,
        ctx.repoContext.workflowRepo,
        dataReadPolicy(socket, ctx, principal),
      );
      return {
        deps,
        reference: await resolveRunReference(deps, payload.workflowIdOrName),
      };
    },
    payload.workflowIdOrName,
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.workflowIdOrName,
    ["workflow"],
    ctx,
    "workflow_history_get_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = handlerLibSwampContext(ctx);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowHistoryGet(libCtx, deps, payload.workflowIdOrName, {
        includeOutputs: true,
        reference,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new LibSwampStreamError(e.error);
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
    await redactRunViewLinks(
      result as unknown as WorkflowRunView,
      nestedRunReadDecider(ctx, socket, principal),
    );

    send(socket, {
      type: "workflow.history.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "workflow_history_get_failed",
      message,
      clientErrorDetails(error),
    );
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
  // Resolve first and authorize the workflow of the run read, not the raw
  // argument: a run id prefix matches across every workflow
  // (swamp-club#2673).
  const access = await resolveRunAccess(
    ctx.repoContext.workflowRepo,
    async () => {
      const deps = createWorkflowHistoryLogsDeps(
        ctx.repoDir,
        ctx.datastoreResolver,
        ctx.repoContext.workflowRepo,
      );
      return {
        deps,
        reference: await resolveRunReference(deps, payload.runIdOrWorkflow),
      };
    },
    payload.runIdOrWorkflow,
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.runIdOrWorkflow,
    ["workflow"],
    ctx,
    "workflow_history_logs_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = handlerLibSwampContext(ctx);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowHistoryLogs(libCtx, deps, {
        runIdOrWorkflow: payload.runIdOrWorkflow,
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
    const libCtx = handlerLibSwampContext(ctx);
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
      results?: Array<{ workflowId: string; workflowName: string }>;
    };
    if (data.results) {
      const canonical = canonicalResources(ctx);
      data.results = await filterByResources(
        data.results,
        (item) => canonical.workflowOwners(item.workflowId, item.workflowName),
        socket,
        principal,
        "read",
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
    const libCtx = handlerLibSwampContext(ctx);
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
      results?: Array<
        {
          workflowId: string;
          workflowName: string;
          parentRun?: NamedWorkflow;
          nestedWaits?: Array<NamedWorkflow>;
        }
      >;
    };
    // Page after the authorization filter, never inside libswamp: slicing
    // first would let unreadable runs shorten a page and skew `total`.
    const canonical = canonicalResources(ctx);
    const { page, total } = paginate(
      await filterByResources(
        data.results ?? [],
        (item) => canonical.workflowOwners(item.workflowId, item.workflowName),
        socket,
        principal,
        "read",
        ctx,
      ),
      payload?.offset,
      payload?.limit ?? WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT,
    );
    // Links to other runs name only workflows the principal may read
    // (swamp-club#2736); the derived awaitingResume flag stays.
    const canRead = nestedRunReadDecider(ctx, socket, principal);
    for (const item of page) {
      await redactParentRun(item, canRead);
      const nestedWaits = await readableNestedRuns(
        item.nestedWaits,
        (w) => w.workflowId,
        canRead,
      );
      if (nestedWaits) item.nestedWaits = nestedWaits;
      else delete item.nestedWaits;
    }
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
    const libCtx = handlerLibSwampContext(ctx);

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
  const target = await resolveWorkflowRequest(ctx, payload.workflowIdOrName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "approve",
      target,
      payload.workflowIdOrName,
      "workflow",
      ctx,
      "workflow_approve_failed",
    )
  ) return;
  const workflow = targetArgument(target, payload.workflowIdOrName);

  // The approval runs in the request's root unit of work, which pushes once
  // it ends, before the auto-resume and the reply below.
  const result = await runInRootUnitOfWork(
    ctx.repoContext,
    { flush: () => pushChangedToRemote(ctx) },
    async (): Promise<WorkflowApproveData | undefined> => {
      let approved: WorkflowApproveData | undefined;
      let release: (() => void) | undefined;
      try {
        const reserved = await reserveSuspendedRun(
          ctx,
          workflow,
          payload.runId,
        );
        if (!reserved.ok) {
          sendError(
            socket,
            requestId,
            "workflow_approve_failed",
            reserved.message,
          );
          return undefined;
        }
        release = reserved.release;

        const libCtx = handlerLibSwampContext(ctx);
        const deps = createWorkflowApproveDeps(
          ctx.repoContext.workflowRepo,
          ctx.repoContext.workflowRunRepo,
          // The reservation above is this process's claim on the run.
          unclaimedRuns,
        );

        await consumeStream(
          workflowApprove(libCtx, deps, {
            workflowIdOrName: workflow.idOrName,
            byId: workflow.byId,
            expectedName: workflow.expectedName,
            stepName: payload.stepName,
            reason: payload.reason,
            runId: reserved.runId,
            decidedBy: principal
              ? principalToString(principal)
              : payload.decidedBy,
          }),
          {
            resolving: () => {},
            completed: (e) => {
              approved = e.data;
            },
            error: async (e) => {
              // A nested step's refusal names the nested run only to a reader
              // of its workflow (swamp-club#2736).
              throw new Error(
                await nestedGateRefusalForClient(
                  e.error,
                  nestedRunReadDecider(ctx, socket, principal),
                ) ?? e.error.message,
              );
            },
          },
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return undefined;
        }

        if (!approved) {
          sendError(
            socket,
            requestId,
            "workflow_approve_failed",
            "Workflow approval failed",
          );
          return undefined;
        }
        return approved;
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "workflow_approve_failed", message);
        return undefined;
      } finally {
        // Released before the auto-resume below, which registers the run.
        release?.();
      }
    },
  );
  if (!result) return;

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
      captureDecisionSubject(socket, principal),
    );
  } catch (error) {
    logger.warn("Auto-resume after approval of run {runId} failed: {error}", {
      runId: result.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // The parent run is named only to a reader of its workflow
  // (swamp-club#2736).
  const canRead = nestedRunReadDecider(ctx, socket, principal);
  if (
    result.awaitingParent && !(await canRead(result.awaitingParent))
  ) {
    delete result.awaitingParent;
  }

  send(socket, {
    type: "workflow.approve",
    id: requestId,
    payload: { data: { ...result, autoResumed } },
  });
}

/**
 * Delivers a signal to the wait it names. The caller is authorized on the
 * wait's workflow inside {@link deliverSignalForCaller}, which the HTTP
 * signal route shares: a wait the caller may not signal is answered as one
 * that does not exist. Nothing here reserves or saves a run.
 */
export async function handleWorkflowSignal(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowSignalPayload,
  principal: Principal | null,
): Promise<void> {
  const result = await deliverSignalForCaller(
    ctx,
    accessCallerOf(socket, principal),
    { requestId, waitId: payload.waitId, payload: payload.payload },
  );
  switch (result.status) {
    case "delivered":
      if (result.data.workflowName !== undefined) {
        recordAuditedResource(
          socket,
          requestId,
          "workflow",
          result.data.workflowName,
          ctx,
        );
      }
      send(socket, {
        type: "workflow.signal",
        id: requestId,
        payload: { data: result.data },
      });
      return;
    case "not_found":
      sendError(socket, requestId, "not_found", result.message);
      return;
    case "failed":
      sendError(socket, requestId, "workflow_signal_failed", result.message);
      return;
    case "invalid_payload":
      sendError(socket, requestId, "workflow_signal_refused", result.message, {
        refusal: result.status,
        errors: result.errors,
      });
      return;
    default:
      sendError(socket, requestId, "workflow_signal_refused", result.message, {
        refusal: result.status,
        ...(result.receipt ? { receipt: result.receipt } : {}),
      });
  }
}

/**
 * Lists the waits for a signal nothing has answered, to a caller who may
 * read their workflows. A caller with no `read` grant on any workflow, such
 * as one granted `signal` alone, is refused.
 *
 * The listing is not read-only, here as for the local command: it registers
 * the waits of runs suspended before waits were registered, settles a wait
 * past its deadline as timed out, and sweeps wait records, for every
 * workflow. Each of those writes depends only on stored state, never on the
 * request.
 */
export async function handleWorkflowWaits(
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
    const deps = createWorkflowWaitsDeps(
      ctx.repoContext.workflowRunRepo,
      ctx.repoContext.signalWaits ?? SIGNAL_WAITS_NOT_CONFIGURED,
    );
    let listed: WorkflowWaitsData | undefined;
    await consumeStream<WorkflowWaitsEvent>(
      workflowWaits(handlerLibSwampContext(ctx), deps),
      {
        resolving: () => {},
        completed: (e) => {
          listed = e.data;
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

    const data: WorkflowWaitsData = listed ??
      { waits: [], unreadableWaits: [] };
    const canonical = canonicalResources(ctx);
    const ownersOf = (item: { workflowId: string; workflowName: string }) =>
      canonical.workflowOwners(item.workflowId, item.workflowName);
    const waits = await filterByResources(
      data.waits,
      ownersOf,
      socket,
      principal,
      "read",
      ctx,
    );
    const unreadableWaits = await filterByResources(
      data.unreadableWaits,
      ownersOf,
      socket,
      principal,
      "read",
      ctx,
    );

    send(socket, {
      type: "workflow.waits",
      id: requestId,
      payload: { data: { waits, unreadableWaits } },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_waits_failed", message);
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
  const target = await resolveWorkflowRequest(ctx, payload.workflowIdOrName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "approve",
      target,
      payload.workflowIdOrName,
      "workflow",
      ctx,
      "workflow_reject_failed",
    )
  ) return;
  const workflow = targetArgument(target, payload.workflowIdOrName);

  // Set as soon as the rejection is saved, outside the root, so the parent
  // still resumes if the reply fails after the save.
  let rejected: WorkflowRejectData | undefined;
  await runInRootUnitOfWork(
    ctx.repoContext,
    { flush: () => pushChangedToRemote(ctx) },
    async () => {
      let release: (() => void) | undefined;
      try {
        const reserved = await reserveSuspendedRun(
          ctx,
          workflow,
          payload.runId,
        );
        if (!reserved.ok) {
          sendError(
            socket,
            requestId,
            "workflow_reject_failed",
            reserved.message,
          );
          return;
        }
        release = reserved.release;

        const libCtx = handlerLibSwampContext(ctx);
        const evaluatedRepo = new YamlEvaluatedWorkflowRepository(
          ctx.repoDir,
          ctx.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
        );
        const deps = createWorkflowRejectDeps(
          ctx.repoContext.workflowRepo,
          ctx.repoContext.workflowRunRepo,
          // The reservation above is this process's claim on the run.
          unclaimedRuns,
          (runId) => evaluatedRepo.findByRunId(runId),
          ctx.runTracker,
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          workflowReject(libCtx, deps, {
            workflowIdOrName: workflow.idOrName,
            byId: workflow.byId,
            expectedName: workflow.expectedName,
            stepName: payload.stepName,
            reason: payload.reason,
            runId: reserved.runId,
            decidedBy: principal
              ? principalToString(principal)
              : payload.decidedBy,
          }),
          {
            resolving: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: async (e) => {
              // A nested step's refusal names the nested run only to a reader
              // of its workflow (swamp-club#2736).
              throw new Error(
                await nestedGateRefusalForClient(
                  e.error,
                  nestedRunReadDecider(ctx, socket, principal),
                ) ?? e.error.message,
              );
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
        rejected = result as unknown as WorkflowRejectData;
        // Other runs are named only to a reader of their workflow
        // (swamp-club#2736).
        const canRead = nestedRunReadDecider(ctx, socket, principal);
        if (
          rejected.awaitingParent && !(await canRead(rejected.awaitingParent))
        ) {
          delete rejected.awaitingParent;
        }
        const detached = await readableNestedRuns(
          rejected.detachedNestedRuns,
          (d) => d.workflowId,
          canRead,
        );
        if (detached) rejected.detachedNestedRuns = detached;
        else delete rejected.detachedNestedRuns;

        send(socket, {
          type: "workflow.reject",
          id: requestId,
          payload: { data: result },
        });
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "workflow_reject_failed", message);
      } finally {
        release?.();
      }
    },
  );

  // A rejected nested run has finished: its parent may continue. Launched
  // once the decision is saved, pushed and released; it may wait on a parent
  // this instance still drives, so the reply does not wait for it.
  const rejectedRun = rejected;
  if (rejectedRun) {
    autoResumeParentAfterChild(
      ctx,
      { workflowId: rejectedRun.workflowId, runId: rejectedRun.runId },
      captureDecisionSubject(socket, principal),
    ).catch((error) => {
      logger.warn(
        "Auto-resume of the parent of run {runId} failed: {error}",
        {
          runId: rejectedRun.runId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
  }
}

type ReservedSuspendedRun =
  | { ok: true; runId: string; release: (() => void) | undefined }
  | { ok: false; message: string };

/**
 * Resolves the suspended run an approve or reject names (the only one, when
 * the payload gives no run id) and reserves its id, so a cancel of the same
 * run in this process cannot interleave with the decision. Resolution errors
 * propagate unchanged. Without a registry there is nothing to reserve.
 */
async function reserveSuspendedRun(
  ctx: ConnectionContext,
  workflow: { idOrName: string; byId: boolean; expectedName?: string },
  runId: string | undefined,
): Promise<ReservedSuspendedRun> {
  const { run } = await resolveSuspendedRun(
    ctx.repoContext.workflowRepo,
    ctx.repoContext.workflowRunRepo,
    workflow.idOrName,
    runId,
    { byId: workflow.byId, expectedName: workflow.expectedName },
  );
  const registry = ctx.activeRunRegistry;
  if (!registry) return { ok: true, runId: run.id, release: undefined };
  const release = registry.reserve(run.id);
  if (!release) return { ok: false, message: SUSPENDED_RUN_BUSY_MESSAGE };
  return { ok: true, runId: run.id, release };
}

/**
 * Cancels a workflow run by id: one this instance is driving through the
 * active-run registry, otherwise a persisted suspended run. Authorization is
 * checked against the workflow the server knows the run belongs to, never the
 * payload's, and silently: a caller refused, a missing run, and a run of
 * another workflow than the payload names all get the same reply.
 *
 * A registered run is aborted, then awaited outside the sync gate, which the
 * run needs for its final push. If it leaves the registry, the persisted run
 * is checked again: a resume can save the run suspended at its next gate just
 * before the abort lands, and then the abort stopped nothing. Only the
 * persisted cancel and its push take the gate.
 */
export async function handleWorkflowCancel(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowCancelPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const notFound = `No cancellable run with id ${payload.runId}`;
  const reason = cancelReasonFor(cancelActor(principal, ctx), payload.reason);
  // Authorized on the run's workflow as found by id when known, so its
  // fields come from that workflow, not whatever now holds its name. A
  // failed lookup refuses.
  const mayCancel = async (
    target: { id?: string; name: string },
  ): Promise<boolean> => {
    const resolution = target.id
      ? await resolveRecordedWorkflow(
        ctx.repoContext.workflowRepo,
        target.id,
        target.name,
      )
      : await resolveWorkflowTarget(ctx.repoContext.workflowRepo, target.name);
    if (resolution.status === "failed") return false;
    return isAuthorized(
      socket,
      requestId,
      principal,
      "run",
      resolution.status === "found"
        ? resolution.resource
        : unresolvedAccessResource("workflow", target.name),
      ctx,
    );
  };
  const cancelPersisted = () =>
    cancelSuspendedRunAndPush(
      ctx,
      {
        runId: payload.runId,
        workflowIdOrName: payload.workflowIdOrName,
        reason,
      },
      (workflow) => mayCancel(workflow),
    );
  const reply = (
    workflowName: string,
    status: string,
    detachedNestedRuns?: DetachedNestedRunData[],
  ) =>
    send(socket, {
      type: "workflow.cancel",
      id: requestId,
      payload: {
        data: {
          runId: payload.runId,
          workflowName,
          status,
          ...(detachedNestedRuns ? { detachedNestedRuns } : {}),
        },
      },
    });

  try {
    const registry = ctx.activeRunRegistry;
    const outcome: SuspendedRunCancelResult = registry?.get(payload.runId)
      ? { status: "active" }
      : await cancelPersisted();

    if (outcome.status === "active") {
      // Registered before the lookup, or a resume registered it after.
      const active = registry?.get(payload.runId);
      const workflowName = active
        ? await abortActiveWorkflowRun(ctx, payload, active, mayCancel, reason)
        : undefined;
      if (!registry || workflowName === undefined) {
        sendError(socket, requestId, "workflow_cancel_failed", notFound);
        return;
      }
      if (!(await awaitAbortedRun(registry, payload.runId))) {
        reply(workflowName, "cancellation_requested");
        return;
      }
      const left = await cancelPersisted();
      if (left.status === "busy") {
        sendError(socket, requestId, "workflow_cancel_failed", left.message);
      } else if (left.status === "active") {
        registry.cancel(payload.runId, reason);
        reply(workflowName, "cancellation_requested");
      } else {
        reply(workflowName, "cancelled");
      }
      return;
    }

    if (controller.signal.aborted && outcome.status !== "cancelled") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    switch (outcome.status) {
      case "cancelled":
        // Nested runs are named only to a reader of their workflow
        // (swamp-club#2736).
        reply(
          outcome.workflowName,
          "cancelled",
          await readableNestedRuns(
            outcome.detachedNestedRuns,
            (d) => d.workflowId,
            nestedRunReadDecider(ctx, socket, principal),
          ),
        );
        return;
      case "busy":
      case "not_suspended":
        sendError(socket, requestId, "workflow_cancel_failed", outcome.message);
        return;
      case "not_found":
        sendError(socket, requestId, "workflow_cancel_failed", notFound);
        return;
    }
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_cancel_failed", message);
  }
}

/**
 * Aborts a workflow run this instance is driving, authorizing on the workflow
 * recorded in the registry entry. Returns that workflow's name, or undefined
 * for a method run, a refused caller, or a payload naming another workflow,
 * which the caller reports as not found.
 */
async function abortActiveWorkflowRun(
  ctx: ConnectionContext,
  payload: WorkflowCancelPayload,
  active: import("../active_run_registry.ts").ActiveRun,
  mayCancel: (target: { id?: string; name: string }) => Promise<boolean>,
  reason: string,
): Promise<string | undefined> {
  if (active.kind === "method-run") return undefined;
  // By the id recorded at registration when there is one, so a rename during
  // the run cannot point the check at a workflow that took the old name.
  // Ids are not guaranteed unique, so prefer the workflow with both the id
  // and the recorded name; failing that it was renamed, so take the id alone.
  const workflow = active.resourceId
    ? await findWorkflowById(
      ctx.repoContext.workflowRepo,
      active.resourceId,
      active.resourceName,
    ) ??
      await findWorkflowById(ctx.repoContext.workflowRepo, active.resourceId)
    : await findWorkflowByIdOrName(
      ctx.repoContext.workflowRepo,
      active.resourceName,
    );
  const workflowName = workflow?.name ?? active.resourceName;
  const matches = payload.workflowIdOrName === undefined ||
    payload.workflowIdOrName === workflowName ||
    payload.workflowIdOrName === workflow?.id;
  if (
    !matches ||
    !(await mayCancel({
      id: workflow?.id ?? active.resourceId,
      name: workflowName,
    }))
  ) return undefined;
  ctx.activeRunRegistry?.cancel(payload.runId, reason);
  return workflowName;
}

export async function handleWorkflowResume(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowResumePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveWorkflowRequest(ctx, payload.workflowIdOrName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "run",
      target,
      payload.workflowIdOrName,
      "workflow",
      ctx,
      "workflow_resume_failed",
    )
  ) return;
  const workflow = targetArgument(target, payload.workflowIdOrName);

  const registry = ctx.activeRunRegistry;
  if (!registry) {
    // The root's flush is the post-resume push, on every outcome.
    await runInRootUnitOfWork(
      ctx.repoContext,
      {
        flush: () =>
          withSharedSyncGate(
            ctx.syncGate,
            () =>
              pushChangedToRemote(ctx, {
                onError: (error) =>
                  logger.warn(
                    "Post-resume push failed; terminal status may be delayed: {error}",
                    { error },
                  ),
              }),
          ),
      },
      async () => {
        try {
          const workflowRepo = ctx.repoContext.workflowRepo;
          const runRepo = ctx.repoContext.workflowRunRepo;

          const { run, workflowName } = await resolveResumableRun(
            workflowRepo,
            runRepo,
            workflow.idOrName,
            payload.runId,
            {
              fromStep: payload.from,
              byId: workflow.byId,
              expectedName: workflow.expectedName,
            },
          );

          const stepLockHook = createStepLockHook(
            ctx.repoDir,
            ctx.repoContext,
            ctx.datastoreConfig,
            ctx.syncService,
            ctx.syncGate,
          );

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
            // Held to the principal that triggered the run, never the
            // resumer (swamp-club#2676).
            for await (
              const event of runGeneratorWithVaultAccess(
                resumeRunVaultScope(runVaultScopeContext(ctx), run)?.access,
                () =>
                  service.resume(workflowName, run.id, {
                    signal: controller.signal,
                    inputs: resumeInputs,
                    fromStep: payload.from,
                    instanceId: ctx.instanceId,
                  }),
              )
            ) {
              yield mapWorkflowExecutionEvent(event, runRepo);
            }
          };

          const canRead = nestedRunReadDecider(ctx, socket, principal);
          const run_ = async () => {
            try {
              for await (const event of resumeGenerator()) {
                if (socket.readyState !== WebSocket.OPEN) break;
                if (!isWireEvent(event)) continue;
                const serialized = await redactStreamEvent(
                  serializeEvent(
                    event as { kind: string; [key: string]: unknown },
                  ),
                  canRead,
                );
                send(socket, {
                  type: "event",
                  id: requestId,
                  event: serialized,
                });
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
            sendError(
              socket,
              requestId,
              "cancelled",
              "Operation was cancelled",
            );
          } else if (error instanceof LockTimeoutError) {
            const lt = lockTimeoutErrorForClient(error);
            sendError(socket, requestId, lt.code, lt.message, lt.details);
          } else if (error instanceof NestedRunPendingError) {
            sendError(
              socket,
              requestId,
              "workflow_resume_failed",
              await nestedPendingRefusalForClient(
                error,
                nestedRunReadDecider(ctx, socket, principal),
              ),
            );
          } else {
            const message = sanitizeErrorForClient(error);
            sendError(socket, requestId, "workflow_resume_failed", message);
          }
        }
      },
    );
    return;
  }

  const launched = await startDetachedResume(ctx, registry, {
    workflowIdOrName: workflow.idOrName,
    byId: workflow.byId,
    expectedName: workflow.expectedName,
    runId: payload.runId,
    from: payload.from,
    inputs: payload.inputs,
    traceparent: payload.traceparent,
    tracestate: payload.tracestate,
    principalId: principal ? principalToString(principal) : null,
    subject: captureDecisionSubject(socket, principal),
    canReadWorkflow: nestedRunReadDecider(ctx, socket, principal),
  });
  if (!launched.ok) {
    sendError(socket, requestId, launched.code, launched.message);
    return;
  }

  await subscribeUntilDetach(
    launched.buffer,
    socket,
    requestId,
    controller,
    0,
    redactingFor(ctx, socket, principal),
  );
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
      // A workflow being created has no tags yet.
      fields: { name: payload.name, tags: {} },
    }, ctx).allowed
  ) return;

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push workflow create to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
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
        replied = true;
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "workflow_create_failed", message);
      }
    },
  );
}

export async function handleWorkflowDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveWorkflowRequest(ctx, payload.workflowIdOrName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "write",
      target,
      payload.workflowIdOrName,
      "workflow",
      ctx,
      "workflow_delete_failed",
    )
  ) return;
  const workflow = targetArgument(target, payload.workflowIdOrName);

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push workflow delete to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const deps = createWorkflowDeleteDeps(
          ctx.repoDir,
          ctx.datastoreResolver,
          ctx.repoContext.markDirty,
          ctx.repoContext.workflowRepo,
          ctx.repoContext.signalWaits,
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          workflowDelete(libCtx, deps, {
            workflowIdOrName: workflow.idOrName,
            byId: workflow.byId,
            expectedName: workflow.expectedName,
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
        replied = true;
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "workflow_delete_failed", message);
      }
    },
  );
}

export async function handleWorkflowEdit(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowEditPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectEditWithoutContent(socket, requestId, payload.content)) return;

  // Authorize the workflow the edit will act on, by its canonical name, not
  // the raw id-or-name: a grant matches the resource name, so an id would
  // sidestep name-scoped denies (swamp-club#2426, swamp-club#2674).
  const workflow = await resolveWorkflow(
    ctx.repoContext.workflowRepo,
    payload.workflowIdOrName,
  );
  const target: WorkflowEditTarget = workflow
    ? { name: workflow.name, tags: { ...workflow.tags } }
    : { name: payload.workflowIdOrName, tags: {} };
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "workflow",
      name: target.name,
      fields: workflowAccessFields(target),
    }, ctx).allowed
  ) return;
  if (!workflow) {
    sendError(
      socket,
      requestId,
      "not_found",
      `Workflow not found: ${payload.workflowIdOrName}`,
    );
    return;
  }

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push workflow edit to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const deps = createWorkflowEditDeps(
          ctx.repoDir,
          ctx.repoContext.workflowRepo,
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          // By id only, so the edit acts on the workflow authorized above.
          workflowEdit(libCtx, deps, {
            workflowIdOrName: workflow.id,
            byId: true,
            expectedName: workflow.name,
            stdinContent: payload.content,
            // Every save is authorized against the edited workflow too, so a
            // rename or retag needs write on the result. It runs on every save
            // rather than only on a detected change, so a concurrent retag
            // between the lookup above and the save cannot skip it.
            authorizeUpdate: (_before, after) =>
              authorizeOrReject(socket, requestId, principal, "write", {
                kind: "workflow",
                name: after.name,
                fields: workflowAccessFields(after),
              }, ctx).allowed,
            // The expressions and steps the edit adds are authorized against
            // this writer; those already stored are not (swamp-club#2755).
            authorizeContent: async (before, after) => {
              const refusal = await authorizeWorkflowEdit(
                socket,
                requestId,
                principal,
                ctx,
                before,
                after,
              );
              if (refusal === undefined) return true;
              sendError(socket, requestId, "unauthorized", refusal);
              return false;
            },
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
        replied = true;
      } catch (error) {
        // A denied rename or retag was already reported by authorizeOrReject.
        if (wasRequestErrored(socket, requestId)) return;
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "workflow_edit_failed", message);
      }
    },
  );
}

export async function handleWorkflowValidate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowValidatePayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Without a workflow this validates every workflow the caller may read, and
  // only those (swamp-club#2675). A named workflow is resolved first.
  const workflowIdOrName = payload?.workflowIdOrName;
  let workflow:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  let include:
    | ((workflow: { name: string; tags: Record<string, string> }) => boolean)
    | undefined;
  // An empty string reads as absent, exactly as libswamp reads it.
  if (!workflowIdOrName) {
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
    const readable = resourceDecider(socket, principal, "read", ctx);
    include = (candidate) => readable(workflowAccessResource(candidate));
  } else {
    const target = await resolveWorkflowRequest(ctx, workflowIdOrName);
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        workflowIdOrName,
        "workflow",
        ctx,
        "workflow_validate_failed",
      )
    ) return;
    workflow = targetArgument(target, workflowIdOrName);
  }

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createWorkflowValidateDeps(
      ctx.repoContext.workflowRepo,
      ctx.repoContext.definitionRepo,
      workflowsDirFor(ctx.repoDir),
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowValidate(libCtx, deps, {
        workflowIdOrName: workflow?.idOrName,
        byId: workflow?.byId,
        expectedName: workflow?.expectedName,
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
  // Without a workflow this evaluates every workflow the caller may read, and
  // only those (swamp-club#2675). A named workflow is resolved first.
  const workflowIdOrName = payload?.workflowIdOrName;
  let workflow:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  let include:
    | ((workflow: { name: string; tags: Record<string, string> }) => boolean)
    | undefined;
  // An empty string reads as absent, exactly as libswamp reads it.
  if (!workflowIdOrName) {
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
    const readable = resourceDecider(socket, principal, "read", ctx);
    include = (candidate) => readable(workflowAccessResource(candidate));
  } else {
    const target = await resolveWorkflowRequest(ctx, workflowIdOrName);
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        workflowIdOrName,
        "workflow",
        ctx,
        "workflow_evaluate_failed",
      )
    ) return;
    workflow = targetArgument(target, workflowIdOrName);
  }

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createWorkflowEvaluateDeps(
      ctx.repoDir,
      ctx.repoContext.workflowRepo,
      ctx.datastoreResolver,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowEvaluate(libCtx, deps, {
        workflowIdOrName: workflow?.idOrName,
        byId: workflow?.byId,
        expectedName: workflow?.expectedName,
        inputs: payload?.inputs ?? {},
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
  // Authorize the workflow the name resolves to, by its canonical name. The
  // override stays keyed by the name as given, and applies even before the
  // workflow exists, so a name that resolves to nothing is authorized as is.
  const target = await resolveWorkflowRequest(ctx, payload.workflowName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "write",
      target,
      payload.workflowName,
      "workflow",
      ctx,
      "workflow_trigger_set_failed",
    )
  ) return;

  try {
    const entry: TriggerOverrideEntry = {
      schedule: payload.schedule,
      ...(payload.inputs && Object.keys(payload.inputs).length > 0
        ? { inputs: payload.inputs }
        : {}),
    };

    const configPath = ctx.serveConfigPath ??
      join(ctx.repoDir, SERVE_CONFIG_PATH);
    validateTriggerOverrideEntry(entry, configPath, payload.workflowName);

    const config =
      await readServeConfigFile(ctx.repoDir, ctx.serveConfigPath) ?? {};
    const triggers = config.triggers ?? {};
    triggers[payload.workflowName] = entry;
    config.triggers = triggers;
    if (
      !await writeTriggerConfig(
        socket,
        ctx,
        requestId,
        config,
        "workflow_trigger_set_failed",
      )
    ) return;

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
  // Authorize the workflow the name resolves to, by its canonical name. The
  // override stays keyed by the name as given, and applies even before the
  // workflow exists, so a name that resolves to nothing is authorized as is.
  const target = await resolveWorkflowRequest(ctx, payload.workflowName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "read",
      target,
      payload.workflowName,
      "workflow",
      ctx,
      "workflow_trigger_get_failed",
    )
  ) return;

  try {
    // Report the override the scheduler applies; without a scheduler, the
    // one in the config file serve was started with.
    const override: TriggerOverrideEntry | null = ctx.scheduledExecution
      ? ctx.scheduledExecution.getTriggerOverride(payload.workflowName) ??
        null
      : (await readServeConfigFile(ctx.repoDir, ctx.serveConfigPath))
        ?.triggers?.[payload.workflowName] ?? null;

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
  // Authorize the workflow the name resolves to, by its canonical name. The
  // override stays keyed by the name as given, and applies even before the
  // workflow exists, so a name that resolves to nothing is authorized as is.
  const target = await resolveWorkflowRequest(ctx, payload.workflowName);
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "write",
      target,
      payload.workflowName,
      "workflow",
      ctx,
      "workflow_trigger_remove_failed",
    )
  ) return;

  try {
    const config = await readServeConfigFile(
      ctx.repoDir,
      ctx.serveConfigPath,
    );
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
    if (
      !await writeTriggerConfig(
        socket,
        ctx,
        requestId,
        config,
        "workflow_trigger_remove_failed",
      )
    ) return;

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

/**
 * Writes trigger overrides to the serve config file serve was started with.
 * A failed write (a read-only `--config` mount, for one) is refused with a
 * message that names no server path; the path and cause go to the log.
 * Returns false after sending the error.
 */
async function writeTriggerConfig(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  config: ServeConfigFile,
  errorCode: string,
): Promise<boolean> {
  try {
    await writeServeConfigFile(ctx.repoDir, config, ctx.serveConfigPath);
    return true;
  } catch (error) {
    logger.warn(
      "Cannot write trigger overrides to serve config file {path}: {error}",
      {
        path: ctx.serveConfigPath ?? join(ctx.repoDir, SERVE_CONFIG_PATH),
        error: error instanceof Error ? error.message : String(error),
      },
    );
    sendError(
      socket,
      requestId,
      errorCode,
      "Cannot write the serve config file (it or its directory may be " +
        "read-only; the serve log has the cause). Edit it directly, then " +
        (ctx.hotReload ? "run 'swamp serve reload'." : "restart serve."),
    );
    return false;
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
