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

import { mapWorkflowExecutionEvent } from "../libswamp/mod.ts";
import { createStepLockHook, createWorkflowRunDeps } from "./deps.ts";
import { withSharedSyncGate } from "./sync_gate.ts";
import { serializeEvent } from "./serializer.ts";
import { resolveResumableRun } from "../domain/workflows/suspended_run_resolver.ts";
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
import { LockTimeoutError } from "../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";

const logger = getSwampLogger(["serve", "resume"]);
const DEFAULT_BUFFER_CAPACITY = 10_000;

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
      code: "workflow_resume_failed",
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

            const doResume = async () => {
              for await (
                const event of service.resume(workflowName, resolvedRun.id, {
                  signal: runController.signal,
                  inputs: request.inputs ?? {},
                  fromStep: request.from,
                  suspendedOnly: request.suspendedOnly,
                  instanceId: ctx.instanceId,
                })
              ) {
                const mapped = mapWorkflowExecutionEvent(event, runRepo);
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
                code: "workflow_resume_failed",
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
    onTerminal: (terminal) => {
      if (terminal.kind !== "error") return;
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
 * subject still holds the approve grant on the parent workflow, decided
 * against its current token record. That is the grant an approval's
 * auto-resume relies on: the resume follows a decision rather than being a
 * new run. A skip is audited; nothing is written.
 */
export async function autoResumeParentAfterChild(
  ctx: ConnectionContext,
  child: { workflowId: string; runId: string },
  subject: DecisionSubject,
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
    !(await decideSubjectAccess(ctx, subject, "approve", resolution.resource))
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
    onTerminal: (terminal) => {
      if (terminal.kind !== "error") return;
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
