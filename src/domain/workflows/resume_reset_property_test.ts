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

import { assert, assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import { UserError } from "../errors.ts";
import { Job } from "./job.ts";
import { selectRetryTemplates } from "./failed_step_retry.ts";
import {
  checkSuspendedRunResume,
  computeStepsToReset,
  planFailedRunResume,
} from "./resume_reset.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import { Workflow } from "./workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

/**
 * Step names chosen to overlap: a forEach 'build' prefix-matches the
 * iterations of 'build-docs' and a plain 'build-notify', within a job and
 * across jobs.
 */
const NAME_POOL = [
  "build",
  "build-docs",
  "build-notify",
  "deploy",
  "deploy-canary",
  "test",
  "test-unit",
  "lint",
];
const ITEMS = ["a", "b"];

type TerminalStatus = "succeeded" | "failed" | "skipped";

interface GeneratedStep {
  name: string;
  forEach: boolean;
  /** Index of an earlier step in the same job this step depends on. */
  dependsOn: number | undefined;
  /** One status per record: per iteration for a forEach step. */
  statuses: TerminalStatus[];
}

interface GeneratedJob {
  name: string;
  dependsOnPrevious: boolean;
  steps: GeneratedStep[];
}

const arbStatus: fc.Arbitrary<TerminalStatus> = fc.constantFrom(
  "succeeded",
  "failed",
  "skipped",
);

const arbJobs: fc.Arbitrary<GeneratedJob[]> = fc
  .shuffledSubarray(NAME_POOL, { minLength: 2, maxLength: NAME_POOL.length })
  .chain((names) =>
    fc.tuple(
      fc.integer({ min: 1, max: Math.min(3, names.length) }),
      fc.array(
        fc.record({
          forEach: fc.boolean(),
          dependsOnPrevious: fc.boolean(),
          statuses: fc.array(arbStatus, {
            minLength: ITEMS.length,
            maxLength: ITEMS.length,
          }),
        }),
        { minLength: names.length, maxLength: names.length },
      ),
      fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
    ).map(([jobCount, shapes, jobEdges]) => {
      const jobs: GeneratedJob[] = Array.from(
        { length: jobCount },
        (_, i) => ({
          name: `job${i}`,
          dependsOnPrevious: i > 0 && jobEdges[i],
          steps: [],
        }),
      );
      names.forEach((name, i) => {
        const job = jobs[i % jobCount];
        const shape = shapes[i];
        job.steps.push({
          name,
          forEach: shape.forEach,
          dependsOn: shape.dependsOnPrevious && job.steps.length > 0
            ? job.steps.length - 1
            : undefined,
          statuses: shape.forEach ? shape.statuses : [shape.statuses[0]],
        });
      });
      return jobs;
    })
  )
  .filter((jobs) =>
    jobs.some((j) => j.steps.some((s) => s.statuses.includes("failed")))
  );

function buildStep(step: GeneratedStep, job: GeneratedJob): Step {
  return Step.create({
    name: step.name,
    task: StepTask.model("test-model", "run"),
    forEach: step.forEach
      ? { item: "env", in: '${{ ["a", "b"] }}' }
      : undefined,
    dependsOn: step.dependsOn === undefined ? [] : [{
      step: job.steps[step.dependsOn].name,
      condition: TriggerCondition.succeeded(),
    }],
  });
}

function buildWorkflow(jobs: GeneratedJob[]): Workflow {
  return Workflow.create({
    name: "property-wf",
    jobs: jobs.map((job, i) =>
      Job.create({
        name: job.name,
        dependsOn: job.dependsOnPrevious
          ? [{
            job: jobs[i - 1].name,
            condition: TriggerCondition.succeeded(),
          }]
          : [],
        steps: job.steps.map((step) => buildStep(step, job)),
      })
    ),
  });
}

/** A finished run with every forEach step expanded to one record per item. */
function buildFailedRun(workflow: Workflow, jobs: GeneratedJob[]): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  for (const job of jobs) {
    const jobRun = run.getJob(job.name)!;
    let failed = false;
    for (const step of job.steps) {
      const records = step.forEach ? ITEMS.map((i) => `${step.name}-${i}`) : [
        step.name,
      ];
      if (step.forEach) jobRun.replaceExpandedSteps(step.name, records);
      records.forEach((record, k) => {
        const stepRun = jobRun.getStep(record)!;
        const status = step.statuses[k];
        if (status === "succeeded") stepRun.succeed();
        if (status === "failed") {
          stepRun.fail(`${record} failed`);
          failed = true;
        }
        if (status === "skipped") stepRun.skip({ kind: "dependency" });
      });
    }
    if (failed) jobRun.fail();
    else jobRun.succeed();
  }
  run.complete();
  return run;
}

const arbCase = arbJobs.chain((jobs) => {
  const templates = jobs.flatMap((j) => j.steps.map((s) => s.name));
  return fc.record({
    jobs: fc.constant(jobs),
    fromStep: fc.constantFrom(...templates),
  });
});

Deno.test("planFailedRunResume: never refuses a resume of an unchanged workflow", () => {
  fc.assert(
    fc.property(arbCase, ({ jobs, fromStep }) => {
      const workflow = buildWorkflow(jobs);
      const run = buildFailedRun(workflow, jobs);
      const plan = planFailedRunResume(workflow, run, fromStep);
      // Every tracked record is walked in its own job: by name, or as an
      // iteration of one of that job's forEach steps.
      for (const ref of plan.tracked) {
        assert(plan.steps.has(ref.stepName));
        const job = jobs.find((j) => j.name === ref.jobName)!;
        const record = run.getJob(ref.jobName)!.getStep(ref.stepName)!;
        assert(
          job.steps.some((s) =>
            s.name === ref.stepName ||
            (s.forEach && s.name === record.forEachTemplate)
          ),
          `${ref.jobName}/${ref.stepName} is not walked in its own job`,
        );
      }
      // A retry of the same run is never refused either, and its single pass
      // over every entry template selects exactly the per-template union.
      const retry = planFailedRunResume(workflow, run);
      const union = new Set<string>();
      for (const template of selectRetryTemplates(workflow, run)) {
        for (const name of computeStepsToReset(workflow, run, template)) {
          union.add(name);
        }
      }
      assertEquals(retry.steps, union);
    }),
  );
});

Deno.test("planFailedRunResume: always refuses when the --from step moved to another job", () => {
  fc.assert(
    fc.property(
      arbCase.filter(({ jobs }) => jobs.length > 1),
      fc.nat(),
      ({ jobs, fromStep }, target) => {
        const run = buildFailedRun(buildWorkflow(jobs), jobs);
        const from = jobs.findIndex((j) =>
          j.steps.some((s) => s.name === fromStep)
        );
        const others = jobs.map((_, i) => i).filter((i) =>
          i !== from && jobs[i].steps.length > 0
        );
        fc.pre(jobs[from].steps.length > 1 && others.length > 0);
        const to = others[target % others.length];
        const moved = jobs.map((job, i) => ({
          ...job,
          steps: job.steps
            .filter((s) => i !== from || s.name !== fromStep)
            .map((s) => ({ ...s, dependsOn: undefined })),
        }));
        const step = jobs[from].steps.find((s) => s.name === fromStep)!;
        moved[to].steps.push({ ...step, dependsOn: undefined });
        assertThrows(
          () => planFailedRunResume(buildWorkflow(moved), run, fromStep),
          UserError,
          "Start a new run.",
        );
      },
    ),
  );
});

Deno.test("planFailedRunResume: always refuses a renamed plain step in the job it re-enters", () => {
  fc.assert(
    fc.property(arbCase, ({ jobs, fromStep }) => {
      const run = buildFailedRun(buildWorkflow(jobs), jobs);
      const job = jobs.find((j) => j.steps.some((s) => s.name === fromStep))!;
      const victim = job.steps.find((s) => s.name !== fromStep && !s.forEach);
      fc.pre(victim !== undefined);
      const renamed = jobs.map((j) => ({
        ...j,
        steps: j.steps.map((s) =>
          s === victim ? { ...s, name: `${s.name}-renamed` } : s
        ).map((s) => ({ ...s, dependsOn: undefined })),
      }));
      assertThrows(
        () => planFailedRunResume(buildWorkflow(renamed), run, fromStep),
        UserError,
        `Step "${
          victim!.name
        }-renamed" in job "${job.name}" is not in the run.`,
      );
    }),
  );
});

interface SuspendedCase {
  jobs: GeneratedJob[];
  /** The job suspended at a gate: earlier jobs finished, later ones pending. */
  gateJob: number;
  /** Steps of the gate job before this index finished; the rest are pending. */
  gateStep: number;
}

/**
 * Jobs from {@link arbJobs}, sometimes with a step name repeated in another
 * job (names are unique only within a job), and where the run suspended.
 */
const arbSuspendedCase: fc.Arbitrary<SuspendedCase> = fc
  .tuple(
    arbJobs,
    fc.nat(),
    fc.nat(),
    fc.option(fc.tuple(fc.nat(), fc.nat())),
  )
  .map(([generated, gateJob, gateStep, duplicate]) => {
    const jobs = generated.map((j) => ({ ...j, steps: [...j.steps] }));
    if (duplicate && jobs.length > 1) {
      const all = jobs.flatMap((j) => j.steps);
      const source = all[duplicate[0] % all.length];
      const target = jobs[duplicate[1] % jobs.length];
      if (!target.steps.some((s) => s.name === source.name)) {
        target.steps.push({ ...source, dependsOn: undefined });
      }
    }
    const gate = gateJob % jobs.length;
    return {
      jobs,
      gateJob: gate,
      gateStep: gateStep % (jobs[gate].steps.length + 1),
    };
  });

/**
 * A run suspended in job `gateJob`: earlier jobs succeeded, that job's steps
 * before `gateStep` succeeded and the rest are pending, and later jobs are
 * pending. A job expands its forEach steps when it starts.
 */
function buildSuspendedRun(workflow: Workflow, c: SuspendedCase): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  c.jobs.forEach((job, i) => {
    if (i > c.gateJob) return;
    const jobRun = run.getJob(job.name)!;
    jobRun.start();
    job.steps.forEach((step, k) => {
      const records = step.forEach
        ? ITEMS.map((item) => `${step.name}-${item}`)
        : [step.name];
      if (step.forEach) jobRun.replaceExpandedSteps(step.name, records);
      if (i < c.gateJob || k < c.gateStep) {
        for (const record of records) jobRun.getStep(record)!.succeed();
      }
    });
    if (i < c.gateJob) jobRun.succeed();
  });
  run.suspend();
  return run;
}

/** Steps with unfinished records: from the gate on, and in later jobs. */
function unfinishedSteps(c: SuspendedCase): { job: number; name: string }[] {
  return c.jobs.flatMap((job, i) =>
    i < c.gateJob ? [] : job.steps
      .filter((_, k) => i > c.gateJob || k >= c.gateStep)
      .map((s) => ({ job: i, name: s.name }))
  );
}

/** `jobs` with every step-level dependency dropped, so edits stay valid. */
function independent(jobs: GeneratedJob[]): GeneratedJob[] {
  return jobs.map((j) => ({
    ...j,
    steps: j.steps.map((s) => ({ ...s, dependsOn: undefined })),
  }));
}

Deno.test("checkSuspendedRunResume: never refuses a resume of an unchanged workflow", () => {
  fc.assert(
    fc.property(arbSuspendedCase, (c) => {
      const workflow = buildWorkflow(c.jobs);
      checkSuspendedRunResume(workflow, buildSuspendedRun(workflow, c));
    }),
  );
});

Deno.test("checkSuspendedRunResume: never refuses a removed unfinished step, even when another job keeps its name", () => {
  fc.assert(
    fc.property(arbSuspendedCase, fc.nat(), (c, pick) => {
      const run = buildSuspendedRun(buildWorkflow(c.jobs), c);
      const candidates = unfinishedSteps(c).filter((s) =>
        c.jobs[s.job].steps.length > 1
      );
      fc.pre(candidates.length > 0);
      const victim = candidates[pick % candidates.length];
      const removed = independent(c.jobs).map((job, i) => ({
        ...job,
        steps: job.steps.filter((s) =>
          i !== victim.job || s.name !== victim.name
        ),
      }));
      checkSuspendedRunResume(buildWorkflow(removed), run);
    }),
  );
});

Deno.test("checkSuspendedRunResume: always refuses an unfinished step moved to a job without one of that name", () => {
  fc.assert(
    fc.property(arbSuspendedCase, fc.nat(), fc.nat(), (c, pick, target) => {
      const run = buildSuspendedRun(buildWorkflow(c.jobs), c);
      const candidates = unfinishedSteps(c).filter((s) =>
        c.jobs[s.job].steps.length > 1
      );
      fc.pre(candidates.length > 0);
      const victim = candidates[pick % candidates.length];
      const step = c.jobs[victim.job].steps.find((s) =>
        s.name === victim.name
      )!;
      // A job that has started may hold no record of a forEach step it
      // already had, so the check lets a forEach step moved there through.
      const others = c.jobs.map((_, i) => i).filter((i) =>
        i !== victim.job &&
        !c.jobs[i].steps.some((s) => s.name === victim.name) &&
        (!step.forEach || i > c.gateJob)
      );
      fc.pre(others.length > 0);
      const to = others[target % others.length];
      const moved = independent(c.jobs).map((job, i) => ({
        ...job,
        steps: job.steps.filter((s) =>
          i !== victim.job || s.name !== victim.name
        ),
      }));
      moved[to].steps.push({ ...step, dependsOn: undefined });
      assertThrows(
        () => checkSuspendedRunResume(buildWorkflow(moved), run),
        UserError,
        "To cancel it: 'swamp workflow cancel property-wf",
      );
    }),
  );
});
