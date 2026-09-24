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
 * Resuming a failed run: with `--from`, or as a retry without it.
 *
 * Computes the reset set and checks, before anything changes, that the
 * current workflow can still be walked against the stored run. Resume walks
 * every job of the current workflow whose stored record is unfinished after
 * the reset (a re-entered job), and looks up each step's record in that same
 * stored job. A step moved, renamed, or added since the run either has no
 * record there (a mid-run crash) or leaves a reset record that no job walks
 * (a false success), so the structure check refuses both.
 */

import { UserError } from "../errors.ts";
import { selectRetryTemplates } from "./failed_step_retry.ts";
import type { Workflow } from "./workflow.ts";
import type { StepRunRef, WorkflowRun } from "./workflow_run.ts";

/** Why {@link computeStepsToReset} selected a stored step record. */
type ResetBranch = "name" | "template" | "prefix";

interface SelectedRecord {
  readonly jobName: string;
  readonly stepName: string;
  readonly forEachTemplate: string | undefined;
  readonly branch: ResetBranch;
}

/**
 * The outcome of planning a failed-run resume.
 */
export interface ResumeReset {
  /** Stored step names to reset, as `WorkflowRun.resetForResumeFrom` takes. */
  readonly steps: ReadonlySet<string>;
  /**
   * Reset records selected by name or `forEachTemplate`. The current workflow
   * walks each one in its own job, so one its job finishes without running
   * was stranded by a workflow change. Records selected only by the legacy
   * forEach prefix are not tracked: that match can over-select.
   */
  readonly tracked: readonly StepRunRef[];
}

/** Stored statuses resume() treats as finished: it skips a job in one. */
const FINISHED_JOB_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "unknown",
]);

/**
 * Validates `fromStep` and returns it plus every template step downstream of
 * it, across all jobs.
 */
function templatesToReset(workflow: Workflow, fromStep: string): Set<string> {
  // Validate that fromStep is a template step name in the workflow definition.
  let foundInJob: string | undefined;
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (step.name === fromStep) {
        foundInJob = job.name;
        break;
      }
    }
    if (foundInJob) break;
  }
  if (!foundInJob) {
    const allStepNames = workflow.jobs
      .flatMap((j) => j.steps.map((s) => s.name));
    throw new UserError(
      `Step "${fromStep}" not found in workflow "${workflow.name}". ` +
        `Available steps: ${allStepNames.join(", ")}`,
    );
  }

  // Build a combined dependency graph across all jobs and steps.
  // Job-level dependencies create edges from every step in the upstream job
  // to the dependent job's steps.
  const downstreamOf = new Map<string, Set<string>>();

  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (!downstreamOf.has(step.name)) {
        downstreamOf.set(step.name, new Set());
      }
      // Step-level dependencies (within a job)
      for (const dep of step.getDependencyNames()) {
        if (!downstreamOf.has(dep)) {
          downstreamOf.set(dep, new Set());
        }
        downstreamOf.get(dep)!.add(step.name);
      }
    }
    // Job-level dependencies: if job B depends on job A, then all steps in
    // job A are upstream of all steps in job B (for the purpose of --from
    // reset propagation).
    for (const depJobName of job.getDependencyNames()) {
      const depJob = workflow.jobs.find((j) => j.name === depJobName);
      if (!depJob) continue;
      for (const depStep of depJob.steps) {
        for (const step of job.steps) {
          if (!downstreamOf.has(depStep.name)) {
            downstreamOf.set(depStep.name, new Set());
          }
          downstreamOf.get(depStep.name)!.add(step.name);
        }
      }
    }
  }

  // BFS from fromStep to collect all transitive downstream template names.
  const templateNamesToReset = new Set<string>();
  const queue = [fromStep];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (templateNamesToReset.has(current)) continue;
    templateNamesToReset.add(current);
    for (const downstream of downstreamOf.get(current) ?? []) {
      if (!templateNamesToReset.has(downstream)) {
        queue.push(downstream);
      }
    }
  }
  return templateNamesToReset;
}

/**
 * Maps template names to the stored step records they reset, recording why
 * each record was selected.
 */
function selectResetRecords(
  workflow: Workflow,
  run: WorkflowRun,
  templateNamesToReset: ReadonlySet<string>,
): SelectedRecord[] {
  // Map template names to persisted step names. For forEach steps, the
  // template entry was replaced by expanded entries during the original run.
  // We match by checking if a persisted step name equals the template name
  // (non-forEach) or starts with the template name followed by a separator
  // (forEach-expanded). We also check against the workflow definition to
  // only apply prefix matching for steps that have forEach configured.
  const allTemplateNames = new Set<string>();
  const forEachTemplates = new Set<string>();
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      allTemplateNames.add(step.name);
      if (step.forEach) {
        forEachTemplates.add(step.name);
      }
    }
  }

  const selected: SelectedRecord[] = [];
  for (const jobRun of run.jobs) {
    for (const stepRun of jobRun.steps) {
      const name = stepRun.stepName;
      const select = (branch: ResetBranch) =>
        selected.push({
          jobName: jobRun.jobName,
          stepName: name,
          forEachTemplate: stepRun.forEachTemplate,
          branch,
        });
      if (templateNamesToReset.has(name)) {
        select("name");
      } else if (
        stepRun.forEachTemplate &&
        templateNamesToReset.has(stepRun.forEachTemplate)
      ) {
        select("template");
      } else if (!allTemplateNames.has(name)) {
        // Backward-compat fallback for runs persisted before forEachTemplate
        // was recorded: prefix-match against forEach templates. Only applies
        // to steps that are NOT themselves template names (prevents a forEach
        // template "read" from matching a non-forEach step "read-plate").
        for (const tmpl of templateNamesToReset) {
          if (
            forEachTemplates.has(tmpl) &&
            name.startsWith(tmpl + "-")
          ) {
            select("prefix");
            break;
          }
        }
      }
    }
  }
  return selected;
}

function zeroStepsError(fromStep: string): UserError {
  return new UserError(
    `--from "${fromStep}" matched zero persisted steps in the run. ` +
      `The step may not have been reached during execution.`,
  );
}

/**
 * Computes the set of persisted step names (including forEach-expanded names)
 * to reset when re-entering a failed run at `fromStep`. The result includes
 * the fromStep itself and all its transitive downstream dependents across all
 * jobs. Used by a `--from` resume, and once per entry template by a retry
 * (a resume of a failed run without `--from`).
 */
export function computeStepsToReset(
  workflow: Workflow,
  run: WorkflowRun,
  fromStep: string,
): Set<string> {
  const stepsToReset = new Set(
    selectResetRecords(workflow, run, templatesToReset(workflow, fromStep))
      .map((record) => record.stepName),
  );
  if (stepsToReset.size === 0) {
    throw zeroStepsError(fromStep);
  }
  return stepsToReset;
}

/**
 * Plans a resume of a failed run: re-entering at `fromStep`, or, without it,
 * retrying the entry template of every failed step (see
 * {@link selectRetryTemplates}). Returns the reset set, or throws a UserError
 * that names the job or step when the run cannot be resumed against the
 * current workflow. Mutates nothing.
 *
 * Only for a failed run: a suspended run has no reset set, and its
 * unfinished steps would fail the retry eligibility check.
 *
 * The structure check refuses when:
 * - (a) a job of the current workflow has no stored record;
 * - (b) a re-entered job has a step, other than a forEach template, with no
 *   record in that stored job. This is conservative: it also checks a job
 *   whose trigger condition would skip it;
 * - (c) a record selected by name is not a step of its own job in the
 *   current workflow, or a record selected by `forEachTemplate` is not an
 *   iteration of a forEach step of its own job.
 *
 * It leaves alone: records selected only by the legacy forEach prefix,
 * which can over-select; unfinished records that were not reset; forEach
 * templates with no records (an empty expansion removes the template
 * record); job and step names written with an expression, which are stored
 * evaluated and cannot be compared before evaluation; and terminal records
 * and jobs the workflow no longer has.
 */
export function planFailedRunResume(
  workflow: Workflow,
  run: WorkflowRun,
  fromStep?: string,
): ResumeReset {
  const entryTemplates = fromStep !== undefined
    ? [fromStep]
    : selectRetryTemplates(workflow, run);
  // One pass over the union of the template sets selects the same records as
  // the union of computeStepsToReset per entry template, with one branch per
  // record.
  const templateNames = new Set<string>();
  for (const template of entryTemplates) {
    for (const name of templatesToReset(workflow, template)) {
      templateNames.add(name);
    }
  }
  const selected = selectResetRecords(workflow, run, templateNames);
  if (selected.length === 0) {
    // A retry's entry templates always match their failed records.
    throw fromStep !== undefined
      ? zeroStepsError(fromStep)
      : new UserError(`Retry matched no persisted steps in run ${run.id}.`);
  }
  const steps = new Set(selected.map((record) => record.stepName));

  const history = `See 'swamp workflow history logs ${run.id}'.`;
  const refuse = (problem: string) =>
    new UserError(`${problem} Start a new run. ${history}`);
  const moved = (step: string, stored: string, current: string) =>
    `Step "${step}" is in job "${stored}" in the run, job "${current}" in the workflow.`;
  const jobOfStep = (stepName: string) =>
    workflow.jobs.find((j) => j.steps.some((s) => s.name === stepName))
      ?.name;
  const movedOrChanged = (step: string, job: string) => {
    const now = jobOfStep(step);
    return now !== undefined && now !== job
      ? moved(step, job, now)
      : `Step "${step}" in job "${job}" is no longer a forEach step.`;
  };
  // A name written with an expression is stored evaluated, so it cannot be
  // compared with a stored record before the workflow is evaluated.
  const evaluated = (name: string) => name.includes("${{");
  const hasEvaluatedJob = workflow.jobs.some((j) => evaluated(j.name));

  // (a) Resume looks up a stored record for every job it walks.
  for (const job of workflow.jobs) {
    if (!evaluated(job.name) && !run.getJob(job.name)) {
      throw refuse(`Job "${job.name}" is not in the run.`);
    }
  }

  // (c) A record reset by name or template must be walked in its own job.
  const tracked: StepRunRef[] = [];
  for (const record of selected) {
    if (record.branch === "prefix") continue;
    const ownJob = workflow.getJob(record.jobName);
    if (!ownJob && hasEvaluatedJob) continue;
    const ownStep = (name: string) => ownJob?.getStep(name);
    const fromTemplate = record.forEachTemplate !== undefined &&
      ownStep(record.forEachTemplate)?.forEach !== undefined;
    if (record.branch === "name") {
      if (!ownStep(record.stepName) && !fromTemplate) {
        throw refuse(movedOrChanged(record.stepName, record.jobName));
      }
    } else if (!fromTemplate) {
      throw refuse(movedOrChanged(record.forEachTemplate!, record.jobName));
    }
    tracked.push({ jobName: record.jobName, stepName: record.stepName });
  }

  // (b) Every step a re-entered job walks, other than a forEach template,
  // needs a record in that stored job. resetForResumeFrom resets records by
  // name in every job, so a job is re-entered when any of its records is.
  for (const job of workflow.jobs) {
    if (evaluated(job.name)) continue;
    const jobRun = run.getJob(job.name)!;
    const reentered = !FINISHED_JOB_STATUSES.has(jobRun.status) ||
      jobRun.steps.some((s) => steps.has(s.stepName));
    if (!reentered) continue;
    for (const step of job.steps) {
      if (step.forEach || evaluated(step.name)) continue;
      if (jobRun.getStep(step.name)) continue;
      const storedIn = run.jobs.find((j) => j.getStep(step.name))?.jobName;
      throw refuse(
        storedIn !== undefined
          ? moved(step.name, storedIn, job.name)
          : `Step "${step.name}" in job "${job.name}" is not in the run.`,
      );
    }
  }

  return { steps, tracked };
}
