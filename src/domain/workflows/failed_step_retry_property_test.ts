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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { computeStepsToReset } from "./resume_reset.ts";
import { selectRetryTemplates } from "./failed_step_retry.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import { Workflow } from "./workflow.ts";
import { stepRunKey, type StepRunRef, WorkflowRun } from "./workflow_run.ts";

const MAX_JOBS = 4;
const MAX_STEPS = 3;

type TerminalStatus = "succeeded" | "failed" | "skipped";

interface GeneratedJob {
  name: string;
  /** Indices of earlier jobs this job depends on. */
  dependsOn: number[];
  steps: { name: string; dependsOn: number[]; status: TerminalStatus }[];
}

/**
 * Picks the earlier indices whose edge flag is set, so node `i` only depends
 * on nodes with a lower index and the graph is acyclic by construction.
 */
function earlierEdges(i: number, edges: boolean[]): number[] {
  return Array.from({ length: i }, (_, j) => j).filter((j) => edges[j]);
}

const arbStatus: fc.Arbitrary<TerminalStatus> = fc.constantFrom(
  "succeeded",
  "failed",
  "skipped",
);

// Step names are unique only within a job: with sharedNames every job names
// its steps step0, step1, ..., so the same name is reused across jobs.
const arbJobs: fc.Arbitrary<GeneratedJob[]> = fc
  .tuple(fc.integer({ min: 1, max: MAX_JOBS }), fc.boolean())
  .chain(([jobCount, sharedNames]) =>
    fc.tuple(
      ...Array.from({ length: jobCount }, (_, i) =>
        fc.record({
          jobEdges: fc.array(fc.boolean(), { minLength: i, maxLength: i }),
          steps: fc.integer({ min: 1, max: MAX_STEPS }).chain((stepCount) =>
            fc.tuple(
              ...Array.from({ length: stepCount }, (_, k) =>
                fc.record({
                  edges: fc.array(fc.boolean(), {
                    minLength: k,
                    maxLength: k,
                  }),
                  status: arbStatus,
                })),
            )
          ),
        }).map(({ jobEdges, steps }): GeneratedJob => ({
          name: `job${i}`,
          dependsOn: earlierEdges(i, jobEdges),
          steps: steps.map((s, k) => ({
            name: sharedNames ? `step${k}` : `job${i}-step${k}`,
            dependsOn: earlierEdges(k, s.edges),
            status: s.status,
          })),
        }))),
    )
  )
  // A failed run needs at least one failed step to be eligible.
  .filter((jobs) =>
    jobs.some((j) => j.steps.some((s) => s.status === "failed"))
  );

function buildWorkflow(jobs: GeneratedJob[]): Workflow {
  return Workflow.create({
    name: "property-wf",
    jobs: jobs.map((job) =>
      Job.create({
        name: job.name,
        dependsOn: job.dependsOn.map((d) => ({
          job: jobs[d].name,
          condition: TriggerCondition.succeeded(),
        })),
        steps: job.steps.map((step) =>
          Step.create({
            name: step.name,
            task: StepTask.model("test-model", "run"),
            dependsOn: step.dependsOn.map((d) => ({
              step: job.steps[d].name,
              condition: TriggerCondition.succeeded(),
            })),
          })
        ),
      })
    ),
  });
}

function buildFailedRun(workflow: Workflow, jobs: GeneratedJob[]): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  for (const job of jobs) {
    const jobRun = run.getJob(job.name)!;
    for (const step of job.steps) {
      const stepRun = jobRun.getStep(step.name)!;
      stepRun.start();
      if (step.status === "succeeded") stepRun.succeed({ from: step.name });
      if (step.status === "failed") stepRun.fail(`${step.name} failed`);
      if (step.status === "skipped") stepRun.skip({ kind: "dependency" });
    }
    if (job.steps.some((s) => s.status === "failed")) jobRun.fail();
    else jobRun.succeed();
  }
  run.complete();
  return run;
}

function keyOf(jobName: string, stepName: string): string {
  return stepRunKey({ jobName, stepName });
}

/**
 * Oracle: the failed steps and everything downstream of them, each keyed by
 * its job, following step dependencies within a job and job dependencies
 * across jobs.
 */
function expectedResetSet(jobs: GeneratedJob[]): Set<string> {
  const downstream = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => {
    if (!downstream.has(from)) downstream.set(from, new Set());
    downstream.get(from)!.add(to);
  };
  for (const job of jobs) {
    for (const step of job.steps) {
      for (const d of step.dependsOn) {
        edge(keyOf(job.name, job.steps[d].name), keyOf(job.name, step.name));
      }
    }
    for (const d of job.dependsOn) {
      for (const upstream of jobs[d].steps) {
        for (const step of job.steps) {
          edge(keyOf(jobs[d].name, upstream.name), keyOf(job.name, step.name));
        }
      }
    }
  }
  const result = new Set<string>();
  const queue = jobs.flatMap((j) =>
    j.steps.filter((s) => s.status === "failed").map((s) =>
      keyOf(j.name, s.name)
    )
  );
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (result.has(name)) continue;
    result.add(name);
    queue.push(...(downstream.get(name) ?? []));
  }
  return result;
}

/** The union of the records each retry entry resets, once each. */
function resetRefsFor(workflow: Workflow, run: WorkflowRun): StepRunRef[] {
  const union = new Map<string, StepRunRef>();
  for (const entry of selectRetryTemplates(workflow, run)) {
    const from = { step: entry.stepName, job: entry.jobName };
    for (const ref of computeStepsToReset(workflow, run, from)) {
      union.set(stepRunKey(ref), ref);
    }
  }
  return [...union.values()];
}

function resetSetFor(workflow: Workflow, run: WorkflowRun): Set<string> {
  return new Set(resetRefsFor(workflow, run).map(stepRunKey));
}

Deno.test("selectRetryTemplates: the reset set is exactly the failed steps and their dependents", () => {
  fc.assert(
    fc.property(arbJobs, (jobs) => {
      const workflow = buildWorkflow(jobs);
      const run = buildFailedRun(workflow, jobs);
      const actual = resetSetFor(workflow, run);
      assertEquals(
        [...actual].sort(),
        [...expectedResetSet(jobs)].sort(),
      );
      for (const failed of run.failedSteps()) {
        assert(actual.has(stepRunKey(failed)), `${failed.stepName} not reset`);
      }
    }),
  );
});

Deno.test("selectRetryTemplates: a reset leaves steps outside the set and their jobs unchanged", () => {
  fc.assert(
    fc.property(arbJobs, (jobs) => {
      const workflow = buildWorkflow(jobs);
      const run = buildFailedRun(workflow, jobs);
      const resetRefs = resetRefsFor(workflow, run);
      const resetSet = new Set(resetRefs.map(stepRunKey));
      const before = run.toData();

      run.resetForResumeFrom(resetRefs);
      const after = run.toData();

      for (const [j, jobBefore] of before.jobs.entries()) {
        const jobAfter = after.jobs[j];
        const reset = (stepName: string) =>
          resetSet.has(keyOf(jobBefore.jobName, stepName));
        const containsReset = jobBefore.steps.some((s) => reset(s.stepName));
        if (containsReset) {
          assertEquals(jobAfter.status, "pending");
        } else {
          assertEquals(jobAfter, jobBefore);
        }
        for (const [k, stepBefore] of jobBefore.steps.entries()) {
          const stepAfter = jobAfter.steps[k];
          if (reset(stepBefore.stepName)) {
            assertEquals(stepAfter.status, "pending");
            assertEquals(stepAfter.output, undefined);
            assertEquals(stepAfter.error, undefined);
          } else {
            assertEquals(stepAfter, stepBefore);
          }
        }
      }
    }),
  );
});

Deno.test("selectRetryTemplates: never mutates the run", () => {
  fc.assert(
    fc.property(arbJobs, (jobs) => {
      const workflow = buildWorkflow(jobs);
      const run = buildFailedRun(workflow, jobs);
      const before = JSON.stringify(run.toData());
      selectRetryTemplates(workflow, run);
      assertEquals(JSON.stringify(run.toData()), before);
    }),
  );
});
