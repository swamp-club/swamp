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

import { delegationOfSessionName } from "./delegated_token_auth.ts";
import type { CompletedRunSlot } from "./handlers/run_data_attributes.ts";
import {
  deferCompletedForOutputs,
  mapWorkflowExecutionEvent,
} from "../libswamp/workflows/run.ts";
import { createStepLockHook, createWorkflowRunDeps } from "./deps.ts";
import { withRunCondition } from "../domain/access/access_resources.ts";
import { withSharedSyncGate } from "./sync_gate.ts";
import { isWireEvent, serializeEvent } from "./serializer.ts";
import { UserError } from "../domain/errors.ts";
import {
  resolveResumableRun,
  RunNotSuspendedError,
  SuspendedRunNotFoundError,
} from "../domain/workflows/suspended_run_resolver.ts";
import {
  isServeDrivenRun,
  type WorkflowRun,
} from "../domain/workflows/workflow_run.ts";
import { createEphemeralStore } from "../infrastructure/persistence/ephemeral_store.ts";
import {
  extractTraceContext,
  runWithParentTrace,
} from "../infrastructure/tracing/mod.ts";
import {
  type ActiveRunRegistry,
  RegistryCapacityError,
} from "./active_run_registry.ts";
import { type BufferTerminal, RunEventBuffer } from "./run_event_buffer.ts";
import { deleteActiveRun, writeActiveRun } from "./active_run_tracker.ts";
import {
  confirmRunReplicated,
  type ConnectionContext,
  decideSubjectAccess,
  type DecisionSubject,
  emitSystemAuditEvent,
  lockTimeoutErrorForClient,
  pushChangedToRemote,
  runFailureForClient,
  sanitizeErrorForClient,
  withCommittedUnknownSteps,
} from "./handlers/shared.ts";
import { resolveRecordedWorkflow } from "./handlers/resource_resolution.ts";
import {
  nestedPendingRefusalForClient,
  orphanedRefusalForClient,
} from "./handlers/nested_run_redaction.ts";
import { OrphanedNestedRunError } from "../domain/workflows/orphaned_nested_run.ts";
import {
  isFinishedRun,
  NestedRunLink,
  NestedRunPendingError,
  NestedRunUnreadableError,
} from "../domain/workflows/nested_run_link.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../domain/workflows/workflow_id.ts";
import { principalToString } from "../domain/access/principal.ts";
import type { Action } from "../domain/access/action.ts";
import {
  ContinuationHeldError,
  type ContinuationMode,
  RunRecordStaleError,
  serveInstanceOf,
  suspensionKeyOf,
} from "../domain/workflows/continuation_claim.ts";
import { decideContinuation } from "../domain/workflows/run_continuation.ts";
import {
  settleExpiredWaits,
  takePendingSignalsOfRun,
} from "../domain/workflows/signal_wait_cleanup.ts";
import type { SignalWaitStore } from "../domain/workflows/signal_wait_store.ts";
import { LockTimeoutError } from "../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { WorkflowRunCheckpointer } from "../infrastructure/persistence/workflow_run_checkpointer.ts";
import { runGeneratorWithVaultAccess } from "../domain/vaults/run_vault_access.ts";
import {
  resumeRunVaultScope,
  runVaultScopeContext,
} from "./run_vault_access_policy.ts";
import {
  RESUME_INPUTS_REFUSED,
  type ResumeCaller,
  resumeInputsRefusal,
} from "./resume_caller_rules.ts";

const logger = getSwampLogger(["serve", "resume"]);
const DEFAULT_BUFFER_CAPACITY = 10_000;

export const CONTINUATION_HELD_CODE = "continuation_held";

export const RUN_NOT_SUSPENDED_CODE = "run_not_suspended";

export const RUN_RECORD_STALE_CODE = "run_record_stale";

export interface DetachedResumeRequest {
  workflowIdOrName: string;
  runId?: string;
  byId?: boolean;
  expectedName?: string;
  from?: string;
  fromJob?: string;
  /**
   * auto-resume sets it so an approval never starts a retry of a failed run,
   * even if the run fails between the approval and the launch
   */
  suspendedOnly?: boolean;
  inputs?: Record<string, unknown>;
  traceparent?: string;
  tracestate?: string;
  principalId: string | null;
  subject?: DecisionSubject;
  parentGrant?: Action;
  /**
   * the caller of a manual resume; absent for serve's own continuations, which
   * add no inputs and stay held to the run's principal alone
   */
  resumer?: ResumeCaller;
  /**
   * set by the continuation of a settled run, which may find a peer got there
   * first; a resume after an approval keeps workflow_resume_failed for a run no
   * longer suspended
   */
  lostRaceIsOrdinary?: boolean;
  continuation?: ContinuationMode;
  requireCurrentRecord?: boolean;
  /**
   * a refusal naming nested runs names them only when every one is readable;
   * without this, refusals are generic
   */
  canReadWorkflow?: (
    workflow: { workflowId: string; workflowName: string },
  ) => Promise<boolean>;
  onTerminal?: (terminal: BufferTerminal) => void | Promise<void>;
}

export type DetachedResumeResult =
  | {
    ok: true;
    runId: string;
    buffer: RunEventBuffer;
    completedRun: CompletedRunSlot;
  }
  | { ok: false; code: string; message: string; refusal?: ResumeRefusal };

/** told apart here since a refused resume shares one code */
export type ResumeRefusal =
  | "not_found"
  | "nested_pending"
  | "refused"
  | typeof RESUME_INPUTS_REFUSED;

function lostRace(request: DetachedResumeRequest, error: unknown): boolean {
  return request.lostRaceIsOrdinary === true &&
    error instanceof RunNotSuspendedError;
}

export async function startDetachedResume(
  ctx: ConnectionContext,
  registry: ActiveRunRegistry,
  request: DetachedResumeRequest,
): Promise<DetachedResumeResult> {
  const workflowRepo = ctx.repoContext.workflowRepo;
  const runRepo = ctx.repoContext.workflowRunRepo;

  let resolvedRun: WorkflowRun;
  let workflowName: string;
  let workflowId: string;
  try {
    const result = await resolveResumableRun(
      workflowRepo,
      runRepo,
      request.workflowIdOrName,
      request.runId,
      {
        fromStep: request.from,
        fromJob: request.fromJob,
        suspendedOnly: request.suspendedOnly,
        byId: request.byId,
        expectedName: request.expectedName,
        signalWaits: ctx.repoContext.signalWaits,
      },
    );
    resolvedRun = result.run;
    workflowName = result.workflowName;
    workflowId = result.workflowId;
  } catch (error) {
    if (
      error instanceof NestedRunPendingError ||
      error instanceof NestedRunUnreadableError
    ) {
      return {
        ok: false,
        code: "workflow_resume_failed",
        message: await nestedPendingRefusalForClient(
          error,
          request.canReadWorkflow,
        ),
        refusal: "nested_pending",
      };
    }
    if (error instanceof OrphanedNestedRunError) {
      return {
        ok: false,
        code: "workflow_resume_failed",
        message: await orphanedRefusalForClient(
          error,
          request.canReadWorkflow,
        ),
        refusal: "refused",
      };
    }
    return {
      ok: false,
      code: lostRace(request, error)
        ? RUN_NOT_SUSPENDED_CODE
        : "workflow_resume_failed",
      message: sanitizeErrorForClient(error),
      // anything else is a fault, not an answer: a caller may try it again
      ...(error instanceof SuspendedRunNotFoundError
        ? { refusal: "not_found" as const }
        : error instanceof UserError
        ? { refusal: "refused" as const }
        : {}),
    };
  }

  if (request.resumer) {
    const refusal = resumeInputsRefusal(
      resolvedRun,
      request.resumer,
      request.inputs,
    );
    if (refusal !== undefined) {
      return {
        ok: false,
        code: "workflow_resume_failed",
        message: refusal,
        refusal: RESUME_INPUTS_REFUSED,
      };
    }
  }

  // a run bound to a delegation resumes only while the delegation stands,
  // whoever asks: the sweep, a boot, a gate decision or the app itself
  const boundDelegation = delegationOfSessionName(
    resolvedRun.triggeringPrincipal?.tokenBinding?.name ?? "",
  );
  if (
    boundDelegation !== undefined &&
    ctx.delegationDirectory?.standingOf(boundDelegation).kind !== "standing"
  ) {
    return {
      ok: false,
      code: "workflow_resume_failed",
      message:
        "This run was started through a link that has ended, so it can't be resumed",
      refusal: "refused",
    };
  }
  const boundPerson = boundDelegation === undefined
    ? undefined
    : ctx.delegationDirectory?.recordOf(boundDelegation)?.person;
  if (
    boundPerson !== undefined && ctx.tokenAdmission &&
    !ctx.tokenAdmission.delegation(boundPerson).admitted
  ) {
    return {
      ok: false,
      code: "workflow_resume_failed",
      message:
        "This run was started through a link for someone no longer admitted to this server, so it can't be resumed",
      refusal: "refused",
    };
  }

  const buffer = new RunEventBuffer(DEFAULT_BUFFER_CAPACITY, {
    holdOutcome: ctx.holdRepliesUntilCommitted === true,
  });
  const runController = new AbortController();
  const runId: string = resolvedRun.id;
  const startedAt = new Date();
  const completedRun: CompletedRunSlot = {};

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  try {
    registry.register({
      runId,
      kind: "workflow-resume",
      resourceName: workflowName,
      resourceId: workflowId,
      buffer,
      controller: runController,
      startedAt,
      completion,
      principalId: request.principalId,
      completedRun,
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
        : err.code === "reserved"
        ? "Another operation on this run is in progress; try again"
        : err.code === "draining"
        ? "Serve is shutting down; try again once it is back"
        : "Too many concurrent runs; wait for active runs to complete";
      return { ok: false, code: err.code, message: clientMsg };
    }
    return {
      ok: false,
      code: "internal_error",
      message: "Run registration failed",
    };
  }

  (async () => {
    const stepLockHook = createStepLockHook(
      ctx.repoDir,
      ctx.repoContext,
      ctx.datastoreConfig,
      ctx.syncService,
      ctx.syncGate,
    );

    // Assigned in the root below, which control flow analysis cannot see.
    let ephemeral = null as ReturnType<typeof createEphemeralStore> | null;
    let terminal: BufferTerminal = { kind: "done" };
    const runCheckpointer = new WorkflowRunCheckpointer(ctx.repoContext);
    try {
      // the root covers the resume and its terminal frame; its flush is the
      // post-resume push. The cleanup and the parent's auto-resume run after it
      // ends, so that resume opens a root of its own
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

            ephemeral = createEphemeralStore(
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
              resolvedRun,
              request.resumer?.vaultScope ?? undefined,
            );
            const doResume = async () => {
              for await (
                const { event } of deferCompletedForOutputs(
                  runGeneratorWithVaultAccess(
                    vaultScope?.access,
                    () =>
                      service.resume(workflowName, resolvedRun.id, {
                        signal: runController.signal,
                        inputs: request.inputs ?? {},
                        fromStep: request.from,
                        fromJob: request.fromJob,
                        suspendedOnly: request.suspendedOnly,
                        instanceId: ctx.instanceId,
                        continuation: request.continuation,
                        requireCurrentRecord: request.requireCurrentRecord,
                      }),
                  ),
                  (completed) => {
                    completedRun.run = completed;
                    return Promise.resolve(undefined);
                  },
                )
              ) {
                const mapped = mapWorkflowExecutionEvent(event, runRepo);
                if (!isWireEvent(mapped)) continue;
                const serialized = serializeEvent(
                  mapped as { kind: string; [key: string]: unknown },
                );
                buffer.push(serialized);
              }
            };

            if (request.traceparent) {
              const headers: Record<string, string> = {
                traceparent: request.traceparent,
              };
              if (request.tracestate) headers.tracestate = request.tracestate;
              const traceCtx = extractTraceContext(headers);
              await runWithParentTrace(traceCtx, doResume);
            } else {
              await doResume();
            }
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              terminal = {
                kind: "error",
                code: "cancelled",
                message: "Operation was cancelled",
              };
            } else if (error instanceof LockTimeoutError) {
              const lt = lockTimeoutErrorForClient(error);
              terminal = {
                kind: "error",
                code: lt.code,
                message: lt.message,
                details: lt.details,
              };
            } else if (error instanceof ContinuationHeldError) {
              // Another holder took the suspension first. The message names
              // nothing a client may not know: an instance id, or nobody.
              terminal = {
                kind: "error",
                code: CONTINUATION_HELD_CODE,
                message: error.message,
              };
            } else if (error instanceof RunRecordStaleError) {
              terminal = {
                kind: "error",
                code: RUN_RECORD_STALE_CODE,
                message: error.message,
              };
            } else if (
              error instanceof NestedRunPendingError ||
              error instanceof NestedRunUnreadableError
            ) {
              // The resume checks the nested runs again, and one may have
              // changed since the check above.
              terminal = {
                kind: "error",
                code: "workflow_resume_failed",
                message: await nestedPendingRefusalForClient(
                  error,
                  request.canReadWorkflow,
                ),
              };
            } else if (error instanceof OrphanedNestedRunError) {
              terminal = {
                kind: "error",
                code: "workflow_resume_failed",
                message: await orphanedRefusalForClient(
                  error,
                  request.canReadWorkflow,
                ),
              };
            } else {
              terminal = {
                kind: "error",
                code: lostRace(request, error)
                  ? RUN_NOT_SUSPENDED_CODE
                  : "workflow_resume_failed",
                message: sanitizeErrorForClient(error),
              };
            }
          } finally {
            // on v3 a success waits for the root's commit, and with replication
            // on for its confirmation below
            if (
              terminal.kind !== "done" ||
              (!ctx.confirmReplicated && ctx.holdRepliesUntilCommitted !== true)
            ) {
              buffer.finish(terminal);
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
      if (!buffer.finished) {
        const unconfirmed = await confirmRunReplicated(
          ctx,
          "workflow_resume_failed",
        );
        buffer.finish(
          unconfirmed === undefined
            ? terminal
            : { kind: "error", ...unconfirmed },
        );
      }
    } catch (error) {
      // The resume answers its own errors, so only a root that could not
      // open, or could not commit, lands here before the terminal frame was
      // sent.
      if (!buffer.finished) {
        terminal = {
          kind: "error",
          ...runFailureForClient(error, "workflow_resume_failed"),
        };
      }
      throw error;
    } finally {
      if (!buffer.finished) buffer.finish(terminal);
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
      try {
        await request.onTerminal?.(terminal);
      } catch (callbackErr) {
        logger.warn("Resume terminal callback failed: {error}", {
          error: callbackErr instanceof Error
            ? callbackErr.message
            : String(callbackErr),
        });
      }
      if (request.subject && resolvedRun.parentRun !== undefined) {
        try {
          await autoResumeParentAfterChild(
            ctx,
            { workflowId, runId },
            request.subject,
            request.parentGrant,
          );
        } catch (parentErr) {
          logger.warn(
            "Auto-resume of the parent of run {runId} failed: {error}",
            {
              runId,
              error: parentErr instanceof Error
                ? parentErr.message
                : String(parentErr),
            },
          );
        }
      }
    }
  })().catch((err) => {
    logger.warn("Unhandled error in detached workflow resume: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (ctx.controlPlaneStore && ctx.instanceId) {
    writeActiveRun(ctx.controlPlaneStore, ctx.instanceId, runId, {
      resourceName: workflowName,
      resourceId: workflowId,
      runKind: "workflow-resume",
      startedAt: startedAt.toISOString(),
    });
  }

  return { ok: true, runId, buffer, completedRun };
}

export interface ApprovalOutcome {
  workflowName: string;
  runId: string;
  decidedBy: string;
  allGatesDecided: boolean;
}

/**
 * a member-driven run's state is that member's report: resuming it here would
 * run later steps with someone else's authority, so its owner resumes it.
 * Elsewhere every record is this host's own
 */
export function serveMayActOnRun(
  ctx: ConnectionContext,
  run: Pick<WorkflowRun, "triggeringPrincipal" | "instanceId">,
): boolean {
  return ctx.repoContext.takesForwardedRunRecords !== true ||
    isServeDrivenRun(run);
}

// Decided whether or not gates remain: a partly approved member-driven run
// still goes back to its owner, never to a --server resume.
export async function ownerResumesRun(
  ctx: ConnectionContext,
  outcome: ApprovalOutcome,
): Promise<boolean> {
  if (ctx.repoContext.takesForwardedRunRecords !== true) return false;
  const workflow = await ctx.repoContext.workflowRepo.findByName(
    outcome.workflowName,
  );
  if (workflow === null) return false;
  const run = await ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(workflow.id),
    createWorkflowRunId(outcome.runId),
  );
  return run !== null && !serveMayActOnRun(ctx, run);
}

export async function autoResumeAfterApproval(
  ctx: ConnectionContext,
  outcome: ApprovalOutcome,
  principalId: string | null,
  decisionSubject?: DecisionSubject,
): Promise<boolean> {
  const registry = ctx.activeRunRegistry;
  if (!registry || !outcome.allGatesDecided) return false;

  const workflow = await ctx.repoContext.workflowRepo.findByName(
    outcome.workflowName,
  );
  if (!workflow?.shouldAutoResume(ctx.serveOptions?.autoResume ?? false)) {
    return false;
  }
  if (await ownerResumesRun(ctx, outcome)) return false;

  const subject =
    `workflow=${outcome.workflowName} run=${outcome.runId} approvedBy=${outcome.decidedBy}`;
  const launched = await startDetachedResume(ctx, registry, {
    workflowIdOrName: outcome.workflowName,
    runId: outcome.runId,
    suspendedOnly: true,
    principalId,
    subject: decisionSubject,
    // Serve's own resume, not a person's: it never replaces a claim.
    continuation: { kind: "automatic", takeover: false },
    onTerminal: (terminal) => {
      if (terminal.kind !== "error") return;
      if (terminal.code === CONTINUATION_HELD_CODE) return;
      logger.warn(
        "Auto-resume of run {runId} failed ({code}): {message}; the resume did not complete",
        {
          runId: outcome.runId,
          code: terminal.code,
          message: terminal.message,
        },
      );
      emitSystemAuditEvent(
        ctx,
        "workflow.auto_resume_failed",
        `${subject} code=${terminal.code}`,
      );
    },
  });

  if (!launched.ok) {
    logger.warn(
      "Auto-resume of run {runId} was not started ({code}): {message}; the run was not resumed",
      {
        runId: outcome.runId,
        code: launched.code,
        message: launched.message,
      },
    );
    emitSystemAuditEvent(
      ctx,
      "workflow.auto_resume_failed",
      `${subject} code=${launched.code}`,
    );
    return false;
  }

  emitSystemAuditEvent(ctx, "workflow.auto_resume", subject);
  return true;
}

export async function autoResumeParentAfterChild(
  ctx: ConnectionContext,
  child: { workflowId: string; runId: string },
  subject: DecisionSubject,
  grant: Action = "approve",
): Promise<boolean> {
  const registry = ctx.activeRunRegistry;
  if (!registry) return false;
  const workflowRepo = ctx.repoContext.workflowRepo;
  const runRepo = ctx.repoContext.workflowRunRepo;
  const link = new NestedRunLink({ runRepo, workflowRepo });

  const finished = await runRepo.findById(
    createWorkflowId(child.workflowId),
    createWorkflowRunId(child.runId),
  );
  // Done is also reported for a run that suspended again at another gate.
  if (!finished || !isFinishedRun(finished)) return false;
  // A member's report of its child ending moves no parent here.
  if (!serveMayActOnRun(ctx, finished)) return false;
  const parentLink = finished.parentRun;
  if (parentLink?.kind !== "valid") return false;
  const parentRef = parentLink.ref;
  const detail =
    `workflow=${parentRef.workflowName} run=${parentRef.runId} nestedRun=${finished.id}`;
  const skip = (reason: string): false => {
    logger.info(
      "Auto-resume of parent run {runId} skipped: {reason}",
      { runId: parentRef.runId, reason },
    );
    emitSystemAuditEvent(
      ctx,
      "workflow.auto_resume_skipped",
      `${detail} reason=${reason}`,
    );
    return false;
  };

  const active = registry.get(parentRef.runId);
  if (active) await active.completion;
  if (registry.draining) return skip("shutting_down");

  // A parent that no longer waits on this exact run (ended, retried, or
  // never linked it) is left alone.
  if (!(await link.isAwaitedByParent(finished))) return false;
  const parent = await runRepo.findById(
    createWorkflowId(parentRef.workflowId),
    createWorkflowRunId(parentRef.runId),
  );
  if (!parent || parent.status !== "suspended") return false;
  if (!serveMayActOnRun(ctx, parent)) return false;
  // Saved suspended while other steps still ran: another process may still
  // drive it.
  if (parent.jobs.some((j) => j.steps.some((s) => s.status === "running"))) {
    return skip("parent_steps_running");
  }
  if (parent.findWaitingApprovalStep() !== undefined) return false;
  // A wait for a signal with no outcome yet keeps the parent waiting. A
  // cancelled one means this copy of the parent is from before it ended,
  // as in `decideContinuation`.
  for (const ref of parent.findSignalWaits()) {
    if (!ref.wait) return false;
    const outcome = await outcomesOf(ctx).findOutcome(ref.wait.id);
    if (outcome.kind !== "found") return false;
    if (outcome.record.kind === "cancelled") return false;
  }
  if (!(await link.childrenSettled(parent))) return false;

  const resolution = await resolveRecordedWorkflow(
    workflowRepo,
    parentRef.workflowId,
    parentRef.workflowName,
  );
  if (resolution.status !== "found") return skip("parent_workflow_not_found");
  const workflow = await workflowRepo.findById(
    createWorkflowId(resolution.id),
  );
  if (!workflow || workflow.name !== resolution.name) {
    return skip("parent_workflow_not_found");
  }
  if (!workflow.shouldAutoResume(ctx.serveOptions?.autoResume ?? false)) {
    return skip("policy");
  }
  if (
    !(await decideSubjectAccess(
      ctx,
      subject,
      grant,
      // serve decided a gate on the child; the parent's own run is what it moves
      grant === "approve"
        ? withRunCondition(resolution.resource, {
          initiatedBy: parent.initiatedBy,
          serveDriven: isServeDrivenRun(parent),
        })
        : resolution.resource,
    ))
  ) {
    return skip("not_authorized");
  }

  const launched = await startDetachedResume(ctx, registry, {
    workflowIdOrName: resolution.id,
    byId: true,
    expectedName: resolution.name,
    runId: parent.id,
    suspendedOnly: true,
    principalId: subject.principal
      ? principalToString(subject.principal)
      : null,
    subject,
    parentGrant: grant,
    continuation: { kind: "automatic", takeover: false },
    onTerminal: (terminal) => {
      if (terminal.kind !== "error") return;
      if (terminal.code === CONTINUATION_HELD_CODE) return;
      emitSystemAuditEvent(
        ctx,
        "workflow.auto_resume_failed",
        `${detail} code=${terminal.code}`,
      );
    },
  });
  if (!launched.ok) {
    emitSystemAuditEvent(
      ctx,
      "workflow.auto_resume_failed",
      `${detail} code=${launched.code}`,
    );
    return false;
  }
  emitSystemAuditEvent(ctx, "workflow.auto_resume", detail);
  return true;
}

function outcomesOf(
  ctx: ConnectionContext,
): Pick<SignalWaitStore, "findOutcome"> {
  const support = ctx.repoContext.signalWaits;
  return support?.supported
    ? support.store
    : { findOutcome: () => Promise.resolve({ kind: "absent" }) };
}

export interface ContinuationCause {
  readonly kind: "signal" | "sweep";
  readonly principalId: string | null;
  readonly subject?: DecisionSubject;
  readonly takeover: boolean;
}

/**
 * a run the sweep cannot launch is tried on every pass, so its skip is audited
 * once per suspension and reason
 */
const auditedSkips = new WeakMap<object, Map<string, string>>();
const AUDITED_SKIPS_MAX = 10_000;

function skipMemo(key: object): Map<string, string> {
  let memo = auditedSkips.get(key);
  if (!memo) {
    memo = new Map();
    auditedSkips.set(key, memo);
  }
  return memo;
}

/**
 * such a run is still settled, so every pass would launch it again; each
 * failure doubles the wait before the next attempt instead
 */
interface FailedContinuation {
  readonly suspensionKey: string;
  readonly failures: number;
  readonly retryAt: number;
}
const failedContinuations = new WeakMap<
  object,
  Map<string, FailedContinuation>
>();

export const CONTINUATION_BACKOFF_BASE_MS = 30_000;
export const CONTINUATION_BACKOFF_MAX_MS = 900_000;

function failedContinuationsOf(key: object): Map<string, FailedContinuation> {
  let failed = failedContinuations.get(key);
  if (!failed) {
    failed = new Map();
    failedContinuations.set(key, failed);
  }
  return failed;
}

export function continuationRetryAt(
  registry: ActiveRunRegistry,
  runId: string,
): number | undefined {
  return failedContinuations.get(registry)?.get(runId)?.retryAt;
}

/**
 * on a synced datastore this is the lasting state of every copy of a run a peer
 * resumed, so each is rechecked only after the interval, not every pass:
 * looking costs a datastore read per wait and per claim
 */
const heldElsewhere = new WeakMap<
  object,
  Map<string, { suspensionKey: string; recheckAt: number }>
>();

export const HELD_ELSEWHERE_RECHECK_MS = 600_000;

const LOCAL_CLAIM_GRACE_MS = 60_000;

const BENIGN_REFUSALS: ReadonlySet<string> = new Set([
  CONTINUATION_HELD_CODE,
  RUN_NOT_SUSPENDED_CODE,
  RUN_RECORD_STALE_CODE,
  "already_registered",
  "reserved",
  "draining",
]);

/**
 * the sweep has no signaller to authorize the parent's resume, so the parent
 * stays suspended until someone resumes it
 */
export async function noteParkedParent(
  ctx: ConnectionContext,
  child: WorkflowRun,
): Promise<boolean> {
  if (child.parentRun?.kind !== "valid") return false;
  const workflowRepo = ctx.repoContext.workflowRepo;
  const runRepo = ctx.repoContext.workflowRunRepo;
  const finished = await runRepo.findById(
    createWorkflowId(child.workflowId),
    createWorkflowRunId(child.id),
  );
  if (!finished || !isFinishedRun(finished)) return false;
  const link = new NestedRunLink({ runRepo, workflowRepo });
  if (!(await link.isAwaitedByParent(finished))) return false;
  const parent = child.parentRun.ref;
  logger.info(
    "Run {runId} ended, and its parent run {parentRunId} stays suspended: the sweep has no caller to authorize the parent's resume. Resume it with: swamp workflow resume {parentWorkflow} --run {parentRunId}",
    {
      runId: child.id,
      parentRunId: parent.runId,
      parentWorkflow: parent.workflowName,
    },
  );
  return true;
}

export async function continueSettledRun(
  ctx: ConnectionContext,
  target: { workflowId: string; runId: string },
  cause: ContinuationCause,
  now: () => number = Date.now,
): Promise<boolean> {
  const registry = ctx.activeRunRegistry;
  if (!registry || registry.draining) return false;
  if (registry.get(target.runId)) return false;

  const workflowRepo = ctx.repoContext.workflowRepo;
  const run = await ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(target.workflowId),
    createWorkflowRunId(target.runId),
  );
  if (!run || run.status !== "suspended") return false;
  // Before the verdict, which would take a pending signal someone else sent
  // and settle the run's waits on its report.
  if (!serveMayActOnRun(ctx, run)) return false;

  // The policy first: it is read from this host, where the verdict below
  // reads one wait outcome per wait from the datastore, and most runs
  // belong to workflows serve never resumes. Not reported: with
  // auto-resume off, a settled run left suspended is what its owner asked
  // for, as it is after an approval.
  const resolution = await resolveRecordedWorkflow(
    workflowRepo,
    run.workflowId,
    run.workflowName,
  );
  const workflow = resolution.status === "found"
    ? await workflowRepo.findById(createWorkflowId(resolution.id))
    : null;
  const known = resolution.status === "found" && workflow !== null &&
    workflow.name === resolution.name;
  if (
    known && !workflow.shouldAutoResume(ctx.serveOptions?.autoResume ?? false)
  ) {
    return false;
  }

  const suspensionKey = await suspensionKeyOf(run);
  let held = heldElsewhere.get(registry);
  if (!held) {
    held = new Map();
    heldElsewhere.set(registry, held);
  }
  const heldBefore = held.get(run.id);
  if (heldBefore && heldBefore.suspensionKey !== suspensionKey) {
    held.delete(run.id);
  } else if (heldBefore && !cause.takeover && now() < heldBefore.recheckAt) {
    return false;
  }
  const rememberHeld = (): false => {
    if (cause.takeover) return false;
    if (held.size >= AUDITED_SKIPS_MAX) held.clear();
    held.set(run.id, {
      suspensionKey,
      recheckAt: now() + HELD_ELSEWHERE_RECHECK_MS,
    });
    return false;
  };

  // A recovered run waits for the resume `workflow recover` asked for: no
  // signal or approval released the steps it reset.
  if (run.awaitsResumeAfterRecovery) return false;
  let verdict = await decideContinuation(run, outcomesOf(ctx));
  // nothing else looks at a deadline under serve: a run held back only by its
  // waits has the overdue ones settled as timed out here, and the resume fails
  // their steps as a manual one would
  let waitsTimedOut = 0;
  const waits = ctx.repoContext.signalWaits;
  if (
    verdict.kind === "blocked" && verdict.reason === "wait_unsettled" &&
    waits?.supported
  ) {
    // a wait can be open over a pending signal that applies to it, left by a
    // signaller that stopped before it read the key again; it is taken here,
    // before any wait is timed out
    const signalsTaken = await takePendingSignalsOfRun(waits.store, run);
    waitsTimedOut = await settleExpiredWaits(
      waits.store,
      run,
      new Date(now()),
    );
    if (waitsTimedOut > 0) {
      logger.info(
        "Run {runId} of workflow {workflow}: {count} wait(s) for a signal passed their deadline and were settled as timed out",
        { runId: run.id, workflow: run.workflowName, count: waitsTimedOut },
      );
    }
    if (waitsTimedOut > 0 || signalsTaken > 0) {
      verdict = await decideContinuation(run, outcomesOf(ctx));
    }
  }
  if (verdict.kind !== "resumable") return false;

  const detail =
    `workflow=${run.workflowName} run=${run.id} cause=${cause.kind}` +
    (waitsTimedOut > 0 ? ` waitsTimedOut=${waitsTimedOut}` : "");
  const memo = skipMemo(registry);
  const skip = (event: "skipped" | "failed", reason: string): false => {
    const seen = `${suspensionKey}:${reason}`;
    if (memo.get(run.id) === seen) return false;
    if (memo.size >= AUDITED_SKIPS_MAX) memo.clear();
    memo.set(run.id, seen);
    logger.info(
      "Run {runId} was not continued ({reason}); it stays suspended",
      { runId: run.id, reason },
    );
    emitSystemAuditEvent(
      ctx,
      `workflow.auto_resume_${event}`,
      `${detail} ${event === "failed" ? "code" : "reason"}=${reason}`,
    );
    return false;
  };

  if (!known || resolution.status !== "found") {
    return skip("skipped", "workflow_not_found");
  }

  const failed = failedContinuationsOf(registry);
  const earlier = failed.get(run.id);
  if (earlier && earlier.suspensionKey !== suspensionKey) failed.delete(run.id);
  const failures = earlier?.suspensionKey === suspensionKey
    ? earlier.failures
    : 0;
  if (failures > 0 && now() < earlier!.retryAt) return false;

  // An early look, so a run a peer has consumed is not registered and
  // charged only to be refused. The resume takes the claim itself.
  const claims = ctx.repoContext.continuationClaims;
  try {
    if (claims && (!claims.usable || await claims.usable())) {
      const claimed = await claims.store.find(run.id, suspensionKey);
      if (claimed && claimed.holder !== claims.holder) {
        // A local command's claim on a run this instance knows is still
        // suspended, long after the command would have saved it: the
        // command died first, and only a manual resume replaces its claim.
        if (
          cause.takeover && serveInstanceOf(claimed.holder) === undefined &&
          now() - new Date(claimed.claimedAt).getTime() >
            LOCAL_CLAIM_GRACE_MS
        ) {
          logger.info(
            "Run {runId} is claimed by a local command and still reads as suspended here. If that command is no longer running, resume it with: swamp workflow resume {workflow} --run {runId}",
            { runId: run.id, workflow: run.workflowName },
          );
          return skip("skipped", "held_by_local_command");
        }
        if (!cause.takeover) return rememberHeld();
        if (await claims.liveness(claimed.holder) !== "dead") return false;
      }
    }
  } catch (error) {
    logger.debug("Continuation claims of run {runId} are unreadable: {error}", {
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return skip("failed", "claim_store_unavailable");
  }

  // The same for a copy of the run that is behind the datastore's. The
  // resume compares again under the run's claim, which is what decides.
  const recordCurrency = ctx.repoContext.runRecordCurrency;
  if (recordCurrency) {
    let current: boolean;
    try {
      current = await recordCurrency({
        workflowId: resolution.id,
        runId: run.id,
      });
    } catch (error) {
      logger.debug(
        "Run {runId} could not be read from the datastore: {error}",
        {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return skip("failed", "run_record_unreadable");
    }
    if (!current) return rememberHeld();
  }

  const launched = await startDetachedResume(ctx, registry, {
    workflowIdOrName: resolution.id,
    byId: true,
    expectedName: resolution.name,
    runId: run.id,
    suspendedOnly: true,
    principalId: cause.principalId,
    subject: cause.subject,
    parentGrant: "signal",
    continuation: { kind: "automatic", takeover: cause.takeover },
    requireCurrentRecord: true,
    lostRaceIsOrdinary: true,
    onTerminal: async (terminal) => {
      if (terminal.kind !== "error") {
        memo.delete(run.id);
        failed.delete(run.id);
        if (cause.subject === undefined) await noteParkedParent(ctx, run);
        return;
      }
      if (
        terminal.code === CONTINUATION_HELD_CODE ||
        terminal.code === RUN_RECORD_STALE_CODE
      ) {
        rememberHeld();
      }
      if (BENIGN_REFUSALS.has(terminal.code)) return;
      if (failed.size >= AUDITED_SKIPS_MAX) failed.clear();
      failed.set(run.id, {
        suspensionKey,
        failures: failures + 1,
        retryAt: now() + Math.min(
          CONTINUATION_BACKOFF_BASE_MS * 2 ** failures,
          CONTINUATION_BACKOFF_MAX_MS,
        ),
      });
      skip("failed", terminal.code);
    },
  });
  if (!launched.ok) {
    return BENIGN_REFUSALS.has(launched.code)
      ? false
      : skip("failed", launched.code);
  }

  // the memo is kept until the resume ends well: one that fails and leaves the
  // run suspended is launched again after its backoff, and the launch and its
  // failure are each reported once
  if (failures === 0) emitSystemAuditEvent(ctx, "workflow.auto_resume", detail);
  return true;
}
