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
 * Launches a detached workflow resume that serve drives itself.
 *
 * Shared by the `workflow.resume` handler, which then streams the buffer to
 * its client, and by auto-resume on approval, which has no client at all.
 */

import { mapWorkflowExecutionEvent } from "../libswamp/workflows/run.ts";
import { createStepLockHook, createWorkflowRunDeps } from "./deps.ts";
import { withSharedSyncGate } from "./sync_gate.ts";
import { isWireEvent, serializeEvent } from "./serializer.ts";
import {
  resolveResumableRun,
  RunNotSuspendedError,
} from "../domain/workflows/suspended_run_resolver.ts";
import type { WorkflowRun } from "../domain/workflows/workflow_run.ts";
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
  type ConnectionContext,
  decideSubjectAccess,
  type DecisionSubject,
  emitSystemAuditEvent,
  lockTimeoutErrorForClient,
  pushChangedToRemote,
  sanitizeErrorForClient,
} from "./handlers/shared.ts";
import { resolveRecordedWorkflow } from "./handlers/resource_resolution.ts";
import { nestedPendingRefusalForClient } from "./handlers/nested_run_redaction.ts";
import {
  isFinishedRun,
  NestedRunLink,
  NestedRunPendingError,
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
  serveInstanceOf,
  suspensionKeyOf,
} from "../domain/workflows/continuation_claim.ts";
import { decideContinuation } from "../domain/workflows/run_continuation.ts";
import type { SignalWaitStore } from "../domain/workflows/signal_wait_store.ts";
import { LockTimeoutError } from "../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { runGeneratorWithVaultAccess } from "../domain/vaults/run_vault_access.ts";
import {
  resumeRunVaultScope,
  runVaultScopeContext,
} from "./run_vault_access_policy.ts";

const logger = getSwampLogger(["serve", "resume"]);
const DEFAULT_BUFFER_CAPACITY = 10_000;

/** Terminal code of a resume refused because another holder has the claim. */
export const CONTINUATION_HELD_CODE = "continuation_held";

/**
 * Terminal code of a continuation that lost: the run was no longer suspended
 * by the time the resume looked. Every other resume keeps
 * `workflow_resume_failed` for the same refusal.
 */
export const RUN_NOT_SUSPENDED_CODE = "run_not_suspended";

export interface DetachedResumeRequest {
  /** Workflow id or name, resolved the same way as `workflow resume`. */
  workflowIdOrName: string;
  runId?: string;
  /**
   * Treat `workflowIdOrName` as a workflow id the caller already resolved
   * and authorized, and look it up by id only.
   */
  byId?: boolean;
  /** With `byId`, the workflow name the caller authorized. */
  expectedName?: string;
  /** Resume from a failed step instead of a decided approval gate. */
  from?: string;
  /**
   * Accept only a suspended run. Auto-resume sets it so an approval can
   * never start a retry of a failed run, even if the run fails between the
   * approval and the launch.
   */
  suspendedOnly?: boolean;
  inputs?: Record<string, unknown>;
  traceparent?: string;
  tracestate?: string;
  /** Principal charged against the registry's per-principal cap. */
  principalId: string | null;
  /**
   * Who asked for the resume. When the run is a nested workflow's run, its
   * parent is auto-resumed for this subject once it ends, if the parent's
   * policy and the subject's access allow (swamp-club#2736).
   */
  subject?: DecisionSubject;
  /**
   * The grant `subject` must still hold on the parent workflow for that
   * auto-resume: `approve` after an approval, the default, and `signal`
   * after a signal (swamp-club#3108).
   */
  parentGrant?: Action;
  /**
   * Answer a run that is no longer suspended with
   * {@link RUN_NOT_SUSPENDED_CODE}. Set by the continuation of a settled
   * run, which may find a peer got there first; a resume that follows an
   * approval keeps `workflow_resume_failed`.
   */
  lostRaceIsOrdinary?: boolean;
  /**
   * Who asks for the suspension's continuation claim. Unset for a resume a
   * person asked for.
   */
  continuation?: ContinuationMode;
  /**
   * Whether the requester may read a workflow. A refusal naming nested runs
   * names them only when every one is readable; otherwise it is generic.
   * Without it, refusals are generic.
   */
  canReadWorkflow?: (
    workflow: { workflowId: string; workflowName: string },
  ) => Promise<boolean>;
  /**
   * Called once the run ends, with the same terminal pushed to the buffer,
   * after the run left the registry. Awaited.
   */
  onTerminal?: (terminal: BufferTerminal) => void | Promise<void>;
}

export type DetachedResumeResult =
  | { ok: true; runId: string; buffer: RunEventBuffer }
  | { ok: false; code: string; message: string };

/** Whether `error` is a resume serve launched by itself losing a race. */
function lostRace(request: DetachedResumeRequest, error: unknown): boolean {
  return request.lostRaceIsOrdinary === true &&
    error instanceof RunNotSuspendedError;
}

/**
 * Resolves the run, registers it in the active-run registry and starts the
 * resume in the background. Fails fast, without starting anything, when the
 * run is not resumable or the registry refuses it.
 */
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
        suspendedOnly: request.suspendedOnly,
        byId: request.byId,
        expectedName: request.expectedName,
      },
    );
    resolvedRun = result.run;
    workflowName = result.workflowName;
    workflowId = result.workflowId;
  } catch (error) {
    if (error instanceof NestedRunPendingError) {
      return {
        ok: false,
        code: "workflow_resume_failed",
        message: await nestedPendingRefusalForClient(
          error,
          request.canReadWorkflow,
        ),
      };
    }
    return {
      ok: false,
      code: lostRace(request, error)
        ? RUN_NOT_SUSPENDED_CODE
        : "workflow_resume_failed",
      message: sanitizeErrorForClient(error),
    };
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
      resourceName: workflowName,
      resourceId: workflowId,
      buffer,
      controller: runController,
      startedAt,
      completion,
      principalId: request.principalId,
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
    try {
      // The root covers the resume and its terminal frame; its flush is the
      // post-resume push. The cleanup and the parent's auto-resume run after
      // it ends, so that resume opens a root of its own (swamp-club#3035).
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

            // Held to the principal that triggered the run, never the
            // approver or resumer (swamp-club#2676).
            const vaultScope = resumeRunVaultScope(
              runVaultScopeContext(ctx),
              resolvedRun,
            );
            const doResume = async () => {
              for await (
                const event of runGeneratorWithVaultAccess(
                  vaultScope?.access,
                  () =>
                    service.resume(workflowName, resolvedRun.id, {
                      signal: runController.signal,
                      inputs: request.inputs ?? {},
                      fromStep: request.from,
                      suspendedOnly: request.suspendedOnly,
                      instanceId: ctx.instanceId,
                      continuation: request.continuation,
                    }),
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
            } else if (error instanceof NestedRunPendingError) {
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
            buffer.finish(terminal);
          }
        },
      );
    } catch (error) {
      // The resume answers its own errors, so only a root that could not
      // open lands here before the terminal frame was sent.
      if (!buffer.finished) {
        terminal = {
          kind: "error",
          code: "workflow_resume_failed",
          message: sanitizeErrorForClient(error),
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

  return { ok: true, runId, buffer };
}

/** The outcome of an approval, as reported by `workflowApprove`. */
export interface ApprovalOutcome {
  workflowName: string;
  runId: string;
  decidedBy: string;
  allGatesDecided: boolean;
}

/**
 * Resumes a run in the background once an approval has decided its last
 * gate, when the workflow's auto-resume policy allows it. Returns whether a
 * resume was launched.
 *
 * The run is addressed by the workflow name and run id that the approval
 * resolved, never by the caller's request fields. It is charged to the
 * approver's principal. A refused launch or a failed resume is logged and
 * audited, since no client is listening to this run. A refused launch leaves
 * the run as it was; the logged message says what to do next, such as the
 * cancel command when the workflow changed shape since the run.
 */
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

/**
 * Resumes the parent of a nested workflow's run that has finished, when the
 * parent still waits on it and nothing else (swamp-club#2736). Returns
 * whether a resume was launched.
 *
 * A parent this instance still drives (draining its other steps, or just
 * suspended again by a resume) is awaited first, so the wakeup is not lost.
 * The parent is then read again and resumed only when it is suspended, has
 * no step still running, no gate of its own waiting and every nested run it
 * waits on finished, its workflow's auto-resume policy is on, and the
 * subject still holds `grant` on the parent workflow, decided against its
 * current token record: `approve` after an approval, `signal` after a
 * signal. That is the grant the child's own continuation relied on: the
 * resume follows a decision rather than being a new run. A parent that
 * waits for a signal of its own continues only once every such wait has an
 * outcome. A skip is audited; nothing is written.
 */
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
  // Saved suspended while other steps still ran: another process may still
  // drive it.
  if (parent.jobs.some((j) => j.steps.some((s) => s.status === "running"))) {
    return skip("parent_steps_running");
  }
  if (parent.findWaitingApprovalStep() !== undefined) return false;
  // A wait for a signal with no outcome yet keeps the parent waiting.
  for (const ref of parent.findSignalWaits()) {
    if (!ref.wait) return false;
    if ((await outcomesOf(ctx).findOutcome(ref.wait.id)).kind !== "found") {
      return false;
    }
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
    !(await decideSubjectAccess(ctx, subject, grant, resolution.resource))
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

/** The wait outcomes of this server's datastore; none where it holds no waits. */
function outcomesOf(
  ctx: ConnectionContext,
): Pick<SignalWaitStore, "findOutcome"> {
  const support = ctx.repoContext.signalWaits;
  return support?.supported
    ? support.store
    : { findOutcome: () => Promise.resolve({ kind: "absent" }) };
}

/** What made serve try to continue a run by itself. */
export interface ContinuationCause {
  /** A signal this instance just accepted, or a pass of the sweep. */
  readonly kind: "signal" | "sweep";
  /** Principal charged against the registry's per-principal cap. */
  readonly principalId: string | null;
  /**
   * The signaller. When the run is a nested workflow's run, its parent is
   * continued for this subject once the run ends, if it still holds `signal`
   * on the parent workflow.
   */
  readonly subject?: DecisionSubject;
  /**
   * Replace the claim of a holder known to be dead. Set only where this
   * instance's copy of the run is known to be current.
   */
  readonly takeover: boolean;
}

/**
 * The last skip audited for each run, per serve process: a run the sweep
 * cannot launch is tried on every pass, and is audited once per suspension
 * and reason.
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
 * The resumes of one suspension that failed and left the run suspended, per
 * serve process. Such a run is still settled, so every pass would launch it
 * again; each failure doubles the wait before the next attempt instead.
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

/** The wait after the first failed resume of a suspension; doubled each time. */
export const CONTINUATION_BACKOFF_BASE_MS = 30_000;
/** The longest wait between two resumes of one suspension. */
export const CONTINUATION_BACKOFF_MAX_MS = 900_000;

function failedContinuationsOf(key: object): Map<string, FailedContinuation> {
  let failed = failedContinuations.get(key);
  if (!failed) {
    failed = new Map();
    failedContinuations.set(key, failed);
  }
  return failed;
}

/**
 * When the next resume of `runId` may be launched by `registry`'s instance,
 * in epoch milliseconds, or undefined for a run not held back.
 */
export function continuationRetryAt(
  registry: ActiveRunRegistry,
  runId: string,
): number | undefined {
  return failedContinuations.get(registry)?.get(runId)?.retryAt;
}

/** How old a local command's claim is before serve reports it as left behind. */
const LOCAL_CLAIM_GRACE_MS = 60_000;

/**
 * Refusals that mean the run is already being resumed, by another holder or
 * by this instance: nothing to report.
 */
const BENIGN_REFUSALS: ReadonlySet<string> = new Set([
  CONTINUATION_HELD_CODE,
  RUN_NOT_SUSPENDED_CODE,
  "already_registered",
  "reserved",
]);

/**
 * Says so when a run the sweep continued has ended and its parent still
 * waits on it. The sweep has no signaller to authorize the parent's resume
 * with, so the parent stays suspended until someone resumes it. Returns
 * whether there was such a parent to name.
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

/**
 * Continues a suspended run that needs no further decision, when its
 * workflow's auto-resume policy allows (swamp-club#3108): every gate is
 * decided, no step waits on a nested run, and every wait for a signal has an
 * outcome. Returns whether a resume was launched.
 *
 * Nothing is authorized here. The stored outcome is the authorization, as
 * an approval is for its own auto-resume: whoever settled the run's last
 * wait was allowed to. A run another holder has claimed or resumed is left
 * alone without a word, since that is the ordinary state of a copy of the
 * run that is behind; the one exception is a claim a local command left on
 * a run this instance knows is still suspended, which only a manual resume
 * clears. Any other skip or refusal leaves the run suspended and is
 * logged and audited once per suspension and reason; the next pass of the
 * sweep tries again. A resume that was launched and failed, leaving the run
 * suspended, is tried again only after a backoff that doubles with each
 * failure of that suspension, from {@link CONTINUATION_BACKOFF_BASE_MS} up
 * to {@link CONTINUATION_BACKOFF_MAX_MS}.
 */
export async function continueSettledRun(
  ctx: ConnectionContext,
  target: { workflowId: string; runId: string },
  cause: ContinuationCause,
  now: () => number = Date.now,
): Promise<boolean> {
  const registry = ctx.activeRunRegistry;
  if (!registry || registry.draining) return false;
  // Already driven by this instance.
  if (registry.get(target.runId)) return false;

  const workflowRepo = ctx.repoContext.workflowRepo;
  const run = await ctx.repoContext.workflowRunRepo.findById(
    createWorkflowId(target.workflowId),
    createWorkflowRunId(target.runId),
  );
  if (!run) return false;
  const verdict = await decideContinuation(run, outcomesOf(ctx));
  if (verdict.kind !== "resumable") return false;

  const suspensionKey = await suspensionKeyOf(run);
  const detail =
    `workflow=${run.workflowName} run=${run.id} cause=${cause.kind}`;
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

  const resolution = await resolveRecordedWorkflow(
    workflowRepo,
    run.workflowId,
    run.workflowName,
  );
  if (resolution.status !== "found") {
    return skip("skipped", "workflow_not_found");
  }
  const workflow = await workflowRepo.findById(createWorkflowId(resolution.id));
  if (!workflow || workflow.name !== resolution.name) {
    return skip("skipped", "workflow_not_found");
  }
  // Not reported: with auto-resume off, a settled run left suspended is
  // what its owner asked for, as it is after an approval.
  if (!workflow.shouldAutoResume(ctx.serveOptions?.autoResume ?? false)) {
    return false;
  }

  // A resume of this suspension failed here before: wait out its backoff.
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
      const held = await claims.store.find(run.id, suspensionKey);
      if (held && held.holder !== claims.holder) {
        // A local command's claim on a run this instance knows is still
        // suspended, long after the command would have saved it: the
        // command died first, and only a manual resume replaces its claim.
        if (
          cause.takeover && serveInstanceOf(held.holder) === undefined &&
          Date.now() - new Date(held.claimedAt).getTime() >
            LOCAL_CLAIM_GRACE_MS
        ) {
          logger.info(
            "Run {runId} is claimed by a local command that never started it. Resume it with: swamp workflow resume {workflow} --run {runId}",
            { runId: run.id, workflow: run.workflowName },
          );
          return skip("skipped", "held_by_local_command");
        }
        const liveness = await claims.liveness(held.holder);
        if (liveness !== "dead" || !cause.takeover) return false;
      }
    }
  } catch (error) {
    logger.debug("Continuation claims of run {runId} are unreadable: {error}", {
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return skip("failed", "claim_store_unavailable");
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
    lostRaceIsOrdinary: true,
    onTerminal: async (terminal) => {
      if (terminal.kind !== "error") {
        memo.delete(run.id);
        failed.delete(run.id);
        if (cause.subject === undefined) await noteParkedParent(ctx, run);
        return;
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

  // The memo is kept until the resume ends well: one that fails and leaves
  // the run suspended is launched again after its backoff, and the launch
  // and its failure are each reported once.
  if (failures === 0) emitSystemAuditEvent(ctx, "workflow.auto_resume", detail);
  return true;
}
