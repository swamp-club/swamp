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
import { isCustomDatastoreConfig } from "../domain/datastore/datastore_config.ts";
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
  emitSystemAuditEvent,
  lockTimeoutErrorForClient,
  sanitizeErrorForClient,
} from "./handlers/shared.ts";
import { LockTimeoutError } from "../domain/datastore/distributed_lock.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "resume"]);
const DEFAULT_BUFFER_CAPACITY = 10_000;

export interface DetachedResumeRequest {
  /** Workflow id or name, resolved the same way as `workflow resume`. */
  workflowIdOrName: string;
  runId?: string;
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
  /** Called once the run ends, with the same terminal pushed to the buffer. */
  onTerminal?: (terminal: BufferTerminal) => void;
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
  try {
    const result = await resolveResumableRun(
      workflowRepo,
      runRepo,
      request.workflowIdOrName,
      request.runId,
      { fromStep: request.from, suspendedOnly: request.suspendedOnly },
    );
    resolvedRun = result.run;
    workflowName = result.workflowName;
  } catch (error) {
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
      resourceName: request.workflowIdOrName,
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

    let ephemeral: ReturnType<typeof createEphemeralStore> | null = null;
    let terminal: BufferTerminal = { kind: "done" };
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
      } else {
        terminal = {
          kind: "error",
          code: "workflow_resume_failed",
          message: sanitizeErrorForClient(error),
        };
      }
    } finally {
      buffer.finish(terminal);
      if (ctx.syncService) {
        const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
          ? ctx.datastoreConfig.namespace
          : undefined;
        const syncService = ctx.syncService;
        try {
          await withSharedSyncGate(
            ctx.syncGate,
            () => syncService.pushChanged({ namespace }),
          );
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
        request.onTerminal?.(terminal);
      } catch (callbackErr) {
        logger.warn("Resume terminal callback failed: {error}", {
          error: callbackErr instanceof Error
            ? callbackErr.message
            : String(callbackErr),
        });
      }
    }
  })().catch((err) => {
    logger.warn("Unhandled error in detached workflow resume: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (ctx.controlPlaneStore && ctx.instanceId) {
    writeActiveRun(ctx.controlPlaneStore, ctx.instanceId, runId, {
      resourceName: request.workflowIdOrName,
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
    onTerminal: (terminal) => {
      if (terminal.kind !== "error") return;
      logger.warn(
        "Auto-resume of run {runId} failed ({code}): {message}",
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
      "Auto-resume of run {runId} was not started ({code}): {message}",
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
