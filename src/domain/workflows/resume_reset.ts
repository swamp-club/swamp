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
 * Resuming a failed run (with `--from`, or as a retry without it) or a
 * suspended run.
 *
 * Computes a failed run's reset set, and checks, before anything changes,
 * that the current workflow can still be walked against the stored run.
 * Resume walks every job of the current workflow whose stored record is
 * unfinished (a re-entered job; for a failed run, after the reset), and looks
 * up each step's record in that same stored job. A step moved, renamed, or
 * added since the run either has no record there (a mid-run crash) or leaves
 * an unfinished record that no job walks (a false success), so the structure
 * check refuses both.
 */

import { UserError } from "../errors.ts";
import { selectRetryTemplates } from "./failed_step_retry.ts";
import {
  evaluatedName as evaluated,
  pairExpressionJobs,
  workflowJobOf,
} from "./job_pairing.ts";
import type { Job } from "./job.ts";
import type { Workflow } from "./workflow.ts";
import {
  type JobRun,
  type StepRun,
  stepRunKey,
  type StepRunRef,
  type WorkflowRun,
} from "./workflow_run.ts";

/**
 * Why a stored step record was selected for reset: by
 * {@link computeStepsToReset} (`name`, `template`, `prefix`), or because the
 * run's abort settled it without starting it (`settled`).
 */
type ResetBranch = "name" | "template" | "prefix" | "settled";

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
  /** Stored step records to reset, as `WorkflowRun.resetForResumeFrom` takes. */
  readonly steps: readonly StepRunRef[];
  /**
   * Reset records selected by name or `forEachTemplate`. The current workflow
   * walks each one in its own job, so one its job finishes without running
   * was stranded by a workflow change. Records selected only by the legacy
   * forEach prefix are not tracked: that match can over-select.
   */
  readonly tracked: readonly StepRunRef[];
}

/** Stored statuses resume() treats as finished: it skips a job or step in one. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "unknown",
]);

/**
 * Whether resume leaves a stored step record alone. A record the run's abort
 * settled without starting is reset first, so resume walks it.
 */
function finishedRecord(record: StepRun): boolean {
  return FINISHED_STATUSES.has(record.status) && !record.settledByAbort;
}

/**
 * Whether resume skips a stored job. A finished job holding work the run's
 * abort left unfinished is reopened first, so resume walks it (see
 * `WorkflowRun.reopenAbortedWork`).
 */
function finishedJob(jobRun: JobRun): boolean {
  return FINISHED_STATUSES.has(jobRun.status) && !jobRun.holdsAbortedWork;
}

/**
 * Where a `--from` resume re-enters: a template step name, and the job it is
 * in. The job may be left out when the name is used in only one job.
 */
export interface ResumeFrom {
  readonly step: string;
  readonly job?: string;
}

/** Job names a refusal lists before it counts the rest. */
const LISTED_JOBS = 3;

function jobList(names: readonly string[]): string {
  const listed = names.slice(0, LISTED_JOBS).map((n) => `"${n}"`).join(", ");
  const rest = names.length - LISTED_JOBS;
  return rest > 0 ? `${listed} and ${rest} more` : listed;
}

/** "job" or "jobs" before {@link jobList} of `names`. */
function jobsNoun(names: readonly string[]): string {
  return names.length === 1 ? "job" : "jobs";
}

function stepNotFound(workflow: Workflow, step: string): UserError {
  const allStepNames = [
    ...new Set(workflow.jobs.flatMap((j) => j.steps.map((s) => s.name))),
  ];
  return new UserError(
    `Step "${step}" not found in workflow "${workflow.name}". ` +
      `Available steps: ${allStepNames.join(", ")}`,
  );
}

/**
 * Resolves `--from` to the workflow step it names. Step names are unique only
 * within a job, so a name used in more than one job needs `--job`.
 */
function resolveFrom(workflow: Workflow, from: ResumeFrom): StepRunRef {
  const jobsWithStep = workflow.jobs
    .filter((j) => j.getStep(from.step) !== undefined)
    .map((j) => j.name);
  if (from.job !== undefined) {
    const job = workflow.getJob(from.job);
    if (!job) {
      throw new UserError(
        `Job "${from.job}" not found in workflow "${workflow.name}". ` +
          `Available jobs: ${jobList(workflow.jobs.map((j) => j.name))}.`,
      );
    }
    if (!job.getStep(from.step)) {
      if (jobsWithStep.length === 0) throw stepNotFound(workflow, from.step);
      throw new UserError(
        `Step "${from.step}" is not in job "${from.job}". ` +
          `It is in ${jobsNoun(jobsWithStep)} ${jobList(jobsWithStep)}.`,
      );
    }
    return { jobName: job.name, stepName: from.step };
  }
  if (jobsWithStep.length === 0) throw stepNotFound(workflow, from.step);
  if (jobsWithStep.length > 1) {
    throw new UserError(
      `Step "${from.step}" is in more than one job: ${
        jobList(jobsWithStep)
      }. ` +
        `Add --job <job> to choose one.`,
    );
  }
  return { jobName: jobsWithStep[0], stepName: from.step };
}

/**
 * Returns the keys ({@link stepRunKey}) of the entry steps plus every
 * template step downstream of them, across all jobs. A step's `dependsOn`
 * names steps of its own job; a job dependency puts every step of the
 * upstream job upstream of every step of the dependent job.
 */
function templatesToReset(
  workflow: Workflow,
  entries: readonly StepRunRef[],
): Set<string> {
  const downstreamOf = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => {
    let downstream = downstreamOf.get(from);
    if (!downstream) {
      downstream = new Set();
      downstreamOf.set(from, downstream);
    }
    downstream.add(to);
  };

  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      const key = stepRunKey({ jobName: job.name, stepName: step.name });
      for (const dep of step.getDependencyNames()) {
        edge(stepRunKey({ jobName: job.name, stepName: dep }), key);
      }
    }
    for (const depJobName of job.getDependencyNames()) {
      const depJob = workflow.jobs.find((j) => j.name === depJobName);
      if (!depJob) continue;
      for (const depStep of depJob.steps) {
        for (const step of job.steps) {
          edge(
            stepRunKey({ jobName: depJob.name, stepName: depStep.name }),
            stepRunKey({ jobName: job.name, stepName: step.name }),
          );
        }
      }
    }
  }

  // BFS from the entry steps to collect all transitive downstream templates.
  const templateKeysToReset = new Set<string>();
  const queue = entries.map(stepRunKey);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (templateKeysToReset.has(current)) continue;
    templateKeysToReset.add(current);
    for (const downstream of downstreamOf.get(current) ?? []) {
      if (!templateKeysToReset.has(downstream)) {
        queue.push(downstream);
      }
    }
  }
  return templateKeysToReset;
}

/**
 * Why the reset cannot be applied to the run: it reaches an expression-named
 * job, and the workflow's jobs no longer line up with the run's, so which
 * stored job that job evaluated to cannot be told (see
 * {@link pairExpressionJobs}).
 */
function unpairedExpressionJob(
  workflow: Workflow,
  pairs: ReadonlyMap<string, string> | undefined,
  templateKeysToReset: ReadonlySet<string>,
): string | undefined {
  if (pairs !== undefined) return undefined;
  const job = workflow.jobs.find((j) =>
    evaluated(j.name) &&
    j.steps.some((s) =>
      templateKeysToReset.has(stepRunKey({ jobName: j.name, stepName: s.name }))
    )
  );
  return job
    ? `Job "${job.name}" cannot be matched to a job of the run: the workflow's jobs changed since the run.`
    : undefined;
}

/**
 * Maps the keyed template steps to the stored step records they reset,
 * recording why each record was selected. A record is matched only against
 * the template steps of the workflow job its stored job belongs to (see
 * {@link workflowJobOf}).
 */
function selectResetRecords(
  workflow: Workflow,
  run: WorkflowRun,
  pairs: ReadonlyMap<string, string> | undefined,
  templateKeysToReset: ReadonlySet<string>,
): SelectedRecord[] {
  // Map template steps to persisted step names. For forEach steps, the
  // template entry was replaced by expanded entries during the original run.
  // We match by checking if a persisted step name equals the template name
  // (non-forEach) or starts with the template name followed by a separator
  // (forEach-expanded). We also check against the workflow definition to
  // only apply prefix matching for steps that have forEach configured.
  const selected: SelectedRecord[] = [];
  for (const jobRun of run.jobs) {
    const job = workflowJobOf(workflow, jobRun, pairs);
    if (!job) continue;
    for (const stepRun of jobRun.steps) {
      const branch = matchRecord(job, stepRun);
      if (branch === undefined) continue;
      selected.push({
        jobName: jobRun.jobName,
        stepName: stepRun.stepName,
        forEachTemplate: stepRun.forEachTemplate,
        branch,
      });
    }
  }
  return selected;

  function matchRecord(job: Job, stepRun: StepRun): ResetBranch | undefined {
    const resets = (stepName: string) =>
      templateKeysToReset.has(stepRunKey({ jobName: job.name, stepName }));
    const name = stepRun.stepName;
    if (resets(name)) return "name";
    if (stepRun.forEachTemplate && resets(stepRun.forEachTemplate)) {
      return "template";
    }
    if (job.getStep(name)) return undefined;
    // Backward-compat fallback for runs persisted before forEachTemplate
    // was recorded: prefix-match against the job's forEach templates. Only
    // applies to steps that are NOT themselves template names (prevents a
    // forEach template "read" from matching a non-forEach step "read-plate").
    return job.steps.some((step) =>
        step.forEach !== undefined && resets(step.name) &&
        name.startsWith(step.name + "-")
      )
      ? "prefix"
      : undefined;
  }
}

function zeroStepsError(fromStep: string): UserError {
  return new UserError(
    `--from "${fromStep}" matched zero persisted steps in the run. ` +
      `The step may not have been reached during execution.`,
  );
}

/**
 * Computes the persisted step records (including forEach-expanded names) to
 * reset when re-entering a failed run at `from`. The result includes the
 * `from` step itself and all its transitive downstream dependents across all
 * jobs, each by the job that holds it. Used by a `--from` resume; a retry
 * plans through {@link planFailedRunResume}.
 */
export function computeStepsToReset(
  workflow: Workflow,
  run: WorkflowRun,
  from: ResumeFrom,
): StepRunRef[] {
  const pairs = pairExpressionJobs(workflow, run);
  const keys = templatesToReset(workflow, [resolveFrom(workflow, from)]);
  const unpaired = unpairedExpressionJob(workflow, pairs, keys);
  if (unpaired !== undefined) {
    throw new UserError(`${unpaired} Start a new run.`);
  }
  const stepsToReset = selectResetRecords(workflow, run, pairs, keys)
    .map(({ jobName, stepName }) => ({ jobName, stepName }));
  if (stepsToReset.length === 0) {
    throw zeroStepsError(from.step);
  }
  return stepsToReset;
}

function moved(step: string, stored: string, current: string): string {
  return `Step "${step}" is in job "${stored}" in the run, job "${current}" in the workflow.`;
}

/**
 * Why a stored record of `step` in `job` no longer belongs to that job: the
 * workflow has the step in another job, or it is no longer a forEach step.
 */
function movedOrChanged(workflow: Workflow, step: string, job: string): string {
  const now = workflow.jobs.find((j) => j.steps.some((s) => s.name === step))
    ?.name;
  return now !== undefined && now !== job
    ? moved(step, job, now)
    : `Step "${step}" in job "${job}" is no longer a forEach step.`;
}

/**
 * Why the `--from` step `entry` has no record in its own stored job, when
 * another stored job holds its records (by name, or as iterations) and the
 * workflow no longer has the step there: the step moved. A job missing from
 * the run is left to rule (a). A stored job no workflow job can be paired
 * with is searched only when the workflow has no expression-named job that
 * may have evaluated to it.
 */
function movedEntry(
  workflow: Workflow,
  run: WorkflowRun,
  pairs: ReadonlyMap<string, string> | undefined,
  entry: StepRunRef,
): string | undefined {
  const name = entry.stepName;
  const holds = (jobRun: JobRun) =>
    jobRun.steps.some((s) => s.stepName === name || s.forEachTemplate === name);
  const ownName = evaluated(entry.jobName)
    ? pairs?.get(entry.jobName)
    : entry.jobName;
  const own = ownName !== undefined ? run.getJob(ownName) : undefined;
  if (!own || holds(own)) return undefined;
  // Iterations of a forEach entry step stored before forEachTemplate was
  // recorded are named after it, as the legacy prefix match in
  // selectResetRecords reads them: a record that is not itself a step of the
  // job.
  const ownJob = workflow.getJob(entry.jobName);
  if (
    ownJob?.getStep(name)?.forEach !== undefined &&
    own.steps.some((s) =>
      s.forEachTemplate === undefined && s.stepName.startsWith(`${name}-`) &&
      !ownJob.getStep(s.stepName)
    )
  ) {
    return undefined;
  }
  const hasEvaluatedJob = workflow.jobs.some((j) => evaluated(j.name));
  const storedIn = run.jobs.find((j) => {
    const job = workflowJobOf(workflow, j, pairs);
    if (!job && hasEvaluatedJob && pairs === undefined) return false;
    return j !== own && !job?.getStep(name) && holds(j);
  })?.jobName;
  return storedIn !== undefined
    ? moved(name, storedIn, entry.jobName)
    : undefined;
}

/** Rule (a): resume looks up a stored record for every job it walks. */
function missingJob(workflow: Workflow, run: WorkflowRun): string | undefined {
  const job = workflow.jobs.find((j) =>
    !evaluated(j.name) && !run.getJob(j.name)
  );
  return job ? `Job "${job.name}" is not in the run.` : undefined;
}

/**
 * Rule (b): every step a re-entered job walks, other than a forEach template,
 * needs a record in that stored job. Call after rule (a) passes. Step names
 * are unique only within a job, so the step moved from another stored job
 * only when the workflow no longer has it there; otherwise it was added.
 */
function missingStep(
  workflow: Workflow,
  run: WorkflowRun,
  reentered: (jobRun: JobRun) => boolean,
): string | undefined {
  for (const job of workflow.jobs) {
    if (evaluated(job.name)) continue;
    const jobRun = run.getJob(job.name)!;
    if (!reentered(jobRun)) continue;
    for (const step of job.steps) {
      if (step.forEach || evaluated(step.name)) continue;
      if (jobRun.getStep(step.name)) continue;
      const storedIn = run.jobs.find((j) =>
        j.getStep(step.name) &&
        !workflow.getJob(j.jobName)?.getStep(step.name)
      )?.jobName;
      return storedIn !== undefined
        ? moved(step.name, storedIn, job.name)
        : `Step "${step.name}" in job "${job.name}" is not in the run.`;
    }
  }
  return undefined;
}

/**
 * Whether a stored job already had the step `name` of `job`: a record of that
 * name, or iterations of it. A forEach step can leave neither (an empty
 * expansion removes its template record, and `--last-evaluated` or older runs
 * store iterations without `forEachTemplate`), so once the job has started,
 * or it holds records named like iterations, that cannot be ruled out and the
 * step counts as recorded.
 */
function recordsStep(
  jobRun: JobRun | undefined,
  job: Job,
  name: string,
): boolean {
  if (!jobRun) return false;
  if (
    jobRun.steps.some((s) => s.stepName === name || s.forEachTemplate === name)
  ) {
    return true;
  }
  if (job.getStep(name)?.forEach === undefined) return false;
  return jobRun.status !== "pending" ||
    jobRun.steps.some((s) =>
      s.forEachTemplate === undefined && s.stepName.startsWith(`${name}-`) &&
      !job.getStep(s.stepName)
    );
}

/**
 * Rule (c) for a suspended run: an unfinished record of an unfinished job
 * must still be walked in its own job. One whose step the workflow now has
 * in another job would stay pending while the run reports success. One whose
 * step no other job has was removed, which is allowed.
 */
function movedUnfinishedStep(
  workflow: Workflow,
  run: WorkflowRun,
): string | undefined {
  const hasEvaluatedJob = workflow.jobs.some((j) => evaluated(j.name));
  for (const jobRun of run.jobs) {
    if (finishedJob(jobRun)) continue;
    const ownJob = workflow.getJob(jobRun.jobName);
    if (!ownJob && hasEvaluatedJob) continue;
    for (const record of jobRun.steps) {
      if (finishedRecord(record)) continue;
      const template = record.forEachTemplate;
      const name = template ?? record.stepName;
      const own = ownJob?.getStep(name);
      if (own && (template === undefined || own.forEach !== undefined)) {
        continue;
      }
      if (own) {
        return `Step "${name}" in job "${jobRun.jobName}" is no longer a forEach step.`;
      }
      // Step names are unique only within a job, so the step cannot have
      // moved into a job whose stored record already has one of that name:
      // it was removed from this job. Expression-named jobs are stored
      // evaluated and cannot be compared.
      const now = workflow.jobs.find((j) =>
        !evaluated(j.name) && j.getStep(name) &&
        !recordsStep(run.getJob(j.name), j, name)
      );
      if (now) return moved(name, jobRun.jobName, now.name);
    }
  }
  return undefined;
}

/**
 * Rule (d): resume never walks an unfinished job the workflow no longer has,
 * so the run would end failed with no failed step. A finished job holding
 * aborted work counts as unfinished: it is reopened to pending first.
 */
function removedUnfinishedJob(
  workflow: Workflow,
  run: WorkflowRun,
): string | undefined {
  if (workflow.jobs.some((j) => evaluated(j.name))) return undefined;
  const job = run.jobs.find((j) =>
    !finishedJob(j) && !workflow.getJob(j.jobName)
  );
  return job
    ? `Job "${job.jobName}" is in the run but not in the workflow.`
    : undefined;
}

/**
 * How to clear a suspended run a resume refused. A local cancel refuses a run
 * serve started, so such a run is cancelled through serve instead.
 */
export function suspendedWayOut(
  workflow: Workflow,
  run: WorkflowRun,
): string {
  return run.instanceId !== undefined
    ? `To cancel it: 'swamp workflow cancel --run ${run.id} --server <url>'.`
    : `To cancel it: 'swamp workflow cancel ${workflow.name} --run ${run.id}'.`;
}

/**
 * Plans a resume of a failed run: re-entering at `from`, or, without it,
 * retrying the entry template of every failed step (see
 * {@link selectRetryTemplates}). Steps are identified by job and name: a step
 * name is unique only within a job, so `from` names the job when its step
 * name is used in more than one, and a reset never reaches a same-named step
 * of another job. Either way every record the run's abort settled without
 * starting (`settledByAbort`) is tracked when its own job still has the step;
 * it is not in the reset set but is reopened record by record
 * (`WorkflowRun.reopenAbortedWork`) before the reset set is applied. Returns
 * the reset set, or
 * throws a UserError that names the job or step when the run cannot be
 * resumed against the current workflow. Mutates nothing.
 *
 * Only for a failed run: a suspended run has no reset set, and its
 * unfinished steps would fail the retry eligibility check. See
 * {@link checkSuspendedRunResume}.
 *
 * The structure check refuses when:
 * - (a) a job of the current workflow has no stored record;
 * - (b) a re-entered job has a step, other than a forEach template, with no
 *   record in that stored job. This is conservative: it also checks a job
 *   whose trigger condition would skip it;
 * - (c) a record selected by name is not a step of its own job in the
 *   current workflow, or a record selected by `forEachTemplate` is not an
 *   iteration of a forEach step of its own job;
 * - (d) an unfinished job, or one holding work the abort left unfinished, is
 *   no longer in the workflow: it would be reopened but never walked, so the
 *   run could never finish.
 *
 * It leaves alone: records selected only by the legacy forEach prefix,
 * which can over-select; unfinished records that were not reset; forEach
 * templates with no records (an empty expansion removes the template
 * record); job and step names written with an expression, which are stored
 * evaluated and cannot be compared before evaluation; and terminal records
 * and finished jobs the workflow no longer has.
 */
export function planFailedRunResume(
  workflow: Workflow,
  run: WorkflowRun,
  from?: ResumeFrom,
): ResumeReset {
  const history = `See 'swamp workflow history logs ${run.id}'.`;
  const refuse = (problem: string) =>
    new UserError(`${problem} Start a new run. ${history}`);

  const pairs = pairExpressionJobs(workflow, run);
  const entries = from !== undefined
    ? [resolveFrom(workflow, from)]
    : selectRetryTemplates(workflow, run);

  // (a) Resume looks up a stored record for every job it walks. (d) It walks
  // only the workflow's jobs, so a removed job it reopens would stay pending.
  // Checked before the reset is selected, so a --from step in a job the run
  // does not have is refused for that, not as matching nothing.
  const noJob = missingJob(workflow, run) ??
    removedUnfinishedJob(workflow, run);
  if (noJob !== undefined) throw refuse(noJob);

  if (from !== undefined) {
    // A --from step moved into its job since the run left its records in the
    // job it came from, where nothing walks them.
    const problem = movedEntry(workflow, run, pairs, entries[0]);
    if (problem !== undefined) throw refuse(problem);
  }
  const keys = templatesToReset(workflow, entries);
  const unpaired = unpairedExpressionJob(workflow, pairs, keys);
  if (unpaired !== undefined) throw refuse(unpaired);
  // One pass over the union of the template sets selects the same records as
  // the union of computeStepsToReset per entry template, with one branch per
  // record.
  const selected = selectResetRecords(workflow, run, pairs, keys);
  if (selected.length === 0) {
    // A retry's entry templates always match their failed records.
    throw from !== undefined
      ? zeroStepsError(from.step)
      : new UserError(`Retry matched no persisted steps in run ${run.id}.`);
  }
  const steps = selected.map(({ jobName, stepName }) => ({
    jobName,
    stepName,
  }));
  // Work the run's abort settled without starting runs too, as on a
  // suspended-run resume: queued siblings of the entry step never ran. It is
  // reopened per record (WorkflowRun.reopenAbortedWork), so it is not in the
  // reset set; it is only tracked here.
  const reached = new Set(selected.map(stepRunKey));
  for (const jobRun of run.jobs) {
    for (const stepRun of jobRun.steps) {
      if (
        stepRun.settledByAbort &&
        !reached.has(
          stepRunKey({ jobName: jobRun.jobName, stepName: stepRun.stepName }),
        )
      ) {
        selected.push({
          jobName: jobRun.jobName,
          stepName: stepRun.stepName,
          forEachTemplate: stepRun.forEachTemplate,
          branch: "settled",
        });
      }
    }
  }

  const hasEvaluatedJob = workflow.jobs.some((j) => evaluated(j.name));

  // (c) A record reset by name or template must be walked in its own job.
  const tracked: StepRunRef[] = [];
  for (const record of selected) {
    if (record.branch === "prefix") continue;
    const ownJob = workflowJobOf(workflow, run.getJob(record.jobName)!, pairs);
    if (!ownJob && hasEvaluatedJob) continue;
    const ownStep = (name: string) => ownJob?.getStep(name);
    const fromTemplate = record.forEachTemplate !== undefined &&
      ownStep(record.forEachTemplate)?.forEach !== undefined;
    if (record.branch === "settled") {
      // A settled record its job no longer has by name or template (a step
      // removed since, or an iteration a resume added, which records no
      // template) is reset but not tracked, as a suspended-run resume
      // leaves it.
      if (!ownStep(record.stepName) && !fromTemplate) continue;
    } else if (record.branch === "name") {
      if (!ownStep(record.stepName) && !fromTemplate) {
        throw refuse(
          movedOrChanged(workflow, record.stepName, record.jobName),
        );
      }
    } else if (!fromTemplate) {
      throw refuse(
        movedOrChanged(workflow, record.forEachTemplate!, record.jobName),
      );
    }
    tracked.push({ jobName: record.jobName, stepName: record.stepName });
  }

  // (b) A job is re-entered when any of its records is reset, or when it
  // holds aborted work.
  const resetJobs = new Set(steps.map((ref) => ref.jobName));
  const noStep = missingStep(
    workflow,
    run,
    (jobRun) => !finishedJob(jobRun) || resetJobs.has(jobRun.jobName),
  );
  if (noStep !== undefined) throw refuse(noStep);

  return { steps, tracked };
}

/**
 * Checks, before anything changes, that a suspended run can be resumed
 * against the current workflow. Throws a UserError that says how to clear
 * the run, which stays suspended, then names the job or step. The way out
 * comes first so serve's 512-character error limit cuts the detail, not the
 * command. Mutates nothing.
 *
 * A suspended run has no reset set: resume re-enters every unfinished job.
 * A record the run's abort settled without starting counts as unfinished,
 * and so does its job, as does a job the abort ended `unknown` with an
 * undecided step: resume reopens them first
 * (`WorkflowRun.reopenAbortedWork`). The structure check refuses when:
 * - (a) a job of the current workflow has no stored record;
 * - (c) an unfinished record of an unfinished job is no longer a step of its
 *   own job (for an iteration, its `forEachTemplate` as a forEach step), and
 *   another job has the step with no record of it (a moved step), or its
 *   forEach step is no longer a forEach step;
 * - (d) an unfinished job is no longer in the workflow;
 * - (b) a re-entered job has a step, other than a forEach template, with no
 *   record in that stored job.
 *
 * It leaves alone: an unfinished record whose step no other job has, or one
 * another job already had (a removed step, which stays pending while the run
 * completes); a forEach step whose stored records cannot show whether another
 * job already had it; iterations whose template is still a forEach step of
 * their job, whatever the collection now evaluates to; records with no
 * `forEachTemplate`, from `--last-evaluated` or older runs, which match no
 * step by name; job and step names written with an expression; and finished
 * jobs, which resume does not walk. Unlike {@link planFailedRunResume}, it
 * lets through a step removed from one job but kept in another: nothing
 * resets a suspended run's record, so it was never going to run there.
 */
export function checkSuspendedRunResume(
  workflow: Workflow,
  run: WorkflowRun,
): void {
  const problem = missingJob(workflow, run) ??
    movedUnfinishedStep(workflow, run) ??
    removedUnfinishedJob(workflow, run) ??
    missingStep(
      workflow,
      run,
      (jobRun) => !finishedJob(jobRun),
    );
  if (problem !== undefined) {
    throw new UserError(
      `The workflow changed shape since the run started. ${
        suspendedWayOut(workflow, run)
      } ${problem}`,
    );
  }
}
