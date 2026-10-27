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
 * Retry of a failed run: resuming it without `--from`.
 *
 * Selects the workflow steps a retry re-enters at — the entry templates of
 * the run's failed steps — after checking that the stored run is complete
 * and unambiguous enough to retry. The caller resets each entry template and
 * its dependents through the same path as `--from`.
 */

import { UserError } from "../errors.ts";
import { quoteShellWord } from "../shell_word.ts";
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

/**
 * The workflow step a failed step came from: its forEach template, else the
 * step itself.
 */
export function entryTemplateOf(step: FailedStepRef): string {
  return step.forEachTemplate ?? step.stepName;
}

/**
 * The `--job` that, with `--from <template>`, re-enters the step `template`
 * of the stored job `jobName`, as `--from` resolves it against the current
 * workflow: undefined when the step name is in at most one workflow job, or
 * when the stored job cannot be told apart. A job named with an expression
 * is stored evaluated, so a stored job matches a workflow job by name, or
 * else the one expression-named job that has the step.
 */
export function fromJobFor(
  workflow: Workflow,
  jobName: string,
  template: string,
): string | undefined {
  const holders = workflow.jobs.filter((j) => j.getStep(template));
  if (holders.length < 2) return undefined;
  const literal = holders.find((j) => j.name === jobName);
  if (literal) return literal.name;
  const expressionNamed = holders.filter((j) => j.name.includes("${{"));
  return expressionNamed.length === 1 ? expressionNamed[0].name : undefined;
}

/**
 * The `--from` arguments that re-enter the step `template` of the stored job
 * `jobName`, shell-quoted, with `--job` when the step name needs it (see
 * {@link fromJobFor}).
 */
function fromArguments(
  workflow: Workflow,
  jobName: string,
  template: string,
): string {
  const from = `--from ${quoteShellWord(template)}`;
  const job = fromJobFor(workflow, jobName, template);
  return job !== undefined ? `${from} --job ${quoteShellWord(job)}` : from;
}

/**
 * Returns the distinct entry templates of the run's failed steps, each with
 * its job, in stored order, or throws a UserError naming the job or step that
 * makes the run ineligible for retry. Mutates nothing.
 *
 * A run is eligible when:
 * - no failed step is a rejected approval (retry never re-opens a gate);
 * - no failed step was stranded by a workflow change (a retry would fail it
 *   again);
 * - every job and step is succeeded, failed, or skipped;
 * - at least one failed step exists, and every failed job contains one;
 * - each entry template is a step of the same job in the current workflow;
 * - no stored job holds two records of the same name.
 *
 * Step names need be unique only within a job: a retry resets each entry
 * template in its own job.
 *
 * Refusals stay short and path-free: serve truncates client errors at 512
 * characters and hides any message that contains a filesystem path.
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
          fromArguments(workflow, rejected.jobName, entryTemplateOf(rejected))
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
      const hint = step.status === "pending"
        ? ` Add ${
          fromArguments(
            workflow,
            job.jobName,
            step.forEachTemplate ?? step.stepName,
          )
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

  for (const step of failed) {
    const template = entryTemplateOf(step);
    const job = workflow.jobs.find((j) => j.name === step.jobName);
    if (!job?.steps.some((s) => s.name === template)) {
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

  const entries = new Map<string, StepRunRef>();
  for (const step of failed) {
    const entry = { jobName: step.jobName, stepName: entryTemplateOf(step) };
    entries.set(stepRunKey(entry), entry);
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
