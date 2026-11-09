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
import { analyzeContentExpressions } from "../expressions/expression_references.ts";
import { selectRetryTemplates } from "./failed_step_retry.ts";
import {
  evaluatedName as evaluated,
  pairExpressionJobs,
  workflowJobOf,
} from "./job_pairing.ts";
import type { Job } from "./job.ts";
import { fanOutPlanMissing } from "./fan_out_job.ts";
import {
  laneRecords,
  laneStepOf,
  laneSucceeded,
  sameFanOutSelector,
} from "./fan_out_lanes.ts";
import { mergePlacementFields } from "./placement.ts";
import type { Workflow } from "./workflow.ts";
import {
  type JobRun,
  type StepRun,
  stepRunKey,
  type StepRunRef,
  type WorkflowRun,
} from "./workflow_run.ts";

type ResetBranch = "name" | "template" | "prefix" | "lane" | "settled";

interface SelectedRecord {
  readonly jobName: string;
  readonly stepName: string;
  readonly forEachTemplate: string | undefined;
  readonly branch: ResetBranch;
}

function authoredOf(jobRun: JobRun, stepName: string): string {
  return laneStepOf(stepName, jobRun.fanOutPlan?.lanes)?.authored ?? stepName;
}

export interface ResumeReset {
  readonly steps: readonly StepRunRef[];
  /**
   * records selected only by the legacy forEach prefix are not tracked, because
   * that match can over-select
   */
  readonly tracked: readonly StepRunRef[];
  readonly pairs: ReadonlyMap<string, string> | undefined;
}

const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "skipped",
  "unknown",
]);

function finishedRecord(record: StepRun): boolean {
  return FINISHED_STATUSES.has(record.status) && !record.settledByAbort;
}

function finishedJob(jobRun: JobRun): boolean {
  return FINISHED_STATUSES.has(jobRun.status) && !jobRun.holdsAbortedWork;
}

export interface ResumeFrom {
  readonly step: string;
  readonly job?: string;
}

const LISTED_JOBS = 3;

function jobList(names: readonly string[]): string {
  const listed = names.slice(0, LISTED_JOBS).map((n) => `"${n}"`).join(", ");
  const rest = names.length - LISTED_JOBS;
  return rest > 0 ? `${listed} and ${rest} more` : listed;
}

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

const STEP_PATH = /^jobs\[(\d+)\]\.steps\[(\d+)\]/;

function sharedNames(jobs: Iterable<readonly string[]>): Set<string> {
  const jobsWithName = new Map<string, number>();
  for (const names of jobs) {
    for (const name of new Set(names)) {
      jobsWithName.set(name, (jobsWithName.get(name) ?? 0) + 1);
    }
  }
  return new Set(
    [...jobsWithName].filter(([, n]) => n > 1).map(([name]) => name),
  );
}

/**
 * steps.* keys outputs by stored names and a resume fills it in stored job
 * order, so a re-run step could read another job's output
 */
function sharedStepRead(
  workflow: Workflow,
  run: WorkflowRun,
  rerunKeys: ReadonlySet<string>,
): string | undefined {
  const shared = new Set([
    ...sharedNames(workflow.jobs.map((j) => j.steps.map((s) => s.name))),
    ...sharedNames(run.jobs.map((j) => j.steps.map((s) => s.stepName))),
  ]);
  if (shared.size === 0) return undefined;
  // A workflow assert's bare predicate is evaluated without `${{ }}`.
  const asserts: { raw: string; celExpression: string; path: string }[] = [];
  workflow.jobs.forEach((job, j) =>
    job.steps.forEach((step, k) => {
      const task = step.task.data;
      if (task.type === "assert") {
        asserts.push({
          raw: task.expr,
          celExpression: task.expr,
          path: `jobs[${j}].steps[${k}].task.expr`,
        });
      }
    })
  );
  for (
    const { paths, references } of analyzeContentExpressions(
      workflow.toData(),
      asserts,
    )
  ) {
    const read = [...references.stepTargets].find((name) => shared.has(name));
    if (read === undefined && !references.stepsWide) continue;
    for (const path of paths) {
      const at = STEP_PATH.exec(path);
      if (!at) continue;
      const job = workflow.jobs[Number(at[1])];
      const step = job?.steps[Number(at[2])];
      if (
        !step ||
        !rerunKeys.has(stepRunKey({ jobName: job.name, stepName: step.name }))
      ) continue;
      return read !== undefined
        ? `Step "${step.name}" in job "${job.name}" reads steps.${read}, and a step named "${read}" is in more than one job, so re-running it could read another job's output.`
        : `Step "${step.name}" in job "${job.name}" reads the steps map by a computed key, and a step name is used in more than one job, so re-running it could read another job's output.`;
    }
  }
  return undefined;
}

/**
 * a lane that succeeded in a job the resume enters is kept; a downstream
 * fan-out job re-runs every lane, as a downstream plain job re-runs every step
 */
function keptLanes(jobRun: JobRun): ReadonlySet<string> {
  const lanes = jobRun.fanOutPlan?.lanes;
  if (lanes === undefined) return new Set();
  const kept = new Set<string>();
  for (const [worker, records] of laneRecords(jobRun.steps, lanes)) {
    if (laneSucceeded(records)) kept.add(worker);
  }
  return kept;
}

function selectResetRecords(
  workflow: Workflow,
  run: WorkflowRun,
  pairs: ReadonlyMap<string, string> | undefined,
  templateKeysToReset: ReadonlySet<string>,
  entryJobs: ReadonlySet<string>,
  // only an explicit --from asks an approved gate again
  resetGates: boolean,
): SelectedRecord[] {
  // a forEach template entry was replaced by expanded entries, so prefix
  // matching applies only to steps the definition declares with forEach
  const selected: SelectedRecord[] = [];
  for (const jobRun of run.jobs) {
    const job = workflowJobOf(workflow, jobRun, pairs);
    if (!job) continue;
    const kept = entryJobs.has(job.name) ? keptLanes(jobRun) : new Set();
    let laneRecordCount = 0;
    let lanesReset = 0;
    const gates: string[] = [];
    for (const stepRun of jobRun.steps) {
      const lane = laneStepOf(stepRun.stepName, jobRun.fanOutPlan?.lanes);
      if (lane !== undefined) {
        laneRecordCount++;
        if (
          !kept.has(lane.worker) &&
          templateKeysToReset.has(
            stepRunKey({ jobName: job.name, stepName: lane.authored }),
          )
        ) {
          lanesReset++;
          selected.push({
            jobName: jobRun.jobName,
            stepName: stepRun.stepName,
            forEachTemplate: undefined,
            branch: "lane",
          });
        }
        continue;
      }
      if (
        jobRun.fanOutGateKindOf(stepRun.stepName) !== undefined
      ) {
        gates.push(stepRun.stepName);
        continue;
      }
      const branch = matchRecord(job, stepRun);
      if (branch === undefined) continue;
      selected.push({
        jobName: jobRun.jobName,
        stepName: stepRun.stepName,
        forEachTemplate: stepRun.forEachTemplate,
        branch,
      });
    }
    // a gate is asked again only when the job runs again from its start
    if (resetGates && lanesReset > 0 && lanesReset === laneRecordCount) {
      for (const stepName of gates) {
        selected.push({
          jobName: jobRun.jobName,
          stepName,
          forEachTemplate: undefined,
          branch: "lane",
        });
      }
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
    // fallback for runs persisted before forEachTemplate was recorded; skip
    // names that are template names so 'read' does not match 'read-plate'
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

export function computeStepsToReset(
  workflow: Workflow,
  run: WorkflowRun,
  from: ResumeFrom,
): StepRunRef[] {
  const pairs = pairExpressionJobs(workflow, run);
  const entry = resolveFrom(workflow, from);
  const keys = templatesToReset(workflow, [entry]);
  const unpaired = unpairedExpressionJob(workflow, pairs, keys);
  if (unpaired !== undefined) {
    throw new UserError(`${unpaired} Start a new run.`);
  }
  const stepsToReset = selectResetRecords(
    workflow,
    run,
    pairs,
    keys,
    new Set([entry.jobName]),
    true,
  )
    .map(({ jobName, stepName }) => ({ jobName, stepName }));
  if (stepsToReset.length === 0) {
    throw zeroStepsError(from.step);
  }
  return stepsToReset;
}

function moved(step: string, stored: string, current: string): string {
  return `Step "${step}" is in job "${stored}" in the run, job "${current}" in the workflow.`;
}

function movedOrChanged(workflow: Workflow, step: string, job: string): string {
  const now = workflow.jobs.find((j) => j.steps.some((s) => s.name === step))
    ?.name;
  return now !== undefined && now !== job
    ? moved(step, job, now)
    : `Step "${step}" in job "${job}" is no longer a forEach step.`;
}

function movedEntry(
  workflow: Workflow,
  run: WorkflowRun,
  pairs: ReadonlyMap<string, string> | undefined,
  entry: StepRunRef,
): string | undefined {
  const name = entry.stepName;
  const holds = (jobRun: JobRun) =>
    jobRun.steps.some((s) =>
      authoredOf(jobRun, s.stepName) === name || s.forEachTemplate === name
    );
  const ownName = evaluated(entry.jobName)
    ? pairs?.get(entry.jobName)
    : entry.jobName;
  const own = ownName !== undefined ? run.getJob(ownName) : undefined;
  if (!own || holds(own)) return undefined;
  // iterations stored before forEachTemplate was recorded are named after the
  // entry step, as the legacy prefix match reads them: a record that is not
  // itself a step of the job
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

function missingJob(workflow: Workflow, run: WorkflowRun): string | undefined {
  const job = workflow.jobs.find((j) =>
    !evaluated(j.name) && !run.getJob(j.name)
  );
  return job ? `Job "${job.name}" is not in the run.` : undefined;
}

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
      if (
        jobRun.fanOutPlan !== undefined &&
        jobRun.steps.some((s) => authoredOf(jobRun, s.stepName) === step.name)
      ) continue;
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

function recordsStep(
  jobRun: JobRun | undefined,
  job: Job,
  name: string,
): boolean {
  if (!jobRun) return false;
  if (
    jobRun.steps.some((s) =>
      authoredOf(jobRun, s.stepName) === name || s.forEachTemplate === name
    )
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
      const name = template ?? authoredOf(jobRun, record.stepName);
      const own = ownJob?.getStep(name);
      if (own && (template === undefined || own.forEach !== undefined)) {
        continue;
      }
      if (own) {
        return `Step "${name}" in job "${jobRun.jobName}" is no longer a forEach step.`;
      }
      // step names are unique only within a job, so the step cannot have moved
      // into a job whose record already has one of that name; expression-named
      // jobs are stored evaluated and cannot be compared
      const now = workflow.jobs.find((j) =>
        !evaluated(j.name) && j.getStep(name) &&
        !recordsStep(run.getJob(j.name), j, name)
      );
      if (now) return moved(name, jobRun.jobName, now.name);
    }
  }
  return undefined;
}

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
 * a fan-out job never re-plans, so a resume refuses a run whose plan is gone or
 * whose workflow no longer selects the same workers
 */
function fanOutStructure(
  workflow: Workflow,
  run: WorkflowRun,
): string | undefined {
  for (const jobRun of run.jobs) {
    const job = workflow.getJob(jobRun.jobName);
    if (job === undefined) continue;
    const plan = jobRun.fanOutPlan;
    if (plan !== undefined && job.fanOut === undefined) {
      return `Job "${job.name}" ran as a fan-out job, and the workflow no longer sets fanOut on it.`;
    }
    if (plan === undefined) {
      if (fanOutPlanMissing(job, jobRun)) {
        return `Job "${job.name}" has fanOut but its run holds no fan-out plan: the plan was refused when the run reached the job, fanOut was added after the run began, or an older swamp dropped the plan when it saved the run. A fan-out job is never re-planned.`;
      }
      continue;
    }
    const recorded = jobRun.fanOutSnapshot?.selector;
    if (recorded === undefined) {
      return `Job "${job.name}" was planned by a swamp that did not record its worker selector, so an edited selector cannot be ruled out.`;
    }
    const fields = mergePlacementFields(
      workflow.placementFields,
      job.placementFields,
    );
    if (
      !sameFanOutSelector(recorded, {
        labels: fields?.labels,
        platform: fields?.platform,
      })
    ) {
      return `Fan-out job "${job.name}" selects different workers than when the run began: its labels or platform changed.`;
    }
  }
  return undefined;
}

// checked before recover resets anything, so a refusal leaves the record as it was
export function refuseFanOutRecover(
  workflow: Workflow,
  run: WorkflowRun,
): void {
  const problem = fanOutStructure(workflow, run);
  if (problem !== undefined) {
    throw new UserError(`${problem} Start a new run.`);
  }
}

export function suspendedWayOut(
  workflow: Workflow,
  run: WorkflowRun,
): string {
  return run.instanceId !== undefined
    ? `To cancel it: 'swamp workflow cancel --run ${run.id} --server <url>'.`
    : `To cancel it: 'swamp workflow cancel ${workflow.name} --run ${run.id}'.`;
}

export function planFailedRunResume(
  workflow: Workflow,
  run: WorkflowRun,
  from?: ResumeFrom,
): ResumeReset {
  const history = `See 'swamp workflow history logs ${run.id}'.`;
  const refuse = (problem: string) =>
    new UserError(`${problem} Start a new run. ${history}`);

  // first: without a plan a lane record reads as a step the workflow lacks
  const fanOut = fanOutStructure(workflow, run);
  if (fanOut !== undefined) throw refuse(fanOut);
  // a lane held by the rejection would otherwise start under a decided gate
  const rejectedGate = run.failedSteps().find((step) =>
    step.approvalRejected &&
    run.getJob(step.jobName)?.fanOutGateKindOf(step.stepName) !== undefined
  );
  if (rejectedGate !== undefined) {
    throw refuse(
      `Approval gate "${rejectedGate.stepName}" of fan-out job "${rejectedGate.jobName}" was rejected; neither a retry nor --from asks it again.`,
    );
  }

  const pairs = pairExpressionJobs(workflow, run);
  const entries = from !== undefined
    ? [resolveFrom(workflow, from)]
    : selectRetryTemplates(workflow, run);

  // checked before the reset is selected so a --from step in a job the run does
  // not have is refused for that, not as matching nothing
  const noJob = missingJob(workflow, run) ??
    removedUnfinishedJob(workflow, run);
  if (noJob !== undefined) throw refuse(noJob);

  if (from !== undefined) {
    const problem = movedEntry(workflow, run, pairs, entries[0]);
    if (problem !== undefined) throw refuse(problem);
  }
  const keys = templatesToReset(workflow, entries);
  const unpaired = unpairedExpressionJob(workflow, pairs, keys);
  if (unpaired !== undefined) throw refuse(unpaired);
  const selected = selectResetRecords(
    workflow,
    run,
    pairs,
    keys,
    new Set(entries.map((entry) => entry.jobName)),
    from !== undefined,
  );
  if (selected.length === 0) {
    throw from !== undefined
      ? zeroStepsError(from.step)
      : new UserError(`Retry matched no persisted steps in run ${run.id}.`);
  }
  const steps = selected.map(({ jobName, stepName }) => ({
    jobName,
    stepName,
  }));
  // work the abort settled without starting is reopened per record, so it is
  // tracked here but not in the reset set
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

  const rerun = new Set(keys);
  for (const record of selected) {
    if (record.branch !== "settled") continue;
    const jobRun = run.getJob(record.jobName)!;
    const job = workflowJobOf(workflow, jobRun, pairs);
    const template = record.forEachTemplate !== undefined &&
        job?.getStep(record.forEachTemplate)
      ? record.forEachTemplate
      : authoredOf(jobRun, record.stepName);
    if (job?.getStep(template)) {
      rerun.add(stepRunKey({ jobName: job.name, stepName: template }));
    }
  }
  const shared = sharedStepRead(workflow, run, rerun);
  if (shared !== undefined) throw refuse(shared);

  const hasEvaluatedJob = workflow.jobs.some((j) => evaluated(j.name));

  const tracked: StepRunRef[] = [];
  for (const record of selected) {
    if (record.branch === "prefix") continue;
    const jobRun = run.getJob(record.jobName)!;
    const ownJob = workflowJobOf(workflow, jobRun, pairs);
    if (!ownJob && hasEvaluatedJob) continue;
    const ownStep = (name: string) => ownJob?.getStep(name);
    const fromTemplate = record.forEachTemplate !== undefined &&
      ownStep(record.forEachTemplate)?.forEach !== undefined;
    if (record.branch === "settled") {
      // a settled record whose job lacks it by name or template is reset but
      // not tracked, as a suspended-run resume leaves it
      if (!ownStep(authoredOf(jobRun, record.stepName)) && !fromTemplate) {
        continue;
      }
    } else if (record.branch === "lane") {
      // selected through its authored step, which the workflow holds
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

  const resetJobs = new Set(steps.map((ref) => ref.jobName));
  const noStep = missingStep(
    workflow,
    run,
    (jobRun) => !finishedJob(jobRun) || resetJobs.has(jobRun.jobName),
  );
  if (noStep !== undefined) throw refuse(noStep);

  return { steps, tracked, pairs };
}

export function checkSuspendedRunResume(
  workflow: Workflow,
  run: WorkflowRun,
): void {
  const problem = fanOutStructure(workflow, run) ??
    missingJob(workflow, run) ??
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
