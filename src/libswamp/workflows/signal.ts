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
import type {
  StepRun,
  WorkflowRun,
} from "../../domain/workflows/workflow_run.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowRunClaims } from "../../domain/workflows/run_claim.ts";
import type { SignalReceipt } from "../../domain/workflows/signal_wait.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { withUnitOfWork } from "../unit_of_work.ts";

export interface WorkflowSignalData {
  waitId: string;
  workflowId: string;
  workflowName: string;
  runId: string;
  jobName: string;
  stepName: string;
  /** What swamp recorded about the signal. */
  signal: SignalReceipt;
  /**
   * True when this signal settled the run's last wait and no gate or nested
   * run is still waited on, so the run can be resumed.
   */
  awaitingResume: boolean;
  /** The command that resumes the run. */
  resumeCommand: string;
}

export type WorkflowSignalEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: WorkflowSignalData }
  | { kind: "error"; error: SwampError };

export interface WorkflowSignalInput {
  /** The wait the signal is for. A signal names the wait and nothing else. */
  waitId: string;
  /** The message. Untrusted: it is validated before anything is stored. */
  payload: unknown;
  /** Who sent it. Defaults to the OS user, as a local approval's decider. */
  submittedBy?: string;
}

export interface WorkflowSignalDeps {
  runRepo: Pick<
    WorkflowRunRepository,
    "findById" | "findGlobalByStatus" | "findAllGlobal" | "save"
  >;
  /**
   * Claims the run for the signal, so it is delivered to the run as stored
   * and no other writer saves over it.
   */
  runClaims: WorkflowRunClaims;
  /** The time the deadline is compared against. Defaults to the current time. */
  now?: () => Date;
  /**
   * Whether the process that was running a run is gone. A run it left
   * suspended with a step still `running` will never finish that step, so
   * the signal is delivered instead of refused as not ready. Without it such
   * a run is always refused.
   */
  ownerIsDead?: (run: WorkflowRun) => boolean;
  /**
   * Whether the process that suspended a run is still running the level the
   * wait is in. It saves the record from memory until that level drains,
   * and would save over a signal delivered before then, so the signal is
   * refused as not ready. Without it only a step recorded `running` shows
   * the level has not drained.
   */
  ownerIsRunning?: (run: WorkflowRun) => boolean;
}

export function createWorkflowSignalDeps(
  runRepo: WorkflowSignalDeps["runRepo"],
  runClaims: WorkflowRunClaims,
  ownerIsDead?: (run: WorkflowRun) => boolean,
  ownerIsRunning?: (run: WorkflowRun) => boolean,
): WorkflowSignalDeps {
  return { runRepo, runClaims, ownerIsDead, ownerIsRunning };
}

/** The step of `run` that holds the wait, in any status. */
function findStepByWaitId(
  run: WorkflowRun,
  waitId: string,
): { jobName: string; step: StepRun } | undefined {
  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (step.signalWait?.id.toLowerCase() === waitId) {
        return { jobName: job.jobName, step };
      }
    }
  }
  return undefined;
}

/**
 * Finds the run that holds the wait. Suspended runs are searched first, as
 * an open wait lives in one. Every run is searched only when none of them
 * holds it, to tell a wait that settled, timed out or has not suspended yet
 * from an id nothing ever issued.
 */
async function locateRun(
  deps: WorkflowSignalDeps,
  waitId: string,
): Promise<{ runId: string; workflowId: WorkflowId } | undefined> {
  for (
    const { run, workflowId } of await deps.runRepo.findGlobalByStatus(
      "suspended",
    )
  ) {
    if (findStepByWaitId(run, waitId)) return { runId: run.id, workflowId };
  }
  for (const { run, workflowId } of await deps.runRepo.findAllGlobal()) {
    if (findStepByWaitId(run, waitId)) return { runId: run.id, workflowId };
  }
  return undefined;
}

function resumeCommandFor(run: WorkflowRun): string {
  return `swamp workflow resume ${
    quoteShellWord(run.workflowName)
  } --run ${run.id}`;
}

function unknownWait(waitId: string): SwampError {
  return notFound("Signal wait", waitId);
}

/**
 * Delivers the signal to the run as read now. The caller holds the run's
 * claim, so nothing saves between this read and this save.
 */
async function signalClaimedRun(
  deps: WorkflowSignalDeps,
  input: WorkflowSignalInput,
  waitId: string,
  located: { runId: string; workflowId: WorkflowId },
): Promise<{ error: SwampError } | { data: WorkflowSignalData }> {
  // Messages name the id as it was typed, so telemetry, which redacts the
  // typed argument, removes it from them.
  const typedId = input.waitId;
  const run = await deps.runRepo.findById(
    located.workflowId,
    createWorkflowRunId(located.runId),
  );
  const found = run ? findStepByWaitId(run, waitId) : undefined;
  if (!run || !found) return { error: unknownWait(typedId) };
  const { jobName, step } = found;
  const where =
    `step "${step.stepName}" of workflow "${run.workflowName}" (run ${run.id})`;

  const settled = step.signalWait?.receipt;
  if (settled) {
    return {
      // Who sent it and when stay in the details: the message reaches
      // telemetry, and a username does not belong there.
      error: validationFailed(
        `Wait ${typedId} is already settled: ${where} received signal ${settled.id}.`,
        { receipt: settled },
      ),
    };
  }
  if (!step.isSignalWait) {
    return {
      error: validationFailed(
        `Wait ${typedId} is closed: ${where} is ${step.status}` +
          (step.error ? ` (${step.error})` : "") + ".",
      ),
    };
  }
  // The process running a run saves the record from memory, without the
  // claim, until the level its wait is in has drained, and would save over
  // a signal delivered before then. The record already says suspended by
  // then, and a sibling step still queued is recorded pending, so the
  // owner is asked as well as the step statuses.
  // A process that died mid-level leaves the record suspended with a step
  // `running` for good. Nothing will save over the signal then, so it is
  // delivered; the resume runs the abandoned step again.
  const stepsRunning = run.jobs.some((job) =>
    job.steps.some((s) => s.status === "running")
  );
  if (
    run.status !== "suspended" ||
    (deps.ownerIsRunning?.(run) ?? false) ||
    (stepsRunning && !(deps.ownerIsDead?.(run) ?? false))
  ) {
    return {
      error: validationFailed(
        `Wait ${typedId} is not ready: the run of ${where} has not suspended yet, ` +
          `as other steps are still finishing. Send the signal again shortly. ` +
          `If nothing is running it any more: swamp workflow cancel ${
            quoteShellWord(run.workflowName)
          } --run ${run.id}`,
      ),
    };
  }

  // `||`, not `??`: a receipt needs a sender, and USER can be set but empty.
  const submittedBy = input.submittedBy || Deno.env.get("USER") ||
    Deno.env.get("USERNAME") || "unknown";
  const outcome = step.acceptSignal(
    input.payload,
    submittedBy,
    deps.now?.() ?? new Date(),
  );
  if (!outcome.accepted) {
    const refusal = outcome.refusal;
    switch (refusal.kind) {
      case "expired":
        return {
          error: validationFailed(
            `Wait ${typedId} expired at ${refusal.deadline.toISOString()}: ${where} no longer accepts a signal. ` +
              `Resume the run to fail the step with wait_timeout: ${
                resumeCommandFor(run)
              }`,
          ),
        };
      case "invalid_payload":
        return {
          error: validationFailed(
            `Payload refused for wait ${typedId}; the wait stays open:\n` +
              refusal.errors.map((error) => `  - ${error}`).join("\n"),
            { errors: refusal.errors },
          ),
        };
      case "already_settled":
        return {
          error: validationFailed(
            `Wait ${typedId} is already settled: ${where} received signal ${refusal.receipt.id}.`,
            { receipt: refusal.receipt },
          ),
        };
      case "not_waiting":
        return {
          error: validationFailed(
            `Wait ${typedId} is closed: ${where} is ${step.status}.`,
          ),
        };
    }
  }

  await deps.runRepo.save(createWorkflowId(run.workflowId), run);
  return {
    data: {
      waitId: outcome.receipt.waitId,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      runId: run.id,
      jobName,
      stepName: step.stepName,
      signal: outcome.receipt,
      awaitingResume: run.isAwaitingResume(),
      resumeCommand: resumeCommandFor(run),
    },
  };
}

/**
 * Delivers a JSON message to the wait it names: the step that holds the wait
 * succeeds with the message as its output, and the run can be resumed once
 * nothing else in it waits.
 */
export async function* workflowSignal(
  ctx: LibSwampContext,
  deps: WorkflowSignalDeps,
  input: WorkflowSignalInput,
): AsyncIterable<WorkflowSignalEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.workflow.signal",
      { "wait.id": input.waitId },
      (async function* () {
        yield { kind: "resolving" };

        const waitId = input.waitId.trim().toLowerCase();
        // Located once to learn which run is meant, then read again under
        // that run's claim: only the second read is acted on.
        const located = waitId ? await locateRun(deps, waitId) : undefined;
        if (!located) {
          yield { kind: "error", error: unknownWait(input.waitId) };
          return;
        }

        const outcome = await deps.runClaims.withClaim(
          located.runId,
          () => signalClaimedRun(deps, input, waitId, located),
        );
        if ("error" in outcome) {
          yield { kind: "error", error: outcome.error };
          return;
        }
        yield { kind: "completed", data: outcome.data };
      })(),
    ));
}
