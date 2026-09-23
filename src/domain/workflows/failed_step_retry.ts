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
import type { Workflow } from "./workflow.ts";
import type { FailedStepRef, WorkflowRun } from "./workflow_run.ts";

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
 * Returns the distinct entry templates of the run's failed steps, in stored
 * order, or throws a UserError naming the job or step that makes the run
 * ineligible for retry. Mutates nothing.
 *
 * A run is eligible when:
 * - no failed step is a rejected approval (retry never re-opens a gate);
 * - every job and step is succeeded, failed, or skipped;
 * - at least one failed step exists, and every failed job contains one;
 * - each entry template is a step of the same job in the current workflow;
 * - step names are unique across the workflow and across the stored run.
 *
 * Refusals stay short and path-free: serve truncates client errors at 200
 * characters and hides any message that contains a filesystem path.
 */
export function selectRetryTemplates(
  workflow: Workflow,
  run: WorkflowRun,
): string[] {
  const history = `See 'swamp workflow history logs ${run.id}'.`;
  const failed = run.failedSteps();

  const rejected = failed.find((s) => s.approvalRejected);
  if (rejected) {
    throw new UserError(
      `Step "${rejected.stepName}" in job "${rejected.jobName}" was rejected; ` +
        `retry won't re-open it. Add --from ${
          entryTemplateOf(rejected)
        } to ask again. ${history}`,
    );
  }

  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (TERMINAL_STATUSES.has(step.status)) continue;
      const hint = step.status === "pending"
        ? ` Add --from ${step.forEachTemplate ?? step.stepName} to run it.`
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
      // No --from hint: --from fails on a renamed step and skips a step
      // moved to another job, so only a new run is safe to suggest.
      throw new UserError(
        `Step "${step.stepName}" in job "${step.jobName}" is not in the current workflow. ` +
          `Start a new run. ${history}`,
      );
    }
  }

  const workflowDuplicate = firstDuplicate(
    workflow.jobs.flatMap((j) => j.steps.map((s) => s.name)),
  );
  if (workflowDuplicate !== undefined) {
    throw new UserError(
      `Step name "${workflowDuplicate}" is used in more than one place in the workflow; ` +
        `retry needs unique step names. ${history}`,
    );
  }
  const storedDuplicate = firstDuplicate(
    run.jobs.flatMap((j) => j.steps.map((s) => s.stepName)),
  );
  if (storedDuplicate !== undefined) {
    throw new UserError(
      `Step name "${storedDuplicate}" is stored more than once in the run; ` +
        `retry needs unique step names. ${history}`,
    );
  }

  return [...new Set(failed.map(entryTemplateOf))];
}

function firstDuplicate(names: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}
