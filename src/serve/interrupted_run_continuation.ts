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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  type AutoContinuationVerdict,
  decideAutoContinuation,
} from "../domain/workflows/auto_continuation.ts";
import {
  acquireContinuation,
  type ContinuationClaim,
  serveHolder,
  suspensionKeyOf,
} from "../domain/workflows/continuation_claim.ts";
import { assertNestedWaitsSettled } from "../domain/workflows/nested_run_link.ts";
import { getWorkerPoolReader } from "../domain/remote/worker_pool.ts";
import type { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import type { WorkflowId } from "../domain/workflows/workflow_id.ts";
import { UserError } from "../domain/errors.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { withSharedSyncGate } from "./sync_gate.ts";
import {
  type ConnectionContext,
  emitSystemAuditEvent,
  pushChangedToRemote,
} from "./handlers/shared.ts";
import {
  CONTINUATION_HELD_CODE,
  RUN_NOT_SUSPENDED_CODE,
  RUN_RECORD_STALE_CODE,
  serveMayActOnRun,
  startDetachedResume,
} from "./resume_launcher.ts";

const logger = getSwampLogger(["serve", "continue"]);

/** another process got there first: not a failure of this one */
const LOST_RACE_CODES = new Set([
  CONTINUATION_HELD_CODE,
  RUN_RECORD_STALE_CODE,
  RUN_NOT_SUSPENDED_CODE,
  "already_registered",
]);

const INTERRUPTED_RECORD_CLAIM = {
  kind: "automatic",
  takeover: false,
} as const;

export type InterruptedRunContinuationCause =
  | "boot"
  | "reconciliation"
  | "lead";

export interface InterruptedRunContinuationOptions {
  /** limits the pass to these runs; every interrupted run when absent */
  readonly runIds?: ReadonlySet<string>;
  /** a continued scheduled run, so the next fire of its workflow overlaps */
  readonly onScheduledRunContinued?: (
    workflowId: string,
    runId: string,
    completion: Promise<void>,
  ) => void;
}

export interface InterruptedRunContinuationResult {
  readonly continued: readonly string[];
  readonly refused: readonly {
    readonly runId: string;
    readonly workflowName: string;
    readonly reason: string;
    readonly message: string;
  }[];
}

function holderOf(ctx: ConnectionContext): string {
  return ctx.repoContext.continuationClaims?.holder ??
    serveHolder(ctx.instanceId ?? "unknown");
}

/**
 * continues every interrupted run serve stamped whose verdict allows it, and
 * records each refusal once per interruption
 */
export async function continueInterruptedRuns(
  ctx: ConnectionContext,
  cause: InterruptedRunContinuationCause,
  options: InterruptedRunContinuationOptions = {},
): Promise<InterruptedRunContinuationResult> {
  const continued: string[] = [];
  const refused: InterruptedRunContinuationResult["refused"][number][] = [];
  const registry = ctx.activeRunRegistry;
  if (!registry || registry.draining) return { continued, refused };

  const candidates = await ctx.repoContext.workflowRunRepo.findGlobalByStatus(
    "interrupted",
  );
  for (const { run, workflowId } of candidates) {
    if (options.runIds !== undefined && !options.runIds.has(run.id)) continue;
    if (run.continuableSince === undefined) continue;
    if (registry.draining) break;
    if (registry.get(run.id)) continue;
    if (!serveMayActOnRun(ctx, run)) continue;
    try {
      const verdict = await verdictFor(ctx, run, workflowId);
      if (verdict.kind === "ineligible") continue;
      if (verdict.kind === "refuse") {
        const recorded = await recordRefusal(ctx, run, workflowId, verdict);
        if (recorded) {
          refused.push({
            runId: run.id,
            workflowName: run.workflowName,
            reason: verdict.refusal.reason,
            message: verdict.refusal.message,
          });
          emitSystemAuditEvent(
            ctx,
            "workflow.auto_continue_refused",
            `workflow=${run.workflowName} run=${run.id} cause=${cause} reason=${verdict.refusal.reason}${
              verdict.refusal.steps.length > 0
                ? ` step=${verdict.refusal.steps.join(",")}`
                : ""
            }`,
          );
        }
        continue;
      }
      if (await launch(ctx, run, workflowId, cause, options)) {
        continued.push(run.id);
      }
    } catch (error) {
      logger.warn(
        "Run {runId} of workflow {workflow} could not be judged for automatic continuation: {error}",
        {
          runId: run.id,
          workflow: run.workflowName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
  return { continued, refused };
}

async function verdictFor(
  ctx: ConnectionContext,
  run: WorkflowRun,
  workflowId: WorkflowId,
): Promise<AutoContinuationVerdict> {
  const workflowRepo = ctx.repoContext.workflowRepo;
  const workflow = await workflowRepo.findById(workflowId);
  return await decideAutoContinuation(
    workflow?.name === run.workflowName ? workflow : null,
    run,
    {
      fanOutPoolAvailable: getWorkerPoolReader() !== null,
      nestedRunUnsettled: async (subject) => {
        try {
          await assertNestedWaitsSettled({
            runRepo: ctx.repoContext.workflowRunRepo,
            workflowRepo,
            signalWaits: ctx.repoContext.signalWaits,
          }, subject);
          return undefined;
        } catch (error) {
          if (error instanceof UserError) return error.message;
          throw error;
        }
      },
    },
  );
}

interface InterruptedRecordHold {
  release(): Promise<void>;
}

/**
 * the claim the automatic recover takes, held on a current copy, so only one
 * process acts on an interruption; null when a peer holds it or got there first
 */
async function holdInterruptedRecord(
  ctx: ConnectionContext,
  run: WorkflowRun,
  workflowId: WorkflowId,
): Promise<InterruptedRecordHold | null> {
  const claims = ctx.repoContext.continuationClaims;
  let claim: ContinuationClaim | undefined;
  if (claims !== undefined && (!claims.usable || await claims.usable())) {
    // never taken over: a serve without heartbeats reads every peer dead, and
    // a holder that died before its reset leaves the run to the operator
    const acquired = await acquireContinuation(
      claims,
      { runId: run.id, suspensionKey: await suspensionKeyOf(run) },
      INTERRUPTED_RECORD_CLAIM,
      new Date(),
    );
    if (acquired.kind !== "acquired") return null;
    claim = acquired.claim;
  }
  const hold: InterruptedRecordHold = {
    release: async () => {
      if (claim !== undefined) await claims!.store.release(claim);
    },
  };
  const currency = ctx.repoContext.runRecordCurrency;
  if (currency && !(await currency({ workflowId, runId: run.id }))) {
    await hold.release();
    return null;
  }
  return hold;
}

/** never lands over an operator's recover of the same run */
async function recordRefusal(
  ctx: ConnectionContext,
  run: WorkflowRun,
  workflowId: WorkflowId,
  verdict: Extract<AutoContinuationVerdict, { kind: "refuse" }>,
): Promise<boolean> {
  if (run.carriesAutoContinuationRefusal(verdict.refusal.reason)) return false;
  const hold = await holdInterruptedRecord(ctx, run, workflowId);
  if (hold === null) return false;
  try {
    if (!run.recordAutoContinuationRefusal(verdict.refusal, new Date())) {
      return false;
    }
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
                    "Pushing the refused continuation of run {runId} failed: {error}",
                    { runId: run.id, error },
                  ),
              }),
          ),
      },
      () => ctx.repoContext.workflowRunRepo.save(workflowId, run),
    );
    logger.warn(
      "Run {runId} of workflow {workflow} stays interrupted: {message}",
      {
        runId: run.id,
        workflow: run.workflowName,
        message: verdict.refusal.message,
      },
    );
    return true;
  } finally {
    // the refusal changes no step, so the key stays and a kept claim would
    // hold off a peer judging the same interruption later
    await hold.release();
  }
}

async function launch(
  ctx: ConnectionContext,
  run: WorkflowRun,
  workflowId: WorkflowId,
  cause: InterruptedRunContinuationCause,
  options: InterruptedRunContinuationOptions,
): Promise<boolean> {
  const registry = ctx.activeRunRegistry!;
  // kept for the recover, which takes it again as its own holder and keeps it
  const hold = await holdInterruptedRecord(ctx, run, workflowId);
  if (hold === null) return false;
  const detail =
    `workflow=${run.workflowName} run=${run.id} cause=${cause} interrupted=${
      run.tags["interrupt_reason"] ?? "unknown"
    }`;
  const launched = await startDetachedResume(ctx, registry, {
    workflowIdOrName: workflowId,
    byId: true,
    expectedName: run.workflowName,
    runId: run.id,
    recoverInterrupted: { holder: holderOf(ctx) },
    principalId: null,
    continuation: INTERRUPTED_RECORD_CLAIM,
    requireCurrentRecord: true,
    lostRaceIsOrdinary: true,
    onTerminal: async (terminal) => {
      // a lost race shares its claim with the pass that won, which keeps it
      if (terminal.kind === "error" && !LOST_RACE_CODES.has(terminal.code)) {
        await hold.release();
        emitSystemAuditEvent(
          ctx,
          "workflow.auto_continue_failed",
          `${detail} code=${terminal.code}`,
        );
      }
    },
  });
  if (!launched.ok) {
    if (!LOST_RACE_CODES.has(launched.code)) {
      await hold.release();
      emitSystemAuditEvent(
        ctx,
        "workflow.auto_continue_failed",
        `${detail} code=${launched.code}`,
      );
      logger.warn(
        "Run {runId} of workflow {workflow} could not be continued: {message}",
        {
          runId: run.id,
          workflow: run.workflowName,
          message: launched.message,
        },
      );
    }
    return false;
  }
  emitSystemAuditEvent(ctx, "workflow.auto_continue", detail);
  logger.info(
    "Run {runId} of workflow {workflow}, interrupted by {reason}, is continued automatically",
    {
      runId: run.id,
      workflow: run.workflowName,
      reason: run.tags["interrupt_reason"] ?? "unknown",
    },
  );
  const completion = registry.get(run.id)?.completion;
  if (run.triggerSource === "schedule" && completion !== undefined) {
    options.onScheduledRunContinued?.(workflowId, run.id, completion);
  }
  return true;
}
