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

import { getLogger } from "@logtape/logtape";
import type { Job } from "./job.ts";
import type { Step } from "./step.ts";
import type { Workflow } from "./workflow.ts";
import {
  CANCELLED_STEP_ERROR,
  type JobRun,
  type StepRun,
  type WorkflowRun,
} from "./workflow_run.ts";
import {
  CyclicDependencyError,
  DuplicateNodeNameError,
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";

/**
 * Settles the work a run's abort or cancellation left unfinished, the same
 * way whether the abort fired during a live walk (ExecutionService) or a
 * cancel reached a stored run that no process drives (workflow cancel,
 * supersede, serve's suspended-run cancel, the stranded-run backstops).
 */

const sortService = new TopologicalSortService();
const logger = getLogger(["swamp", "workflows", "abort-settlement"]);

/**
 * Reads a run's own evaluated workflow snapshot by its id. Injected by the
 * caller, which binds it to the evaluated-workflow repository, so this
 * domain module never imports infrastructure.
 */
export type EvaluatedWorkflowLookup = (
  runId: string,
) => Promise<Workflow | null>;

/**
 * True when every `dependsOn` condition of the job holds against the run.
 */
export function shouldJobRun(job: Job, run: WorkflowRun): boolean {
  // If no dependencies, always run
  if (job.dependsOn.length === 0) {
    return true;
  }

  // Check all dependency conditions
  for (const dep of job.dependsOn) {
    if (!dep.condition.evaluate(run, dep.job)) {
      return false;
    }
  }

  return true;
}

/**
 * True when every `dependsOn` condition of the step holds against its job.
 */
export function shouldStepRun(step: Step, jobRun: JobRun): boolean {
  // If no dependencies, always run
  if (step.dependsOn.length === 0) {
    return true;
  }

  // Check all dependency conditions
  for (const dep of step.dependsOn) {
    if (!dep.condition.evaluate(jobRun, dep.step)) {
      return false;
    }
  }

  return true;
}

/**
 * Fails the job's steps still `running` with `error` (by default
 * {@link CANCELLED_STEP_ERROR}) and reports whether there were any. A level of
 * several steps does not wait for them once the abort fires, so their
 * generators end without recording an outcome.
 */
export function failAbandonedSteps(
  jobRun: JobRun,
  error: string = CANCELLED_STEP_ERROR,
): boolean {
  let failed = false;
  for (const step of jobRun.steps) {
    if (step.status === "running") {
      step.fail(error);
      failed = true;
    }
  }
  return failed;
}

/**
 * Settles a step the run's abort left unstarted as runStep would have on
 * reaching it: skipped when its dependsOn is unmet, otherwise failed as
 * cancelled like an in-flight step. Either way it is marked
 * `settledByAbort`, so a resume runs it. A step with a guard stays pending:
 * its guard never decided whether the step's work was already done, so
 * neither `succeeded`, `failed`, `completed` nor `skipped` may hold for it.
 */
export function settleUnstartedStep(
  step: Step | undefined,
  stepRun: StepRun,
  jobRun: JobRun,
): void {
  if (step && !shouldStepRun(step, jobRun)) {
    stepRun.skipUnstarted({ kind: "dependency" });
  } else if (!step?.guard) {
    jobRun.cancelPendingSteps([stepRun.stepName]);
  }
}

/**
 * Settles the job's pending steps in dependency order, each as
 * {@link settleUnstartedStep} does.
 */
export function settleUnstartedSteps(job: Job, jobRun: JobRun): void {
  const sorted = sortService.sort(
    job.steps.map((step) => ({
      name: step.name,
      weight: step.weight,
      dependencies: step.getDependencyNames(),
    })),
  );
  for (const level of sorted.levels) {
    for (const stepName of level) {
      const stepRun = jobRun.getStep(stepName);
      if (stepRun?.status !== "pending") continue;
      settleUnstartedStep(job.getStep(stepName), stepRun, jobRun);
    }
  }
}

/**
 * Settles a job the run's abort left unstarted: its steps in dependency
 * order, each as {@link settleUnstartedStep} does, then the job from their
 * outcome ({@link JobRun.settleNotStarted}).
 */
export function settleNotStartedJob(job: Job, jobRun: JobRun): void {
  settleUnstartedSteps(job, jobRun);
  jobRun.settleNotStarted();
}

/**
 * Settles a job a resume inherited as running that its abort kept from
 * starting: its pending steps as {@link settleNotStartedJob} does, then the
 * job from its steps' outcome ({@link JobRun.settleNotResumed}).
 */
export function settleNotResumedJob(job: Job, jobRun: JobRun): void {
  settleUnstartedSteps(job, jobRun);
  jobRun.settleNotResumed();
}

/**
 * Picks the definition a cancelled run is settled against: the run's own
 * evaluated snapshot, saved when it started, whose job and step names and
 * `dependsOn` references are the evaluated ones its records were created
 * with, as the live walk uses. Without one (a `--last-evaluated` or older
 * run, a snapshot removed by run gc, or one that cannot be read) it falls
 * back to the repository definition, which may itself be undefined.
 */
export async function resolveSettlementWorkflow(
  run: WorkflowRun,
  repositoryWorkflow: Workflow | undefined,
  findEvaluatedByRunId: EvaluatedWorkflowLookup,
): Promise<Workflow | undefined> {
  const evaluatedWorkflowId = run.runPlan?.evaluatedWorkflowId;
  if (evaluatedWorkflowId) {
    try {
      const snapshot = await findEvaluatedByRunId(evaluatedWorkflowId);
      if (snapshot) return snapshot;
    } catch (error) {
      // An unreadable snapshot settles against the repository definition.
      logger
        .debug`Run ${run.id}: evaluated workflow snapshot ${evaluatedWorkflowId} could not be read, settling against the workflow definition instead: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  return repositoryWorkflow;
}

/** How {@link settleCancelledRun} records the steps it finds in flight. */
export interface SettleOptions {
  /**
   * The error a step still `running` fails with. Defaults to
   * {@link CANCELLED_STEP_ERROR}; a cancel that stopped the run's owning
   * process passes `OWNER_STOPPED_STEP_ERROR`.
   */
  inFlightStepError?: string;
}

/**
 * Settles the run's unfinished work, then marks it cancelled with the
 * reason. No-op unless the run {@link WorkflowRun.isCancellable}. Every
 * production cancel of a run goes through here, so a cancelled record never
 * keeps a job `running` or a step `running` or `waiting_approval`.
 */
export function cancelAndSettle(
  run: WorkflowRun,
  workflow: Workflow | undefined,
  reason?: string,
  options?: SettleOptions,
): void {
  if (!run.isCancellable) return;
  settleCancelledRun(run, workflow, options);
  run.endAsCancelled(reason);
}

/**
 * Settles every job and step a cancellation left unfinished, as the live
 * abort does for the work it interrupts:
 *
 * - a step waiting on a nested workflow's run is detached from it first
 *   ({@link WorkflowRun.detachNestedWaits}), so the child stays suspended on
 *   its own and is reported as detached;
 * - a step still `running` (its owner died) fails as cancelled;
 * - an undecided approval gate fails as cancelled, marked `settledByAbort`;
 * - a pending step is skipped when its `dependsOn` is unmet, otherwise
 *   cancelled, marked `settledByAbort`; a guarded step stays pending;
 * - a pending job whose `dependsOn` is unmet is skipped; any other job
 *   still pending or running is settled from its steps once they are.
 *
 * Job records the definition cannot name (a job it dropped, or one whose
 * evaluated name the repository definition does not carry) are settled
 * first, from their records alone, so no job that depends on one is
 * evaluated while it is still open. The definition's jobs follow in
 * dependency order. With no definition, or one whose jobs or steps cannot
 * be ordered (edited into a cycle), every job is settled from its records.
 * Settling touches only pending, running and waiting_approval records, so
 * settling a run twice changes nothing.
 */
export function settleCancelledRun(
  run: WorkflowRun,
  workflow: Workflow | undefined,
  options?: SettleOptions,
): void {
  if (!run.isCancellable) return;
  run.detachNestedWaits();
  const inFlightError = options?.inFlightStepError ?? CANCELLED_STEP_ERROR;
  const definedJobs = new Set(workflow?.jobs.map((job) => job.name) ?? []);
  for (const jobRun of run.jobs) {
    if (!definedJobs.has(jobRun.jobName)) {
      settleJobFromRecords(jobRun, inFlightError);
    }
  }
  if (!workflow) return;

  try {
    const sorted = sortService.sort(workflow.jobs.map((job) => ({
      name: job.name,
      weight: job.weight,
      dependencies: job.getDependencyNames(),
    })));
    for (const level of sorted.levels) {
      for (const jobName of level) {
        const job = workflow.getJob(jobName);
        const jobRun = run.getJob(jobName);
        if (job && jobRun) settleDefinedJob(job, jobRun, run, inFlightError);
      }
    }
  } catch (error) {
    if (
      !(error instanceof CyclicDependencyError) &&
      !(error instanceof DuplicateNodeNameError)
    ) {
      throw error;
    }
    for (const jobRun of run.jobs) settleJobFromRecords(jobRun, inFlightError);
  }
}

/** True for a job a cancellation may leave unfinished. */
function isOpenJob(jobRun: JobRun): boolean {
  return jobRun.status === "pending" || jobRun.status === "running";
}

/**
 * Fails the job's in-flight steps with `inFlightError` and its undecided
 * approval gates as cancelled. Nothing will finish them once the run is
 * cancelled.
 */
function settleInFlightSteps(jobRun: JobRun, inFlightError: string): void {
  failAbandonedSteps(jobRun, inFlightError);
  for (const step of jobRun.steps) step.cancelUndecidedApproval();
}

/**
 * Ends a job from its records alone: every unfinished step cancelled, then
 * the job settled from their outcome.
 */
function settleJobFromRecords(jobRun: JobRun, inFlightError: string): void {
  if (!isOpenJob(jobRun)) return;
  settleInFlightSteps(jobRun, inFlightError);
  for (const step of jobRun.steps) {
    if (step.status === "pending") step.cancelUnstarted();
  }
  settleOpenJob(jobRun);
}

/**
 * Ends a job the definition names: skipped when its `dependsOn` is unmet
 * and it never started, otherwise its steps settled, then the job.
 */
function settleDefinedJob(
  job: Job,
  jobRun: JobRun,
  run: WorkflowRun,
  inFlightError: string,
): void {
  if (!isOpenJob(jobRun)) return;
  settleInFlightSteps(jobRun, inFlightError);
  if (jobRun.status === "pending" && !shouldJobRun(job, run)) {
    jobRun.skipNotStarted();
    return;
  }
  settlePendingSteps(job, jobRun);
  settleOpenJob(jobRun);
}

function settleOpenJob(jobRun: JobRun): void {
  if (jobRun.status === "running") {
    jobRun.settleNotResumed();
  } else {
    jobRun.settleNotStarted();
  }
}

/**
 * Settles the job's pending steps in dependency order, built from its
 * records as runJob builds them: a forEach step whose record was replaced
 * by its iterations stands for those iterations, each settled with the
 * forEach step's definition, and the expansion is registered on the job so
 * a condition naming the forEach step aggregates over them on a run loaded
 * from storage. Records the definition cannot name that are not iterations
 * are cancelled first.
 */
function settlePendingSteps(job: Job, jobRun: JobRun): void {
  const definedSteps = new Set(job.steps.map((step) => step.name));
  const iterations = new Map<string, string[]>();
  for (const stepRun of jobRun.steps) {
    const template = stepRun.forEachTemplate;
    if (template !== undefined && definedSteps.has(template)) {
      const names = iterations.get(template) ?? [];
      names.push(stepRun.stepName);
      iterations.set(template, names);
    } else if (
      !definedSteps.has(stepRun.stepName) && stepRun.status === "pending"
    ) {
      stepRun.cancelUnstarted();
    }
  }
  for (const [template, names] of iterations) {
    if (!jobRun.hasForEachExpansion(template)) {
      jobRun.registerForEachExpansion(template, names);
    }
  }

  const stepFor = new Map<string, Step>();
  const nodes: GraphNode[] = [];
  for (const step of job.steps) {
    const dependencies = step.getDependencyNames().flatMap((dep) =>
      iterations.get(dep) ?? [dep]
    );
    for (const name of iterations.get(step.name) ?? [step.name]) {
      stepFor.set(name, step);
      nodes.push({ name, weight: step.weight, dependencies });
    }
  }

  for (const level of sortService.sort(nodes).levels) {
    for (const name of level) {
      const stepRun = jobRun.getStep(name);
      if (stepRun?.status !== "pending") continue;
      settleUnstartedStep(stepFor.get(name), stepRun, jobRun);
    }
  }
}
