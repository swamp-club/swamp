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

import { listWorkflows } from "../../domain/workflows/workflow_listing.ts";
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
  createWorkflowScheduleDeps,
  overrideSchedulesOf,
  type WorkflowScheduleDeps,
  workflowScheduleList,
  workflowSchedulePause,
  workflowScheduleResume,
} from "../../libswamp/workflows/schedule.ts";
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
  pulledExtensionWorkflowScope,
  workflowValidate,
} from "../../libswamp/workflows/validate.ts";
import {
  createWorkflowWaitsDeps,
  workflowWaits,
  type WorkflowWaitsData,
  type WorkflowWaitsEvent,
} from "../../libswamp/workflows/waits.ts";
import {
  deferCompletedForOutputs,
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
import {
  workflowRunSummary,
  type WorkflowRunSummaryData,
  type WorkflowRunSummaryDeps,
} from "../../libswamp/workflows/run_summary.ts";
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
import { UserError } from "../../domain/errors.ts";
import type {
  EffectiveTrigger,
  GateTargetPayload,
  WorkflowApprovePayload,
  WorkflowCancelPayload,
  WorkflowCreatePayload,
  WorkflowDeletePayload,
  WorkflowEditPayload,
  WorkflowEvaluatePayload,
  WorkflowGateRefusalDetails,
  WorkflowGetPayload,
  WorkflowHistoryGetPayload,
  WorkflowHistoryLogsPayload,
  WorkflowHistorySearchPayload,
  WorkflowRejectPayload,
  WorkflowResumePayload,
  WorkflowRunPayload,
  WorkflowRunSearchPayload,
  WorkflowRunSummaryPayload,
  WorkflowScheduleListResponse,
  WorkflowSchedulePausePayload,
  WorkflowSchedulePauseResponse,
  WorkflowScheduleResumePayload,
  WorkflowScheduleResumeResponse,
  WorkflowSchemaPayload,
  WorkflowSearchPayload,
  WorkflowSignalPayload,
  WorkflowTriggerGetPayload,
  WorkflowTriggerRemovePayload,
  WorkflowTriggerSetPayload,
  WorkflowValidatePayload,
  WorkflowWaitsPayload,
} from "../protocol.ts";
import {
  ApprovalPendingError,
  lookupWorkflow,
  resolveResumableRun,
  resolveSuspendedRun,
} from "../../domain/workflows/suspended_run_resolver.ts";
import {
  classifyGate,
  type GateState,
  gateStateSettled,
} from "../../domain/workflows/gate_state.ts";
import { RunStartKey } from "../../domain/workflows/run_start_key.ts";
import { type RunStartClaim, runStartClaims } from "../run_start_claims.ts";
import {
  AMBIGUOUS_GATE_CODE,
  GATE_REOPENED_CODE,
  type GateTarget,
} from "../../libswamp/workflows/gate_refusals.ts";
import { exactRunReference } from "../../libswamp/workflows/run_lookup.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  isGuardedRunRecord,
  isServeDrivenRun,
  type WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import {
  withRunCondition,
  withRunPending,
} from "../../domain/access/access_resources.ts";
import { unclaimedRuns } from "../../domain/workflows/run_claim.ts";
import {
  NestedRunPendingError,
  NestedRunUnreadableError,
} from "../../domain/workflows/nested_run_link.ts";
import { OrphanedNestedRunError } from "../../domain/workflows/orphaned_nested_run.ts";
import type { NestedCascadeResult } from "../../libswamp/workflows/nested_cascade.ts";
import {
  cascadeEndedRunAndPush,
  fetchMissingRunUnderGate,
  serveNestedCascade,
} from "../nested_run_cascade.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { createEphemeralStore } from "../../infrastructure/persistence/ephemeral_store.ts";
import {
  extractTraceContext,
  runWithParentTrace,
  withSpan,
} from "../../infrastructure/tracing/mod.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  resolvePulledExtensionsRoot,
  SWAMP_SUBDIRS,
} from "../../infrastructure/persistence/paths.ts";
import { runInRootUnitOfWork } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import { WorkflowRunCheckpointer } from "../../infrastructure/persistence/workflow_run_checkpointer.ts";
import {
  type ActiveRun,
  type ActiveRunRegistry,
  RegistryCapacityError,
} from "../active_run_registry.ts";
import { awaitSettlingRuns } from "../settling_runs.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import {
  type NamedWorkflow,
  nestedGateRefusalForClient,
  nestedPendingRefusalForClient,
  nestedRunReadDecider,
  orphanedRefusalForClient,
  readableNestedCascade,
  readableNestedRuns,
  redactParentRun,
  redactRunViewLinks,
} from "./nested_run_redaction.ts";
import {
  type CompletedRunSlot,
  dataReadPolicy,
  runStreamFor,
} from "./run_data_attributes.ts";
import {
  captureResumeCaller,
  RESUME_INPUTS_REFUSED,
  resumeInputsRefusal,
} from "../resume_caller_rules.ts";
import {
  approvalPendingDetails,
  autoResumeAfterApproval,
  autoResumeParentAfterChild,
  ownerResumesRun,
  startDetachedResume,
} from "../resume_launcher.ts";
import {
  awaitAbortedRun,
  cancelSuspendedRunAndPush,
  SUSPENDED_RUN_BUSY_MESSAGE,
  type SuspendedRunCancelResult,
} from "../suspended_run_cancel.ts";
import {
  abortRunHeldOutsideActiveRuns,
  runCancelDecider,
  runCancelResource,
  runResumeDecider,
  workflowHeldOutsideActiveRuns,
} from "../run_cancel_authorization.ts";
import {
  deleteActiveRun,
  rekeyActiveRun,
  writeActiveRun,
} from "../active_run_tracker.ts";
import {
  accessCallerOf,
  authorizeAnyOrReject,
  authorizeOrReject,
  authorizeRetag,
  cancelActor,
  cancelReasonFor,
  captureDecisionSubject,
  clientErrorDetails,
  confirmRunReplicated,
  type ConnectionContext,
  exceptionTypeForClient,
  filterByResources,
  getConnectionClient,
  handlerLibSwampContext,
  isAuthorized,
  LibSwampStreamError,
  lockTimeoutErrorForClient,
  paginate,
  pushChangedToRemote,
  recordAuditedDetail,
  recordAuditedResource,
  refusedAdmission,
  rejectEditWithoutContent,
  resourceDecider,
  resourceReadability,
  runFailureForClient,
  sanitizeErrorForClient,
  send,
  sendError,
  sendTraced,
  socketAuthority,
  subscribeUntilDetach,
  wasRequestErrored,
  withCommittedUnknownSteps,
  wouldAuthorize,
} from "./shared.ts";
import { DRAINING_RETRY_AFTER_SECONDS } from "../serve_admission.ts";
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
  resolveRunAccess,
  resolveWorkflowTarget,
  type ResourceResolution,
  type SettledResolution,
  targetArgument,
  workflowAccessResource,
} from "./resource_resolution.ts";
import {
  continueAfterSignal,
  deliverSignalForCaller,
} from "../signal_delivery.ts";
import { SIGNAL_WAITS_NOT_CONFIGURED } from "../../domain/workflows/signal_wait_store.ts";
import { authorizeWorkflowEdit } from "./workflow_step_authorization.ts";
import { containedLogFileReader } from "./log_file_containment.ts";

const logger = getSwampLogger(["serve", "connection"]);
const DEFAULT_BUFFER_CAPACITY = 10_000;
export const WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT = 500;

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

export function workflowAccessFields(
  target: WorkflowEditTarget,
): Record<string, unknown> {
  return { name: target.name, tags: target.tags ?? {} };
}

interface KeyedStartRequest {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly initiatedBy: string;
  readonly key: string;
  /** what a retry must repeat, or it is refused as a different start */
  readonly fingerprinted: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

/**
 * answers a retry itself, or returns the claim the caller starts its run under;
 * a retry waits only for the first attempt's start, never for the run to end
 */
async function beginKeyedStart(
  ctx: ConnectionContext,
  socket: WebSocket,
  requestId: string,
  request: KeyedStartRequest,
): Promise<"answered" | { key: RunStartKey; claim: RunStartClaim }> {
  const { workflowId, workflowName, initiatedBy, fingerprinted, signal } =
    request;
  const identity = {
    workflowId,
    principal: initiatedBy,
    client: getConnectionClient(socket),
    key: request.key,
  };
  const key = await RunStartKey.create(identity, fingerprinted);
  const answer = async (runId: string, recorded: RunStartKey) => {
    if (!(await recorded.sameInputs(fingerprinted))) {
      sendError(
        socket,
        requestId,
        "idempotency_conflict",
        "This idempotency key was already used with different inputs",
      );
      return;
    }
    recordAuditedDetail(socket, requestId, "replayed start");
    send(socket, {
      type: "event",
      id: requestId,
      event: { kind: "started", runId, workflowName, replayed: true },
    });
    send(socket, { type: "done", id: requestId });
  };

  for (
    let held = runStartClaims.holder(key.lookup);
    held !== undefined;
    held = runStartClaims.holder(key.lookup)
  ) {
    const aborted = abortPromise(signal);
    const runId = await Promise.race([held.started, aborted.promise]);
    aborted.dispose();
    if (signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return "answered";
    }
    if (runId !== undefined) {
      await answer(runId, held.key);
      return "answered";
    }
  }

  const claim = runStartClaims.claim(key.lookup, key);
  try {
    const run = await findRunOfStartKey(
      ctx,
      workflowId,
      key.lookup,
      initiatedBy,
    );
    if (run?.startKey !== undefined) {
      claim.settled();
      await answer(run.id, RunStartKey.fromData(run.startKey));
      return "answered";
    }
  } catch (error) {
    claim.settled();
    throw error;
  }
  return { key, claim };
}

/** the index only points at a candidate: it is untrusted, and the record decides */
async function findRunOfStartKey(
  ctx: ConnectionContext,
  workflowId: string,
  lookup: string,
  initiatedBy: string,
): Promise<WorkflowRun | null> {
  const repo = ctx.repoContext.workflowRunRepo;
  const id = createWorkflowId(workflowId);
  const candidate = (await repo.runIndexSnapshot(id)).withStartKey(lookup);
  if (!candidate) return null;
  const run = await repo.findById(
    id,
    createWorkflowRunId(candidate.summary.id),
  );
  return run?.startKey?.lookup === lookup && run.workflowId === workflowId &&
      run.initiatedBy === initiatedBy
    ? run
    : null;
}

function abortPromise(
  signal: AbortSignal,
): { promise: Promise<undefined>; dispose: () => void } {
  let onAbort = () => {};
  const promise = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

export async function handleWorkflowRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowRunPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (refusedAdmission(socket, ctx, requestId)) return;
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
  // captured now, while the socket's memberships are at hand: the run's vault
  // operations are decided for this principal
  const vaultAccess = requestRunVaultScope(ctx, socket, principal);
  const registry = ctx.activeRunRegistry;
  // the key's guarantee needs the registry, so it is refused rather than dropped
  if (!registry && payload.idempotencyKey !== undefined) {
    sendError(
      socket,
      requestId,
      "runs_unavailable",
      "This server can't check an idempotency key",
    );
    return;
  }
  // after the grant decision, so a refused caller learns nothing of a key's run
  const keyedStart = registry && payload.idempotencyKey !== undefined &&
      target.status === "found"
    ? await beginKeyedStart(ctx, socket, requestId, {
      workflowId: target.id,
      workflowName: target.name,
      initiatedBy,
      key: payload.idempotencyKey,
      fingerprinted: {
        inputs: payload.inputs ?? {},
        runtimeTags: payload.runtimeTags ?? {},
      },
      signal: controller.signal,
    })
    : undefined;
  if (keyedStart === "answered") return;
  if (!registry) {
    let registeredRunId: string | undefined;
    // events are redacted per client before sending, which may wait: sends are
    // chained to keep the run's order and drained before the request's own
    // reply
    const completedRun: CompletedRunSlot = { verbose: payload.verbose };
    const forClient = runStreamFor(
      ctx,
      socket,
      principal,
      completedRun,
      controller.signal,
    );
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
          client: getConnectionClient(socket),
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
              { id: resourceId, name: resourceName },
            );
          }
          if (socket.readyState !== WebSocket.OPEN) return;
          if (!isWireEvent(event)) return;
          const serialized = serializeEvent(
            event as { kind: string; [key: string]: unknown },
          );
          sending = sending.then(async () => {
            const visible = await forClient(serialized);
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
          defaultVault: ctx.defaultVault,
          runWriteFence: ctx.runWriteFence,
          onCompletedRun: (run) => {
            completedRun.run = run;
          },
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
        const { code, message } = runFailureForClient(
          error,
          "workflow_execution_failed",
        );
        const exType = exceptionTypeForClient(error);
        sendError(
          socket,
          requestId,
          code,
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

  const buffer = new RunEventBuffer(DEFAULT_BUFFER_CAPACITY, {
    holdOutcome: ctx.holdRepliesUntilCommitted === true,
  });
  const runController = new AbortController();
  let runId: string = crypto.randomUUID();
  const startedAt = new Date();
  const completedRun: CompletedRunSlot = { verbose: payload.verbose };

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
      completedRun,
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
      sendError(
        socket,
        requestId,
        err.code,
        clientMsg,
        undefined,
        err.code === "draining" ? DRAINING_RETRY_AFTER_SECONDS : undefined,
      );
    } else {
      sendError(socket, requestId, "internal_error", "Run registration failed");
    }
    keyedStart?.claim.settled();
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
          startKey: keyedStart?.key.data,
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
          client: getConnectionClient(socket),
          instanceId: ctx.instanceId,
        },
        runController.signal,
        (event) => {
          // a nested started event carries the child's run id; the entry stays
          // keyed on this request's run, and a client reattaching by the
          // child's id finds it
          if (event.kind === "started" && event.parentRunId !== undefined) {
            registry.addNestedRun(runId, event.runId);
          } else if (event.kind === "started") {
            const domainRunId = (event as { runId: string }).runId;
            keyedStart?.claim.started(domainRunId);
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
          defaultVault: ctx.defaultVault,
          runWriteFence: ctx.runWriteFence,
          onCompletedRun: (run) => {
            completedRun.run = run;
          },
        },
      );
      // reported finished only once its commits are replicated
      const unconfirmed = await confirmRunReplicated(
        ctx,
        "workflow_execution_failed",
      );
      buffer.finish(
        unconfirmed === undefined
          ? { kind: "done" }
          : { kind: "error", ...unconfirmed },
      );
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
          ...runFailureForClient(error, "workflow_execution_failed"),
          ...(exType !== undefined && {
            details: { exceptionType: exType },
          }),
        });
      }
    } finally {
      keyedStart?.claim.settled();
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
    runStreamFor(ctx, socket, principal, completedRun, controller.signal),
    payload.eventKinds,
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

interface ApprovalsRow {
  workflowId: string;
  workflowName: string;
  parentRun?: NamedWorkflow & { canCancel?: boolean; canResume?: boolean };
  parentWaiting?: boolean;
  initiatedBy?: string;
  serveDriven?: boolean;
  /**
   * whether this caller may decide this run; answers for the caller only and
   * never says who else may decide, since approve and reject authorize
   * themselves
   */
  canDecide?: boolean;
  /** set when the caller could decide other runs of this workflow, not this one */
  canDecideReason?: "grant-condition";
  /** whether swamp workflow cancel --server would allow this caller's cancel */
  canCancel?: boolean;
  canResume?: boolean;
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
    // suspended-run reads stop when the request is cancelled, giving up its
    // place among the shared scan permits
    const libCtx = handlerLibSwampContext(ctx, { signal: controller.signal });
    const runRepo = ctx.repoContext.workflowRunRepo;
    const evaluatedRepo = new YamlEvaluatedWorkflowRepository(
      ctx.repoDir,
      ctx.datastoreResolver.resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
    );
    const deps = createWorkflowApprovalsDeps(
      ctx.repoContext.workflowRepo,
      runRepo,
      (workflowId, signal) =>
        runRepo.findByStatus(workflowId, "suspended", signal),
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

    // build the reply from the lists filtered here, never the generator's
    // object, so a list added later is withheld until filtered; approvals stays
    // the first key because older dashboards read by position
    const listed = (result ?? {}) as {
      approvals?: ApprovalsRow[];
      expired?: ApprovalsRow[];
    };
    const canonical = canonicalResources(ctx);
    // a nested run's row names its parent only to a reader of the parent's
    // workflow
    const canRead = nestedRunReadDecider(ctx, socket, principal);
    const readable = async (rows: ApprovalsRow[] | undefined) => {
      const kept = await filterByResources(
        rows ?? [],
        (item) => canonical.workflowOwners(item.workflowId, item.workflowName),
        socket,
        principal,
        "read",
        ctx,
      );
      for (const item of kept) {
        await redactParentRun(item, canRead);
      }
      return kept;
    };
    // Set only on gates the caller may read, by the same owners the read
    // filter uses, and unaudited like it: a refetch adds no audit events.
    const ownersOfRow = (item: ApprovalsRow) =>
      canonical.workflowOwners(item.workflowId, item.workflowName);
    const mayDecide = resourceReadability(
      async (item: ApprovalsRow) =>
        (await ownersOfRow(item)).map((owner) =>
          withRunCondition(owner, {
            initiatedBy: item.initiatedBy,
            serveDriven: item.serveDriven === true,
          })
        ),
      socket,
      principal,
      "approve",
      ctx,
    );
    const mayDecideSomeRun = resourceReadability(
      async (item: ApprovalsRow) =>
        (await ownersOfRow(item)).map(withRunPending),
      socket,
      principal,
      "approve",
      ctx,
    );
    const caller = accessCallerOf(socket, principal);
    const mayCancel = runCancelDecider(ctx, caller);
    const mayResume = runResumeDecider(ctx, caller);
    const markCommands = async (item: ApprovalsRow) => {
      const own = { id: item.workflowId, name: item.workflowName };
      item.canCancel = await mayCancel(own);
      item.canResume = await mayResume(own);
      if (item.parentRun) {
        const parent = {
          id: item.parentRun.workflowId,
          name: item.parentRun.workflowName,
        };
        item.parentRun.canCancel = await mayCancel(parent);
        item.parentRun.canResume = await mayResume(parent);
      }
    };
    const data = await withSpan("swamp.serve.authorize", {}, async () => {
      const approvals = await readable(listed.approvals);
      for (const item of approvals) {
        item.canDecide = await mayDecide(item);
        if (!item.canDecide && await mayDecideSomeRun(item)) {
          item.canDecideReason = "grant-condition";
        }
        await markCommands(item);
      }
      const expired = await readable(listed.expired);
      for (const item of expired) await markCommands(item);
      return { approvals, expired };
    });

    await sendTraced(socket, {
      type: "workflow.approvals",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    // A read stopped by the cancel answers as one that ran to the end does.
    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }
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

export async function handleWorkflowHistoryGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowHistoryGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // resolve first and authorize the workflow of the run read, not the raw
  // argument: a run id prefix matches across every workflow
  const access = await resolveRunAccess(
    ctx.repoContext.workflowRepo,
    async () => {
      const deps = {
        ...createWorkflowHistoryGetDeps(
          ctx.repoDir,
          ctx.datastoreResolver,
          ctx.repoContext.workflowRepo,
          dataReadPolicy(socket, ctx, principal, controller.signal),
          ctx.repoContext.signalWaits,
          ctx.repoContext.unreadableContent,
          ctx.repoContext.takesForwardedRunRecords,
        ),
        retentionWatermarks: ctx.repoContext.retentionWatermarks,
      };
      return {
        deps,
        reference: payload.exactRun
          ? await exactRunReference(
            ctx.repoContext.workflowRunRepo,
            payload.workflowIdOrName,
          )
          : await resolveRunReference(deps, payload.workflowIdOrName),
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
        includeOutputs: !payload.exactRun,
        allAttributes: payload.allAttributes === true,
        reference,
        // a cancelled read stops resolving outputs
        signal: controller.signal,
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
    const view = result as unknown as WorkflowRunView;
    await withSpan(
      "swamp.serve.redact",
      {},
      () =>
        redactRunViewLinks(
          view,
          nestedRunReadDecider(
            ctx,
            socket,
            principal,
            canonicalResources(ctx, controller.signal),
          ),
        ),
    );

    if (payload.allAttributes === true) {
      // read whole, every artifact's attributes would double the reply
      for (const job of view.jobs) {
        for (const step of job.steps) {
          for (const artifact of step.dataArtifacts ?? []) {
            delete artifact.attributes;
          }
        }
      }
    }

    await sendTraced(socket, {
      type: "workflow.history.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }
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
  // resolve first and authorize the workflow of the run read, not the raw
  // argument: a run id prefix matches across every workflow
  const access = await resolveRunAccess(
    ctx.repoContext.workflowRepo,
    async () => {
      const deps = {
        ...createWorkflowHistoryLogsDeps(
          ctx.repoDir,
          ctx.datastoreResolver,
          ctx.repoContext.workflowRepo,
          ctx.repoContext.unreadableContent,
        ),
        retentionWatermarks: ctx.repoContext.retentionWatermarks,
      };
      // a run record's log path may come from a forwarded commit, so read only
      // the repo's own run logs
      deps.readLogFile = containedLogFileReader(ctx.repoDir, deps.readLogFile);
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

    await sendTraced(socket, {
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
    const canonical = canonicalResources(ctx);
    const deps: WorkflowHistorySearchDeps = {
      findAllWorkflows: () => ctx.repoContext.workflowRepo.findAll(),
      findAllRunsByWorkflowId: (id) =>
        ctx.repoContext.workflowRunRepo.findAllSummariesFromIndex(
          createWorkflowId(id),
        ),
      runInputsOf: (workflowId, runId) =>
        ctx.repoContext.workflowRunRepo.findPersistedInputs(
          createWorkflowId(workflowId),
          createWorkflowRunId(runId),
        ),
      isReadable: resourceReadability(
        (id: string, name: string) => canonical.workflowOwners(id, name),
        socket,
        principal,
        "read",
        ctx,
      ),
      retentionWatermarks: ctx.repoContext.retentionWatermarks,
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
      skippedWorkflows?: Array<{ workflowId: string; workflowName: string }>;
    };
    if (data.results) {
      data.results = await filterByResources(
        data.results,
        (item) => canonical.workflowOwners(item.workflowId, item.workflowName),
        socket,
        principal,
        "read",
        ctx,
      );
    }
    if (data.skippedWorkflows) {
      data.skippedWorkflows = await filterByResources(
        data.skippedWorkflows,
        (item) => canonical.workflowOwners(item.workflowId, item.workflowName),
        socket,
        principal,
        "read",
        ctx,
      );
      if (data.skippedWorkflows.length === 0) delete data.skippedWorkflows;
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
    const canonical = canonicalResources(ctx);
    // readability is decided per run before the page is cut, so unreadable runs
    // never shorten a page or count in total
    const deps: WorkflowRunSearchDeps = {
      findAllWorkflows: () => listWorkflows(ctx.repoContext.workflowRepo),
      runIndexOf: (id) =>
        ctx.repoContext.workflowRunRepo.runIndexSnapshot(createWorkflowId(id)),
      runInputsOf: (workflowId, runId) =>
        ctx.repoContext.workflowRunRepo.findPersistedInputs(
          createWorkflowId(workflowId),
          createWorkflowRunId(runId),
        ),
      isReadable: resourceReadability(
        (id: string, name: string) => canonical.workflowOwners(id, name),
        socket,
        principal,
        "read",
        ctx,
      ),
      retentionWatermarks: ctx.repoContext.retentionWatermarks,
    };

    let result: Record<string, unknown> | undefined;
    let total = 0;
    let searchWindow: { since?: string; oldestStartedAt?: string } = {};
    await consumeStream(
      workflowRunSearch(libCtx, deps, {
        query: payload?.query,
        since: payload?.since,
        until: payload?.until,
        status: payload?.status,
        workflow: payload?.workflow,
        workflows: payload?.workflows,
        triggerSource: payload?.triggerSource,
        statuses: payload?.statuses,
        triggerSources: payload?.triggerSources,
        tags: payload?.tags,
        inputs: payload?.inputs,
        offset: payload?.offset,
        limit: payload?.limit ?? WORKFLOW_RUN_SEARCH_DEFAULT_LIMIT,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
          total = e.total;
          searchWindow = {
            ...(e.since ? { since: e.since } : {}),
            ...(e.oldestStartedAt
              ? { oldestStartedAt: e.oldestStartedAt }
              : {}),
          };
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
    const page = data.results ?? [];
    // links to other runs name only workflows the principal may read; the
    // derived awaitingResume flag stays
    const canRead = nestedRunReadDecider(ctx, socket, principal, canonical);
    await withSpan("swamp.serve.redact", {}, async () => {
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
    });
    data.results = page;

    await sendTraced(socket, {
      type: "workflow.run.search",
      id: requestId,
      payload: { data, total, ...searchWindow },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_run_search_failed", message);
  }
}

/**
 * counts are taken after the per-workflow read filter so an unreadable workflow
 * never reaches totals or the timeline
 */
export async function handleWorkflowRunSummary(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: WorkflowRunSummaryPayload,
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
    const canonical = canonicalResources(ctx);
    const deps: WorkflowRunSummaryDeps = {
      findAllWorkflows: () => listWorkflows(ctx.repoContext.workflowRepo),
      runIndexOf: (id) =>
        ctx.repoContext.workflowRunRepo.runIndexSnapshot(createWorkflowId(id)),
      isReadable: resourceReadability(
        (id: string, name: string) => canonical.workflowOwners(id, name),
        socket,
        principal,
        "read",
        ctx,
      ),
    };

    let data: WorkflowRunSummaryData | undefined;
    await consumeStream(
      workflowRunSummary(libCtx, deps, {
        since: payload?.since,
        until: payload?.until,
        workflows: payload?.workflows,
        triggerSource: payload?.triggerSource,
        triggerSources: payload?.triggerSources,
        recentLimit: payload?.recentLimit,
        timeline: payload?.timeline,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          data = e.data;
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
    if (!data) throw new Error("The run summary completed without data");

    await sendTraced(socket, {
      type: "workflow.run.summary",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "workflow_run_summary_failed",
      message,
      clientErrorDetails(error),
    );
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

/** a libswamp refusal of an approve or reject, keeping the code it has locally */
class GateRefusalError extends Error {
  constructor(message: string, readonly refusalCode: string) {
    super(message);
    this.name = "GateRefusalError";
  }
}

/** none when the message was withheld, so a withheld one is never local */
function gateRefusalDetails(
  error: unknown,
  sentMessage: string,
): WorkflowGateRefusalDetails | undefined {
  return error instanceof GateRefusalError && error.message === sentMessage
    ? { refusalCode: error.refusalCode }
    : undefined;
}

/** the refusal is replied to and audited here, once; the handler then stays silent */
function runDecisionGuard(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  target: SettledResolution,
  ctx: ConnectionContext,
): { authorize: (run: WorkflowRun) => boolean; refused: () => boolean } {
  let refused = false;
  return {
    authorize: (run) => {
      const { allowed } = authorizeOrReject(
        socket,
        requestId,
        principal,
        "approve",
        withRunCondition(target.resource, conditionRunOf(run)),
        ctx,
      );
      if (!allowed) refused = true;
      return allowed;
    },
    refused: () => refused,
  };
}

function conditionRunOf(
  run: Pick<WorkflowRun, "initiatedBy" | "triggeringPrincipal" | "instanceId">,
): { initiatedBy?: string; serveDriven: boolean } {
  return { initiatedBy: run.initiatedBy, serveDriven: isServeDrivenRun(run) };
}

function gateTargetOf(payload: GateTargetPayload): GateTarget {
  return {
    stepName: payload.stepName,
    jobName: payload.jobName,
    strictGate: payload.strictGate,
    suspendedAt: payload.suspendedAt,
  };
}

/**
 * read only after the grant decision, and a grant conditional on the run is
 * decided on this record first, so a refused caller cannot tell a decided gate
 * from a waiting one
 */
async function storedGate(
  ctx: ConnectionContext,
  workflow: { idOrName: string; byId: boolean; expectedName?: string },
  payload: GateTargetPayload & { runId?: string },
  authorizeRun: (run: WorkflowRun) => boolean,
): Promise<
  { state: GateState; runStatus?: WorkflowRun["status"] } | undefined
> {
  if (payload.runId === undefined) return undefined;
  try {
    const found = await lookupWorkflow(
      ctx.repoContext.workflowRepo,
      workflow.idOrName,
      workflow,
    );
    if (!found) return { state: "absent" };
    const run = await ctx.repoContext.workflowRunRepo.findById(
      found.id,
      createWorkflowRunId(payload.runId),
    );
    if (!run) return { state: "absent" };
    if (!authorizeRun(run)) return undefined;
    return {
      state: classifyGate(run, found, payload.stepName, {
        jobName: payload.jobName,
      }),
      runStatus: run.status,
    };
  } catch (error) {
    logger.warn("Could not classify a refused decision: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function storedGateState(
  ctx: ConnectionContext,
  workflow: { idOrName: string; byId: boolean; expectedName?: string },
  payload: GateTargetPayload & { runId?: string },
  authorizeRun: (run: WorkflowRun) => boolean,
): Promise<GateState | undefined> {
  return (await storedGate(ctx, workflow, payload, authorizeRun))?.state;
}

/** a run held elsewhere is busy, unless its gate already reads as a retry would */
async function busyGateState(
  ctx: ConnectionContext,
  workflow: { idOrName: string; byId: boolean; expectedName?: string },
  payload: GateTargetPayload & { runId?: string },
  authorizeRun: (run: WorkflowRun) => boolean,
): Promise<GateState | "busy"> {
  const stored = await storedGate(ctx, workflow, payload, authorizeRun);
  if (stored === undefined) return "busy";
  // a missing run has no status and cannot appear while held
  if (stored.runStatus === undefined) return stored.state;
  return gateStateSettled(stored.state, stored.runStatus)
    ? stored.state
    : "busy";
}

async function refusedDecisionDetails(
  ctx: ConnectionContext,
  workflow: { idOrName: string; byId: boolean; expectedName?: string },
  payload: GateTargetPayload & { runId?: string },
  error: unknown,
  sentMessage: string,
  authorizeRun: (run: WorkflowRun) => boolean,
): Promise<WorkflowGateRefusalDetails | undefined> {
  const details = gateRefusalDetails(error, sentMessage);
  if (!(error instanceof GateRefusalError)) return details;
  // these fixed codes hold no message text, so a withheld message keeps them
  const fixed = error.refusalCode === GATE_REOPENED_CODE ||
      error.refusalCode === AMBIGUOUS_GATE_CODE
    ? { refusalCode: error.refusalCode }
    : details;
  if (payload.strictGate !== true) return fixed;
  const gateState = await storedGateState(
    ctx,
    workflow,
    payload,
    authorizeRun,
  );
  return gateState === undefined ? fixed : { ...fixed, gateState };
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
      true,
    )
  ) return;
  const workflow = targetArgument(target, payload.workflowIdOrName);
  const decideRun = runDecisionGuard(socket, requestId, principal, target, ctx);

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
          const busy = payload.strictGate === true
            ? {
              gateState: await busyGateState(
                ctx,
                workflow,
                payload,
                decideRun.authorize,
              ),
            }
            : undefined;
          if (decideRun.refused()) return undefined;
          sendError(
            socket,
            requestId,
            "workflow_approve_failed",
            reserved.message,
            busy,
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
        deps.runTracker = ctx.runTracker;
        deps.runRecordCurrency = ctx.repoContext.runRecordCurrency;
        deps.fetchMissing = (run) => fetchMissingRunUnderGate(ctx, run);
        deps.authorizeRun = decideRun.authorize;
        // Built only when a run nothing waits on has to be cancelled.
        deps.findEvaluatedWorkflow = (runId) =>
          new YamlEvaluatedWorkflowRepository(
            ctx.repoDir,
            ctx.datastoreResolver.resolvePath(
              SWAMP_SUBDIRS.workflowsEvaluated,
            ),
          ).findByRunId(runId);

        await consumeStream(
          workflowApprove(libCtx, deps, {
            workflowIdOrName: workflow.idOrName,
            byId: workflow.byId,
            expectedName: workflow.expectedName,
            ...gateTargetOf(payload),
            reason: payload.reason,
            runId: reserved.runId,
            decidedBy: principal
              ? principalToString(principal)
              : payload.decidedBy,
            client: getConnectionClient(socket),
          }),
          {
            resolving: () => {},
            completed: (e) => {
              approved = e.data;
            },
            error: async (e) => {
              // a nested step's refusal names the nested run only to a reader
              // of its workflow
              throw new GateRefusalError(
                await nestedGateRefusalForClient(
                  e.error,
                  nestedRunReadDecider(ctx, socket, principal),
                ) ?? e.error.message,
                e.error.code,
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
        if (decideRun.refused()) return undefined;
        const message = sanitizeErrorForClient(error);
        const details = await refusedDecisionDetails(
          ctx,
          workflow,
          payload,
          error,
          message,
          decideRun.authorize,
        );
        if (decideRun.refused()) return undefined;
        sendError(
          socket,
          requestId,
          "workflow_approve_failed",
          message,
          details,
        );
        return undefined;
      } finally {
        // Released before the auto-resume below, which registers the run.
        release?.();
      }
    },
  );
  if (!result) return;

  // launched only once the approval is saved and pushed, detached and never
  // awaited since this handler holds the non-reentrant sync gate; a failure
  // must not cost the client its reply
  let autoResumed = false;
  let ownerResumes = false;
  try {
    ownerResumes = await ownerResumesRun(ctx, result);
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

  // the parent run is named only to a reader of its workflow
  const canRead = nestedRunReadDecider(ctx, socket, principal);
  if (
    result.awaitingParent && !(await canRead(result.awaitingParent))
  ) {
    delete result.awaitingParent;
  }

  send(socket, {
    type: "workflow.approve",
    id: requestId,
    payload: {
      data: {
        ...result,
        autoResumed,
        ...(ownerResumes ? { ownerResumes } : {}),
      },
    },
  });
}

/**
 * a wait the caller may not signal is answered as one that does not exist;
 * nothing here reserves or saves a run
 */
function idempotencyKeyOf(
  payload: WorkflowSignalPayload,
): { idempotencyKey?: string } {
  return payload.idempotencyKey !== undefined
    ? { idempotencyKey: payload.idempotencyKey }
    : {};
}

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
    "waitId" in payload
      ? {
        requestId,
        waitId: payload.waitId,
        payload: payload.payload,
        ...idempotencyKeyOf(payload),
      }
      : {
        requestId,
        workflow: payload.workflow,
        key: payload.key,
        payload: payload.payload,
        // A client from before the pending reply cannot read one.
        holdEarly: payload.acceptsPending === true,
        // Nor can one from before the accepted reply read that.
        acceptsReceipt: payload.acceptsReceipt === true,
        ...idempotencyKeyOf(payload),
      },
    {
      onWorkflowResolved: (name) =>
        recordAuditedResource(socket, requestId, "workflow", name, ctx),
    },
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
      await continueAfterSignal(
        ctx,
        result,
        captureDecisionSubject(socket, principal),
      );
      return;
    case "pending":
      // Nothing took the signal yet, so there is no run to continue.
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
        payload: { pending: result.data },
      });
      return;
    case "accepted":
      send(socket, {
        type: "workflow.signal",
        id: requestId,
        payload: { accepted: result.data },
      });
      await continueAfterSignal(
        ctx,
        result,
        captureDecisionSubject(socket, principal),
      );
      return;
    case "not_found":
      sendError(socket, requestId, "not_found", result.message, {
        refusal: "unknown",
      });
      return;
    case "failed":
      sendError(socket, requestId, "workflow_signal_failed", result.message);
      return;
    case "upgrade_required":
      sendError(socket, requestId, "workflow_signal_refused", result.message, {
        refusal: result.status,
      });
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
        ...(result.pending ? { pending: result.pending } : {}),
        ...(result.lastWait ? { lastWait: result.lastWait } : {}),
      });
  }
}

/**
 * not read-only: listing registers waits of older suspended runs, settles waits
 * past their deadline and sweeps wait records, all from stored state alone; a
 * caller with no workflow read grant is refused
 */
export async function handleWorkflowWaits(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload: WorkflowWaitsPayload = {},
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
      // Names the workflow of a pending signal sent without one, through
      // the local CLI; without it such a signal is never listed.
      ctx.repoContext.workflowRepo,
    );
    let listed: WorkflowWaitsData | undefined;
    await consumeStream<WorkflowWaitsEvent>(
      workflowWaits(handlerLibSwampContext(ctx), deps, {
        includeSignalled: payload.includeSignalled === true,
        includePending: payload.includePending === true,
      }),
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

    // A signalled wait carries its receipt, which names the sender: it is
    // listed only to a reader of the wait's workflow, as the others are.
    const signalled = data.signalled
      ? await filterByResources(
        data.signalled,
        ownersOf,
        socket,
        principal,
        "read",
        ctx,
      )
      : undefined;

    // a pending signal names its sender and key, so it is listed only to a
    // reader of its workflow; workflowOwners prefers the workflow matching both
    // ID and name so it never lists under a same-ID workflow
    const pending = data.pending
      ? await filterByResources(
        data.pending,
        ownersOf,
        socket,
        principal,
        "read",
        ctx,
      )
      : undefined;

    send(socket, {
      type: "workflow.waits",
      id: requestId,
      payload: {
        data: {
          waits,
          unreadableWaits,
          ...(signalled ? { signalled } : {}),
          ...(pending ? { pending } : {}),
        },
      },
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
      true,
    )
  ) return;
  const workflow = targetArgument(target, payload.workflowIdOrName);
  const decideRun = runDecisionGuard(socket, requestId, principal, target, ctx);

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
          const busy = payload.strictGate === true
            ? {
              gateState: await busyGateState(
                ctx,
                workflow,
                payload,
                decideRun.authorize,
              ),
            }
            : undefined;
          if (decideRun.refused()) return;
          sendError(
            socket,
            requestId,
            "workflow_reject_failed",
            reserved.message,
            busy,
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
        deps.runRecordCurrency = ctx.repoContext.runRecordCurrency;
        deps.fetchMissing = (run) => fetchMissingRunUnderGate(ctx, run);
        deps.authorizeRun = decideRun.authorize;
        // the suspended nested runs the rejected run waited on are cancelled in
        // this gated unit of work
        if (ctx.activeRunRegistry) {
          deps.cascade = serveNestedCascade(
            ctx,
            ctx.activeRunRegistry,
            `Rejected by ${
              principal
                ? principalToString(principal)
                : payload.decidedBy ?? "unknown"
            }`,
          );
        }

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          workflowReject(libCtx, deps, {
            workflowIdOrName: workflow.idOrName,
            byId: workflow.byId,
            expectedName: workflow.expectedName,
            ...gateTargetOf(payload),
            reason: payload.reason,
            runId: reserved.runId,
            decidedBy: principal
              ? principalToString(principal)
              : payload.decidedBy,
            client: getConnectionClient(socket),
          }),
          {
            resolving: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: async (e) => {
              // a nested step's refusal names the nested run only to a reader
              // of its workflow
              throw new GateRefusalError(
                await nestedGateRefusalForClient(
                  e.error,
                  nestedRunReadDecider(ctx, socket, principal),
                ) ?? e.error.message,
                e.error.code,
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
        // other runs are named only to a reader of their workflow
        const canRead = nestedRunReadDecider(ctx, socket, principal);
        if (
          rejected.awaitingParent && !(await canRead(rejected.awaitingParent))
        ) {
          delete rejected.awaitingParent;
        }
        const nested = await readableNestedCascade(rejected, canRead);
        delete rejected.detachedNestedRuns;
        delete rejected.cancelledNestedRuns;
        delete rejected.stopRequestedNestedRuns;
        Object.assign(rejected, nested);

        send(socket, {
          type: "workflow.reject",
          id: requestId,
          payload: { data: result },
        });
      } catch (error) {
        if (decideRun.refused()) return;
        const message = sanitizeErrorForClient(error);
        const details = await refusedDecisionDetails(
          ctx,
          workflow,
          payload,
          error,
          message,
          decideRun.authorize,
        );
        if (decideRun.refused()) return;
        sendError(
          socket,
          requestId,
          "workflow_reject_failed",
          message,
          details,
        );
      } finally {
        release?.();
      }
    },
  );

  // launched once the decision is saved, pushed and released; it may wait on a
  // parent this instance still drives, so the reply does not wait
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

/**
 * waits, outside the sync gate a winding-down run needs for its last push, for
 * registered runs of the workflow whose record already reads suspended; reserves
 * nothing
 */
export async function awaitWindingDownRun(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
  target: { workflowIdOrName: string; runId?: string },
  signal: AbortSignal,
): Promise<void> {
  try {
    const runs = await windingDownDecisionRuns(ctx, socket, principal, target);
    await awaitSettlingRuns(runs, { signal });
  } catch (error) {
    logger.warn("Could not wait for a run winding down: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** decides access as approve and reject do, but audits nothing */
export async function windingDownDecisionRuns(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
  target: { workflowIdOrName: string; runId?: string },
): Promise<ActiveRun[]> {
  const registry = ctx.activeRunRegistry;
  if (!registry) return [];
  const resolved = await resolveWorkflowRequest(ctx, target.workflowIdOrName);
  if (resolved.status !== "found") return [];
  if (
    !wouldAuthorize(
      socket,
      principal,
      "approve",
      withRunPending(resolved.resource),
      ctx,
    )
  ) return [];
  return await windingDownRuns(
    ctx,
    registry,
    resolved.id,
    target.runId,
    (run) =>
      wouldAuthorize(
        socket,
        principal,
        "approve",
        withRunCondition(resolved.resource, conditionRunOf(run)),
        ctx,
      ),
  );
}

/** for a resume its handler has already authorized */
async function awaitWindingDownResume(
  ctx: ConnectionContext,
  registry: ActiveRunRegistry,
  target: SettledResolution,
  runId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (target.status !== "found") return;
  try {
    const runs = await windingDownRuns(
      ctx,
      registry,
      target.id,
      runId,
      () => true,
    );
    await awaitSettlingRuns(runs, { signal });
  } catch (error) {
    logger.warn("Could not wait for a run winding down: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function windingDownRuns(
  ctx: ConnectionContext,
  registry: ActiveRunRegistry,
  workflowId: string,
  runId: string | undefined,
  mayWait: (run: WorkflowRun) => boolean,
): Promise<ActiveRun[]> {
  const runs: ActiveRun[] = [];
  for (const entry of registry.list()) {
    if (entry.kind === "method-run" || entry.resourceId !== workflowId) {
      continue;
    }
    if (runId !== undefined && entry.runId !== runId) continue;
    const stored = await ctx.repoContext.workflowRunRepo.findById(
      createWorkflowId(workflowId),
      createWorkflowRunId(entry.runId),
    );
    if (stored?.status === "suspended" && mayWait(stored)) runs.push(entry);
  }
  return runs;
}

type ReservedSuspendedRun =
  | { ok: true; runId: string; release: (() => void) | undefined }
  | { ok: false; message: string };

/**
 * reserves the run id so a cancel of the same run in this process cannot
 * interleave with the decision; without a registry there is nothing to reserve
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
  ).catch((error: unknown) => {
    // the code approve and reject give the same refusal locally
    throw error instanceof UserError
      ? new GateRefusalError(error.message, "validation_failed")
      : error;
  });
  const registry = ctx.activeRunRegistry;
  if (!registry) return { ok: true, runId: run.id, release: undefined };
  const release = registry.reserve(run.id);
  if (!release) return { ok: false, message: SUSPENDED_RUN_BUSY_MESSAGE };
  return { ok: true, runId: run.id, release };
}

/**
 * authorized silently on the server's workflow for the run, so a refused
 * caller, a missing run and another workflow's run get the same reply; a
 * registered run is awaited outside the sync gate
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
    const resource = await runCancelResource(
      ctx.repoContext.workflowRepo,
      target,
    );
    if (!resource) return false;
    return isAuthorized(socket, requestId, principal, "run", resource, ctx);
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
  // nested runs are named only to a reader of their workflow
  const reply = async (
    workflowName: string,
    status: string,
    nested: Partial<NestedCascadeResult> = {},
  ) =>
    send(socket, {
      type: "workflow.cancel",
      id: requestId,
      payload: {
        data: {
          runId: payload.runId,
          workflowName,
          status,
          ...await readableNestedCascade(
            nested,
            nestedRunReadDecider(ctx, socket, principal),
          ),
        },
      },
    });

  try {
    const registry = ctx.activeRunRegistry;
    const held = registry?.get(payload.runId)
      ? undefined
      : workflowHeldOutsideActiveRuns(ctx, payload.runId);
    if (held) {
      const matches = payload.workflowIdOrName === undefined ||
        payload.workflowIdOrName === held.name ||
        payload.workflowIdOrName === held.id;
      if (
        !matches || !(await mayCancel(held)) ||
        !abortRunHeldOutsideActiveRuns(ctx, payload.runId, reason)
      ) {
        sendError(socket, requestId, "workflow_cancel_failed", notFound);
        return;
      }
      await reply(held.name, "cancellation_requested");
      return;
    }
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
        await reply(workflowName, "cancellation_requested");
        return;
      }
      const left = await cancelPersisted();
      if (left.status === "busy") {
        sendError(socket, requestId, "workflow_cancel_failed", left.message);
      } else if (left.status === "active") {
        registry.cancel(payload.runId, reason);
        await reply(workflowName, "cancellation_requested");
      } else if (left.status === "cancelled") {
        await reply(workflowName, "cancelled", left);
      } else {
        // the aborted run settled itself, leaving the nested runs it waited on,
        // so they are cancelled here
        await reply(
          workflowName,
          "cancelled",
          await cascadeEndedRunAndPush(ctx, payload.runId, reason),
        );
      }
      return;
    }

    if (controller.signal.aborted && outcome.status !== "cancelled") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    switch (outcome.status) {
      case "cancelled":
        await reply(outcome.workflowName, "cancelled", outcome);
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
 * authorizes on the workflow recorded in the registry entry; returns undefined
 * for a method run, a refused caller or another workflow's payload, which the
 * caller reports as not found
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
  if (refusedAdmission(socket, ctx, requestId)) return;
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
  const resumer = captureResumeCaller(ctx, socket, principal);

  // the limit's guarantee needs the registry, so it is refused rather than dropped
  if (!ctx.activeRunRegistry && payload.suspendedOnly) {
    sendError(
      socket,
      requestId,
      "runs_unavailable",
      "This server can't limit a resume to a suspended run",
    );
    return;
  }
  const registry = ctx.activeRunRegistry;
  if (!registry) {
    const runCheckpointer = new WorkflowRunCheckpointer(ctx.repoContext);
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
              fromJob: payload.fromJob,
              byId: workflow.byId,
              expectedName: workflow.expectedName,
              signalWaits: ctx.repoContext.signalWaits,
            },
          );
          const inputsRefusal = resumeInputsRefusal(
            run,
            resumer,
            payload.inputs,
          );
          if (inputsRefusal !== undefined) {
            sendError(
              socket,
              requestId,
              "workflow_resume_failed",
              inputsRefusal,
              { resumeRefusal: RESUME_INPUTS_REFUSED },
            );
            return;
          }

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
            {
              runCheckpointer,
              defaultVault: ctx.defaultVault,
              runWriteFence: ctx.runWriteFence,
            },
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

          const vaultScope = resumeRunVaultScope(
            runVaultScopeContext(ctx),
            run,
            resumer.vaultScope ?? undefined,
          );
          const resumeGenerator = async function* (): AsyncGenerator<
            WorkflowRunEvent
          > {
            for await (
              const { event } of deferCompletedForOutputs(
                runGeneratorWithVaultAccess(
                  vaultScope?.access,
                  () =>
                    service.resume(workflowName, run.id, {
                      signal: controller.signal,
                      inputs: resumeInputs,
                      fromStep: payload.from,
                      fromJob: payload.fromJob,
                      instanceId: ctx.instanceId,
                    }),
                ),
                (completed) => {
                  completedRun.run = completed;
                  return Promise.resolve(undefined);
                },
              )
            ) {
              yield mapWorkflowExecutionEvent(event, runRepo);
            }
          };

          const completedRun: CompletedRunSlot = {};
          const forClient = runStreamFor(
            ctx,
            socket,
            principal,
            completedRun,
            controller.signal,
          );
          const run_ = async () => {
            try {
              for await (const event of resumeGenerator()) {
                if (socket.readyState !== WebSocket.OPEN) break;
                if (!isWireEvent(event)) continue;
                const serialized = await forClient(
                  serializeEvent(
                    event as { kind: string; [key: string]: unknown },
                  ),
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
          } else if (
            error instanceof NestedRunPendingError ||
            error instanceof NestedRunUnreadableError
          ) {
            sendError(
              socket,
              requestId,
              "workflow_resume_failed",
              await nestedPendingRefusalForClient(
                error,
                nestedRunReadDecider(ctx, socket, principal),
              ),
            );
          } else if (error instanceof OrphanedNestedRunError) {
            sendError(
              socket,
              requestId,
              "workflow_resume_failed",
              await orphanedRefusalForClient(
                error,
                nestedRunReadDecider(ctx, socket, principal),
              ),
            );
          } else if (error instanceof ApprovalPendingError) {
            sendError(
              socket,
              requestId,
              "workflow_resume_failed",
              error.message,
              approvalPendingDetails(error),
            );
          } else {
            const message = sanitizeErrorForClient(error);
            sendError(socket, requestId, "workflow_resume_failed", message);
          }
        }
      },
    ).catch(async (error) => {
      await runCheckpointer.restoreUncommittedRuns(
        () => ctx.runTracker,
        error,
      );
      throw withCommittedUnknownSteps(error, runCheckpointer);
    }).finally(() => runCheckpointer.close());
    return;
  }

  await awaitWindingDownResume(
    ctx,
    registry,
    target,
    payload.runId,
    controller.signal,
  );
  const launched = await startDetachedResume(ctx, registry, {
    workflowIdOrName: workflow.idOrName,
    byId: workflow.byId,
    expectedName: workflow.expectedName,
    runId: payload.runId,
    from: payload.from,
    fromJob: payload.fromJob,
    suspendedOnly: payload.suspendedOnly,
    lostRaceIsOrdinary: payload.suspendedOnly,
    inputs: payload.inputs,
    traceparent: payload.traceparent,
    tracestate: payload.tracestate,
    principalId: principal ? principalToString(principal) : null,
    subject: captureDecisionSubject(socket, principal),
    // a resume decides no gate, so its caller is not judged as an approver
    parentGrant: "run",
    resumer,
    canReadWorkflow: nestedRunReadDecider(ctx, socket, principal),
  });
  if (!launched.ok) {
    sendError(
      socket,
      requestId,
      launched.code,
      launched.message,
      launched.refusal
        ? {
          resumeRefusal: launched.refusal,
          ...(launched.gate ? { gate: launched.gate } : {}),
        }
        : undefined,
      launched.code === "draining" ? DRAINING_RETRY_AFTER_SECONDS : undefined,
    );
    return;
  }

  await subscribeUntilDetach(
    launched.buffer,
    socket,
    requestId,
    controller,
    0,
    runStreamFor(
      ctx,
      socket,
      principal,
      launched.completedRun,
      controller.signal,
    ),
    payload.eventKinds,
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

  // the root pushes only once the success reply was sent
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
          workflowCreate(libCtx, deps, {
            name: payload.name,
            principalId: principal ? principalToString(principal) : undefined,
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

/** a run file serve cannot read counts as guarded, as a forwarded delete's does */
async function holdsGuardedRun(
  ctx: ConnectionContext,
  workflowId: string,
): Promise<boolean> {
  try {
    return (await ctx.repoContext.workflowRunRepo.findAllByWorkflowId(
      createWorkflowId(workflowId),
    )).some((run) => isGuardedRunRecord(run.toData()));
  } catch {
    return true;
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
  // Deleting a run serve drives, or one holding a decision, would let a member
  // forward a first record under its id that drops the marker or decision.
  if (
    ctx.repoContext.takesForwardedRunRecords === true && workflow.byId &&
    await holdsGuardedRun(ctx, workflow.idOrName) &&
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "admin",
      target,
      payload.workflowIdOrName,
      "workflow",
      ctx,
      "workflow_delete_failed",
    )
  ) return;

  // the root pushes only once the success reply was sent
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
          ctx.repoContext.continuationClaims?.store,
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          workflowDelete(libCtx, deps, {
            workflowIdOrName: workflow.idOrName,
            byId: workflow.byId,
            expectedName: workflow.expectedName,
            principalId: principal ? principalToString(principal) : undefined,
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

  // authorize the workflow the edit will act on by its canonical name, not the
  // raw id-or-name: a grant matches the resource name, so an id would sidestep
  // name-scoped denies
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

  // the root pushes only once the success reply was sent
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
            principalId: principal ? principalToString(principal) : undefined,
            stdinContent: payload.content,
            allowRename: payload.allowRename === true,
            // Every save is authorized against the edited workflow too, so a
            // rename or retag needs write on the result. It runs on every save
            // rather than only on a detected change, so a concurrent retag
            // between the lookup above and the save cannot skip it.
            authorizeUpdate: async (before, after) => {
              const resource = workflowAccessResource(after);
              if (
                !authorizeOrReject(
                  socket,
                  requestId,
                  principal,
                  "write",
                  resource,
                  ctx,
                ).allowed
              ) return false;
              // A retag or rename needs tag, judged against the stored tags
              // too; ids are not unique so the stored workflow counts only
              // under the name the edit loaded.
              const named = await ctx.repoContext.workflowRepo.findByName(
                before.name,
              );
              const stored = named?.id === workflow.id ? named : null;
              return authorizeRetag(socket, requestId, principal, {
                prior: (tags) => workflowAccessResource({ ...before, tags }),
                after: resource,
                loaded: before.tags,
                stored: stored ? { ...stored.tags } : null,
                afterTags: after.tags,
              }, ctx);
            },
            // expressions and steps the edit adds are authorized against this
            // writer; those already stored are not
            authorizeContent: async (before, after) => {
              const refusal = await authorizeWorkflowEdit(
                socketAuthority(socket, requestId, principal, ctx),
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
  // without a workflow this validates only the workflows the caller may read; a
  // named workflow is resolved first
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
    const deps = {
      ...createWorkflowValidateDeps(
        ctx.repoContext.workflowRepo,
        ctx.repoContext.definitionRepo,
        workflowsDirFor(ctx.repoDir),
      ),
      ...pulledExtensionWorkflowScope(
        ctx.repoContext,
        resolvePulledExtensionsRoot(ctx.repoDir),
      ),
    };

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
  // without a workflow this evaluates only the workflows the caller may read; a
  // named workflow is resolved first
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
  // a later --last-evaluated run replays what evaluate saves, inputs included,
  // so save only what the caller may run; a read-only caller gets the
  // evaluation back unsaved
  const runnable = resourceDecider(socket, principal, "run", ctx);
  const persist = (
    candidate: { name: string; tags: Record<string, string> },
  ) => runnable(workflowAccessResource(candidate));

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createWorkflowEvaluateDeps(
      ctx.repoDir,
      ctx.repoContext.workflowRepo,
      ctx.datastoreResolver,
      ctx.repoContext.definitionRepo,
      ctx.repoContext.hydrateFile,
      ctx.repoContext.unifiedDataRepo.fetchForeignContent,
      ctx.repoContext.unreadableContent,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      workflowEvaluate(libCtx, deps, {
        workflowIdOrName: workflow?.idOrName,
        byId: workflow?.byId,
        expectedName: workflow?.expectedName,
        inputs: payload?.inputs ?? {},
        include,
        persist,
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
      ...(payload.catchUp ? { catchUp: payload.catchUp } : {}),
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

    let builtIn: EffectiveTrigger | null = null;
    const workflow = await ctx.repoContext.workflowRepo.findByName(
      payload.workflowName,
    );
    if (workflow) {
      builtIn = {
        schedule: workflow.schedule ?? null,
        inputs: workflow.triggerInputs ?? {},
        catchUp: workflow.catchUp ?? null,
      };
    }

    const effective: EffectiveTrigger = {
      schedule: override?.schedule ?? builtIn?.schedule ?? null,
      inputs: {
        ...(builtIn?.inputs ?? {}),
        ...(override?.inputs ?? {}),
      },
      catchUp: override?.catchUp ?? builtIn?.catchUp ?? null,
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

function scheduleDeps(ctx: ConnectionContext): WorkflowScheduleDeps | null {
  if (!ctx.controlPlaneStore) return null;
  const scheduler = ctx.scheduledExecution;
  return createWorkflowScheduleDeps({
    workflowRepo: ctx.repoContext.workflowRepo,
    controlPlaneStore: ctx.controlPlaneStore,
    overrideSchedules: async () =>
      overrideSchedulesOf(
        scheduler ? scheduler.getTriggerOverrides() : Object.entries(
          (await readServeConfigFile(ctx.repoDir, ctx.serveConfigPath))
            ?.triggers ?? {},
        ),
      ),
    liveSchedules: scheduler
      ? () =>
        scheduler.listSchedules().map((entry) => ({
          workflowId: entry.workflowId,
          workflowName: entry.workflowName,
          cronExpression: entry.cronExpression,
          nextRun: entry.nextRun,
        }))
      : undefined,
  });
}

function sendNoPauseStore(
  socket: WebSocket,
  requestId: string,
  errorCode: string,
): void {
  sendError(
    socket,
    requestId,
    errorCode,
    "This server has no control-plane store to keep schedule pauses in",
  );
}

export async function handleWorkflowSchedulePause(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowSchedulePausePayload,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Authorize the workflow the request resolves to, by its canonical name,
  // and pause exactly that workflow's id: the identity authorized is the
  // identity stored.
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
      "workflow_schedule_pause_failed",
    )
  ) return;
  const deps = scheduleDeps(ctx);
  if (!deps) {
    sendNoPauseStore(socket, requestId, "workflow_schedule_pause_failed");
    return;
  }
  const workflow = targetArgument(target, payload.workflowIdOrName);

  try {
    let result: WorkflowSchedulePauseResponse["data"] | undefined;
    await consumeStream(
      workflowSchedulePause(handlerLibSwampContext(ctx), deps, {
        workflowIdOrName: workflow.idOrName,
        byId: workflow.byId,
        expectedName: workflow.expectedName,
        reason: payload.reason,
        until: payload.until,
        pausedBy: principal ? principalToString(principal) : "ghost",
      }),
      {
        pausing: () => {},
        completed: (e) => {
          result = e.data;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );
    if (!result) throw new Error("Pause did not complete");
    logger.info(
      "Paused the schedule of workflow {name} for {principal}",
      { name: result.workflowName, principal: result.pausedBy },
    );
    send(socket, {
      type: "workflow.schedule.pause",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_schedule_pause_failed", message);
  }
}

export async function handleWorkflowScheduleResume(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkflowScheduleResumePayload,
  _controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // As pause. A pause left for a workflow that is gone matches nothing, so
  // it is authorized as the bare id given, like an unresolved trigger name.
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
      "workflow_schedule_resume_failed",
    )
  ) return;
  const deps = scheduleDeps(ctx);
  if (!deps) {
    sendNoPauseStore(socket, requestId, "workflow_schedule_resume_failed");
    return;
  }
  const workflow = targetArgument(target, payload.workflowIdOrName);

  try {
    let result: WorkflowScheduleResumeResponse["data"] | undefined;
    await consumeStream(
      workflowScheduleResume(handlerLibSwampContext(ctx), deps, {
        workflowIdOrName: workflow.idOrName,
        byId: workflow.byId,
        expectedName: workflow.expectedName,
      }),
      {
        resuming: () => {},
        completed: (e) => {
          result = e.data;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );
    if (!result) throw new Error("Resume did not complete");
    if (result.wasPaused) {
      logger.info("Resumed the schedule of workflow {name}", {
        name: result.workflowName,
      });
    }
    send(socket, {
      type: "workflow.schedule.resume",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_schedule_resume_failed", message);
  }
}

export async function handleWorkflowScheduleList(
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
  const deps = scheduleDeps(ctx);
  if (!deps) {
    sendNoPauseStore(socket, requestId, "workflow_schedule_list_failed");
    return;
  }

  try {
    let result: WorkflowScheduleListResponse["data"] | undefined;
    await consumeStream(
      workflowScheduleList(handlerLibSwampContext(ctx), deps),
      {
        listing: () => {},
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

    // Each entry is shown only to a principal that may read its workflow.
    const canonical = canonicalResources(ctx);
    const schedules = await filterByResources(
      result?.schedules ?? [],
      (entry) => canonical.workflowOwners(entry.workflowId, entry.workflowName),
      socket,
      principal,
      "read",
      ctx,
    );
    send(socket, {
      type: "workflow.schedule.list",
      id: requestId,
      payload: { data: { schedules } },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "workflow_schedule_list_failed", message);
  }
}

/**
 * a failed write is refused with a message that names no server path; the path
 * and cause go to the log
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
        "run 'swamp serve reload'.",
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
