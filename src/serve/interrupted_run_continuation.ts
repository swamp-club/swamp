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
  refusalIsRetried,
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
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
} from "../domain/workflows/workflow_id.ts";
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
  | "lead"
  | "sweep";

export interface InterruptedRunTarget {
  readonly workflowId: string;
  readonly runId: string;
}

export interface ContinuedScheduledRun extends InterruptedRunTarget {
  readonly workflowName: string;
}

export interface InterruptedRunContinuationOptions {
  /** read by id; every interrupted run is scanned when absent */
  readonly targets?: readonly InterruptedRunTarget[];
  /** a continuation that failed after its launch, to judge again later */
  readonly onDeferredLater?: (target: InterruptedRunTarget) => void;
  /** a continued scheduled run, so the next fire of its workflow overlaps */
  readonly onScheduledRunContinued?: (
    run: ContinuedScheduledRun,
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
  /** judged again later: a peer or a nested run may still settle them */
  readonly deferred: readonly InterruptedRunTarget[];
}

type LaunchOutcome =
  | { readonly kind: "continued" | "deferred" | "settled" }
  | { readonly kind: "refused"; readonly message: string };

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
  const deferred: InterruptedRunTarget[] = [];
  const registry = ctx.activeRunRegistry;
  if (!registry || registry.draining) return { continued, refused, deferred };

  const candidates = await candidatesOf(ctx, options.targets);
  for (const { run, workflowId } of candidates) {
    if (run.continuableSince === undefined) continue;
    if (registry.draining) break;
    if (registry.get(run.id)) continue;
    if (!serveMayActOnRun(ctx, run)) continue;
    const target = { workflowId, runId: run.id };
    try {
      const verdict = await verdictFor(ctx, run, workflowId);
      if (verdict.kind === "ineligible") continue;
      if (verdict.kind === "refuse") {
        const recorded = await recordRefusal(ctx, run, workflowId, verdict);
        if (recorded === "busy" || refusalIsRetried(verdict.refusal.reason)) {
          deferred.push(target);
        }
        if (recorded === "recorded") {
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
      const outcome = await launch(ctx, run, workflowId, cause, options);
      if (outcome.kind === "continued") continued.push(run.id);
      if (outcome.kind === "deferred") deferred.push(target);
      if (outcome.kind === "refused") {
        refused.push({
          runId: run.id,
          workflowName: run.workflowName,
          reason: "launch_refused",
          message: outcome.message,
        });
      }
    } catch (error) {
      deferred.push(target);
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
  return { continued, refused, deferred };
}

async function candidatesOf(
  ctx: ConnectionContext,
  targets: readonly InterruptedRunTarget[] | undefined,
): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
  const repo = ctx.repoContext.workflowRunRepo;
  if (targets === undefined) {
    return await repo.findGlobalByStatus("interrupted");
  }
  const found: { run: WorkflowRun; workflowId: WorkflowId }[] = [];
  for (const target of targets) {
    const workflowId = createWorkflowId(target.workflowId);
    const run = await repo.findById(
      workflowId,
      createWorkflowRunId(target.runId),
    );
    if (run?.status === "interrupted") found.push({ run, workflowId });
  }
  return found;
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

const warnedClaims = new Set<string>();
const WARNED_CLAIMS_MAX = 10_000;

/** once per claim: a holder gone before its reset leaves the run to an operator */
function warnHeldClaim(run: WorkflowRun, claim: ContinuationClaim): void {
  const key = `${claim.runId}:${claim.suspensionKey}:${claim.generation}`;
  if (warnedClaims.has(key)) return;
  if (warnedClaims.size >= WARNED_CLAIMS_MAX) warnedClaims.clear();
  warnedClaims.add(key);
  logger.warn(
    "Run {runId} of workflow {workflow} stays interrupted while {holder} holds its continuation; if that serve is no longer running, recover it with 'swamp workflow recover {workflow} --run {runId}'",
    { runId: run.id, workflow: run.workflowName, holder: claim.holder },
  );
}

interface InterruptedRecordHold {
  release(): Promise<void>;
}

type HoldAttempt =
  | { readonly kind: "held"; readonly hold: InterruptedRecordHold }
  /** a live peer holds it or the copy is behind: judged again later */
  | { readonly kind: "busy" }
  /** a holder not known alive: left to the operator, who is told once */
  | { readonly kind: "orphaned" };

/**
 * the claim the automatic recover takes, held on a current copy, so only one
 * process acts on an interruption
 */
async function holdInterruptedRecord(
  ctx: ConnectionContext,
  run: WorkflowRun,
  workflowId: WorkflowId,
): Promise<HoldAttempt> {
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
    if (acquired.kind !== "acquired") {
      if (acquired.liveness === "alive") return { kind: "busy" };
      warnHeldClaim(run, acquired.claim);
      return { kind: "orphaned" };
    }
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
    return { kind: "busy" };
  }
  return { kind: "held", hold };
}

/** never lands over an operator's recover of the same run */
async function recordRefusal(
  ctx: ConnectionContext,
  run: WorkflowRun,
  workflowId: WorkflowId,
  verdict: Extract<AutoContinuationVerdict, { kind: "refuse" }>,
): Promise<"recorded" | "skipped" | "busy"> {
  if (run.carriesAutoContinuationRefusal(verdict.refusal.reason)) {
    return "skipped";
  }
  const attempt = await holdInterruptedRecord(ctx, run, workflowId);
  if (attempt.kind === "busy") return "busy";
  if (attempt.kind === "orphaned") return "skipped";
  const hold = attempt.hold;
  try {
    // read again under the claim: an operator's recover takes no claim, so a
    // copy read before it would write the interruption back over that run
    const fresh = await ctx.repoContext.workflowRunRepo.findById(
      workflowId,
      createWorkflowRunId(run.id),
    );
    if (
      fresh?.status !== "interrupted" ||
      fresh.continuableSince?.getTime() !== run.continuableSince?.getTime() ||
      !fresh.recordAutoContinuationRefusal(verdict.refusal, new Date())
    ) {
      return "skipped";
    }
    run = fresh;
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
      "Run {runId} of workflow {workflow} stays interrupted ({reason}): {message}",
      {
        runId: run.id,
        workflow: run.workflowName,
        reason: verdict.refusal.reason,
        message: verdict.refusal.message,
      },
    );
    return "recorded";
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
): Promise<LaunchOutcome> {
  const registry = ctx.activeRunRegistry!;
  // kept for the recover, which takes it again as its own holder and keeps it
  const attempt = await holdInterruptedRecord(ctx, run, workflowId);
  if (attempt.kind === "busy") return { kind: "deferred" };
  if (attempt.kind === "orphaned") return { kind: "settled" };
  const hold = attempt.hold;
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
        // judged again, so a refusal such as an edited definition is recorded
        options.onDeferredLater?.({ workflowId, runId: run.id });
        if (firstFailureOf(run)) {
          emitSystemAuditEvent(
            ctx,
            "workflow.auto_continue_failed",
            `${detail} code=${terminal.code}`,
          );
        }
      }
    },
  });
  if (!launched.ok) {
    // a lost race shares its claim with the pass that won, which keeps it
    if (LOST_RACE_CODES.has(launched.code)) return { kind: "settled" };
    if (launched.refusal === "refused") {
      // a definite answer stands for this interruption, like a verdict's
      await hold.release();
      const message =
        `${launched.message}. Decide with 'swamp workflow recover ${run.workflowName} --run ${run.id}'.`;
      const recorded = await recordRefusal(ctx, run, workflowId, {
        kind: "refuse",
        refusal: { reason: "launch_refused", steps: [], message },
      });
      if (recorded === "busy") return { kind: "deferred" };
      if (recorded === "skipped") return { kind: "settled" };
      emitSystemAuditEvent(
        ctx,
        "workflow.auto_continue_refused",
        `${detail} reason=launch_refused`,
      );
      return { kind: "refused", message };
    }
    // a fault, such as a full registry: tried again later, reported once
    await hold.release();
    if (firstFailureOf(run)) {
      emitSystemAuditEvent(
        ctx,
        "workflow.auto_continue_failed",
        `${detail} code=${launched.code}`,
      );
      logger.warn(
        "Run {runId} of workflow {workflow} could not be continued yet: {message}",
        {
          runId: run.id,
          workflow: run.workflowName,
          message: launched.message,
        },
      );
    }
    return { kind: "deferred" };
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
    options.onScheduledRunContinued?.(
      { workflowId, runId: run.id, workflowName: run.workflowName },
      completion,
    );
  }
  return { kind: "continued" };
}

const reportedFailures = new Set<string>();
const REPORTED_FAILURES_MAX = 10_000;

/** a failure is reported once per interruption, however often it is retried */
function firstFailureOf(run: WorkflowRun): boolean {
  const key = `${run.id}:${run.continuableSince?.toISOString() ?? ""}`;
  if (reportedFailures.has(key)) return false;
  if (reportedFailures.size >= REPORTED_FAILURES_MAX) reportedFailures.clear();
  reportedFailures.add(key);
  return true;
}
