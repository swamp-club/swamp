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

import { UserError } from "../errors.ts";
import { quoteShellWord } from "../shell_word.ts";
import { laneStepOf } from "./fan_out_lanes.ts";
import { pairExpressionJobs, workflowJobOf } from "./job_pairing.ts";
import type { Workflow } from "./workflow.ts";
import {
  type FailedStepRef,
  stepRunKey,
  type StepRunRef,
  type WorkflowRun,
} from "./workflow_run.ts";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "skipped",
]);

export function entryTemplateOf(step: FailedStepRef): string {
  return step.forEachTemplate ?? step.stepName;
}

export function fromJobFor(
  workflow: Workflow,
  run: WorkflowRun,
  jobName: string,
  template: string,
): string | undefined {
  if (workflow.jobs.filter((j) => j.getStep(template)).length < 2) {
    return undefined;
  }
  const jobRun = run.getJob(jobName);
  const job = jobRun &&
    workflowJobOf(workflow, jobRun, pairExpressionJobs(workflow, run));
  return job?.getStep(template) ? job.name : undefined;
}

function fromArguments(
  workflow: Workflow,
  run: WorkflowRun,
  jobName: string,
  template: string,
): string {
  const from = `--from ${quoteShellWord(template)}`;
  const job = fromJobFor(workflow, run, jobName, template);
  return job !== undefined ? `${from} --job ${quoteShellWord(job)}` : from;
}

/**
 * refusals stay short and path-free: serve truncates client errors at 512
 * characters and hides any message that contains a filesystem path
 */
export function selectRetryTemplates(
  workflow: Workflow,
  run: WorkflowRun,
): StepRunRef[] {
  const history = `See 'swamp workflow history logs ${run.id}'.`;
  const failed = run.failedSteps();

  const rejected = failed.find((s) => s.approvalRejected);
  if (rejected) {
    throw new UserError(
      `Step "${rejected.stepName}" in job "${rejected.jobName}" was rejected; ` +
        `retry won't re-open it. Add ${
          fromArguments(
            workflow,
            run,
            rejected.jobName,
            entryTemplateOf(rejected),
          )
        } to ask again. ${history}`,
    );
  }

  const stranded = failed.find((s) => s.failureKind === "workflow_changed");
  if (stranded) {
    throw new UserError(
      `Step "${
        entryTemplateOf(stranded)
      }" in job "${stranded.jobName}" did not run: the workflow or a forEach collection changed. ` +
        `Start a new run. ${history}`,
    );
  }

  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (TERMINAL_STATUSES.has(step.status)) continue;
      // --from takes an authored step, so a gate is reached from the job's first
      const template = job.fanOutGateKindOf(step.stepName) !== undefined
        ? workflowJobOf(workflow, job, pairExpressionJobs(workflow, run))
          ?.steps[0]?.name
        : step.forEachTemplate ??
          laneStepOf(step.stepName, job.fanOutPlan?.lanes)?.authored ??
          step.stepName;
      const hint = step.status === "pending" && template !== undefined
        ? ` Add ${
          fromArguments(workflow, run, job.jobName, template)
        } to run it.`
        : "";
      throw new UserError(
        `Step "${step.stepName}" in job "${job.jobName}" is ${step.status}; ` +
          `retry needs every step finished.${hint} ${history}`,
      );
    }
    if (!TERMINAL_STATUSES.has(job.status)) {
      throw new UserError(
        `Job "${job.jobName}" is ${job.status}; retry needs every job finished. ${history}`,
      );
    }
  }

  // that member has no lane, so a retry could only fail the job again
  for (const job of run.jobs) {
    const member = job.fanOutPlan?.members.find((m) =>
      m.disposition === "failed"
    );
    if (job.status === "failed" && member !== undefined) {
      throw new UserError(
        `Fan-out job "${job.jobName}" failed because worker "${member.worker}" was not connected when the job was planned, and a retry never adds a member. Start a new run, or add --from to retry a step in another job. ${history}`,
      );
    }
  }

  if (failed.length === 0) {
    throw new UserError(`Run has no failed step to retry. ${history}`);
  }
  const jobsWithFailedStep = new Set(failed.map((s) => s.jobName));
  for (const job of run.jobs) {
    if (job.status === "failed" && !jobsWithFailedStep.has(job.jobName)) {
      throw new UserError(
        `Job "${job.jobName}" failed before any step failed; retry cannot select a step. ${history}`,
      );
    }
  }

  // A stored job belongs to the workflow job of its name, or to the
  // expression-named job it evaluated to (see workflowJobOf).
  const pairs = pairExpressionJobs(workflow, run);
  const entries = new Map<string, StepRunRef>();
  for (const step of failed) {
    const jobRun = run.getJob(step.jobName)!;
    const template = laneStepOf(step.stepName, jobRun.fanOutPlan?.lanes)
      ?.authored ?? entryTemplateOf(step);
    const job = workflowJobOf(workflow, jobRun, pairs);
    if (job?.getStep(template)) {
      const entry = { jobName: job.name, stepName: template };
      entries.set(stepRunKey(entry), entry);
    } else {
      // No --from hint: --from refuses a renamed step and a step moved to
      // another job too (see planFailedRunResume), so only a new run can be
      // suggested.
      throw new UserError(
        `Step "${step.stepName}" in job "${step.jobName}" is not in the current workflow. ` +
          `Start a new run. ${history}`,
      );
    }
  }

  for (const job of run.jobs) {
    const storedDuplicate = firstDuplicate(job.steps.map((s) => s.stepName));
    if (storedDuplicate !== undefined) {
      throw new UserError(
        `Step name "${storedDuplicate}" is stored more than once in job "${job.jobName}"; ` +
          `retry needs unique step names in a job. ${history}`,
      );
    }
  }

  return [...entries.values()];
}

function firstDuplicate(names: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}
