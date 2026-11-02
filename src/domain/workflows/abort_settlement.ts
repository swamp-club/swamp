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
import type { TriggerEvaluationContext } from "./trigger_condition.ts";
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

const sortService = new TopologicalSortService();
const logger = getLogger(["swamp", "workflows", "abort-settlement"]);

/**
 * injected by the caller, bound to the evaluated-workflow repository, so this
 * domain module never imports infrastructure
 */
export type EvaluatedWorkflowLookup = (
  runId: string,
) => Promise<Workflow | null>;

export function shouldJobRun(job: Job, run: WorkflowRun): boolean {
  if (job.dependsOn.length === 0) {
    return true;
  }

  for (const dep of job.dependsOn) {
    if (!dep.condition.evaluate(run, dep.job)) {
      return false;
    }
  }

  return true;
}

export function shouldStepRun(step: Step, jobRun: JobRun): boolean {
  if (step.dependsOn.length === 0) {
    return true;
  }

  for (const dep of step.dependsOn) {
    if (!dep.condition.evaluate(jobRun, dep.step)) {
      return false;
    }
  }

  return true;
}

/**
 * a cleanup step would still run had the earlier work failed; cleanup
 * dependencies count with their real status so a teardown chain runs to its
 * end; no dependsOn, an approval gate or a signal wait is work
 */
export function runsAfterFailure(
  step: Step,
  job: Job,
  jobRun: JobRun,
): boolean {
  const known = new Map<string, boolean>();
  const isCleanup = (candidate: Step): boolean => {
    const answer = known.get(candidate.name);
    if (answer !== undefined) return answer;
    const afterFailure: TriggerEvaluationContext = {
      getStatus: (ref) => {
        const dependency = job.getStep(ref);
        const status = jobRun.getStatus(ref);
        const ran = status === "succeeded" ||
          (status === "skipped" && jobRun.skippedByGuard(ref));
        return dependency && ran && isCleanup(dependency) ? status : "failed";
      },
    };
    const cleanup = !suspendsRun(candidate) &&
      candidate.dependsOn.length > 0 &&
      candidate.dependsOn.every((dep) =>
        dep.condition.evaluate(afterFailure, dep.step)
      );
    known.set(candidate.name, cleanup);
    return cleanup;
  };
  return isCleanup(step);
}

/**
 * job counterpart of runsAfterFailure; a job with no dependsOn, or holding an
 * approval gate or signal wait, is work since it would turn the cancel into a
 * suspended run
 */
export function jobRunsAfterFailure(
  job: Job,
  workflow: Workflow,
  run: WorkflowRun,
): boolean {
  const known = new Map<string, boolean>();
  const isCleanup = (candidate: Job): boolean => {
    const answer = known.get(candidate.name);
    if (answer !== undefined) return answer;
    const afterFailure: TriggerEvaluationContext = {
      getStatus: (ref) => {
        const dependency = workflow.getJob(ref);
        const status = run.getStatus(ref);
        return dependency && status === "succeeded" && isCleanup(dependency)
          ? status
          : "failed";
      },
    };
    const cleanup = !candidate.steps.some(suspendsRun) &&
      candidate.dependsOn.length > 0 &&
      candidate.dependsOn.every((dep) =>
        dep.condition.evaluate(afterFailure, dep.job)
      );
    known.set(candidate.name, cleanup);
    return cleanup;
  };
  return isCleanup(job);
}

function suspendsRun(step: Step): boolean {
  const taskType = step.task.data.type;
  return taskType === "manual_approval" || taskType === "wait_for_signal";
}

export function failAbandonedSteps(
  jobRun: JobRun,
  error: string = CANCELLED_STEP_ERROR,
): boolean {
  let failed = false;
  for (const step of jobRun.steps) {
    if (step.status === "running") {
      step.failStoppedByAbort(error);
      failed = true;
    }
  }
  return failed;
}

/**
 * a guarded step stays pending: its guard never decided whether the work was
 * done, so neither succeeded, failed, completed nor skipped may hold;
 * settledByAbort makes a resume run it
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

export function settleNotStartedJob(job: Job, jobRun: JobRun): void {
  settleUnstartedSteps(job, jobRun);
  jobRun.settleNotStarted();
}

export function settleUnstartedJob(
  job: Job,
  jobRun: JobRun,
  run: WorkflowRun,
): void {
  if (!shouldJobRun(job, run)) {
    jobRun.skipNotStarted();
  } else {
    settleNotStartedJob(job, jobRun);
  }
}

export function settleNotResumedJob(job: Job, jobRun: JobRun): void {
  settleUnstartedSteps(job, jobRun);
  jobRun.settleNotResumed();
}

/**
 * settles against the run's own evaluated snapshot, whose names match its
 * records; without one (older run, gc'd, unreadable) falls back to the
 * repository definition, which may be undefined
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

export interface SettleOptions {
  inFlightStepError?: string;
}

/**
 * every production cancel goes through here, so a cancelled record never keeps
 * a job running or a step running, waiting_approval or waiting
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
 * the caller fails the rejected gate and leaves its job open so settlement ends
 * it from the failed gate; a job already failed is not settled, so its pending
 * steps would stay
 */
export function completeAndSettle(
  run: WorkflowRun,
  workflow: Workflow | undefined,
): void {
  if (!run.isCancellable) return;
  settleCancelledRun(run, workflow);
  run.complete();
}

/**
 * jobs the definition cannot name are settled first from their records; with no
 * definition or an unorderable one (a cycle) every job is settled from records;
 * only open records change, so settling twice is a no-op
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

function isOpenJob(jobRun: JobRun): boolean {
  return jobRun.status === "pending" || jobRun.status === "running";
}

function settleInFlightSteps(jobRun: JobRun, inFlightError: string): void {
  failAbandonedSteps(jobRun, inFlightError);
  for (const step of jobRun.steps) {
    step.cancelUndecidedApproval();
    step.cancelOpenWait();
  }
}

function settleJobFromRecords(jobRun: JobRun, inFlightError: string): void {
  if (!isOpenJob(jobRun)) return;
  settleInFlightSteps(jobRun, inFlightError);
  for (const step of jobRun.steps) {
    if (step.status === "pending") step.cancelUnstarted();
  }
  settleOpenJob(jobRun);
}

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
 * a forEach step replaced by its iterations stands for them, and the expansion
 * is registered on the job so a condition naming it aggregates over them on a
 * run loaded from storage
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
