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
import {
  cancelAndSettle,
  completeAndSettle,
  settleCancelledRun,
} from "./abort_settlement.ts";
import { Workflow } from "./workflow.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import { type StepRun, WorkflowRun } from "./workflow_run.ts";

const CONDITIONS = [
  TriggerCondition.succeeded,
  TriggerCondition.failed,
  TriggerCondition.completed,
  TriggerCondition.always,
];

type StepState =
  | "pending"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "skipped";

const arbStepSpec = fc.record({
  gate: fc.boolean(),
  guarded: fc.boolean(),
  forEach: fc.boolean(),
  /** Index of an earlier step it depends on, if any (modulo position). */
  dependsOn: fc.option(fc.nat(), { nil: undefined }),
  condition: fc.nat({ max: CONDITIONS.length - 1 }),
  /** States of the step's record, or of each forEach iteration. */
  states: fc.array(
    fc.constantFrom<StepState>(
      "pending",
      "running",
      "waiting_approval",
      "succeeded",
      "failed",
      "skipped",
    ),
    { minLength: 1, maxLength: 2 },
  ),
  /** Whether a forEach step's record was replaced by its iterations. */
  expanded: fc.boolean(),
});

const arbJobSpec = fc.record({
  steps: fc.array(arbStepSpec, { minLength: 1, maxLength: 3 }),
  dependsOn: fc.option(fc.nat(), { nil: undefined }),
  condition: fc.nat({ max: CONDITIONS.length - 1 }),
  /** pending: never started (or reopened); running: started. */
  running: fc.boolean(),
});

const arbScenario = fc.record({
  jobs: fc.array(arbJobSpec, { minLength: 1, maxLength: 4 }),
  suspended: fc.boolean(),
  /** The definition settled against: the run's, one missing a job, none. */
  definition: fc.constantFrom("same", "drop-first-job", "none"),
});

type Scenario = typeof arbScenario extends fc.Arbitrary<infer T> ? T : never;

function buildWorkflow(scenario: Scenario): Workflow {
  return Workflow.create({
    name: "prop-wf",
    jobs: scenario.jobs.map((jobSpec, j) =>
      Job.create({
        name: `j${j}`,
        dependsOn: j > 0 && jobSpec.dependsOn !== undefined
          ? [{
            job: `j${jobSpec.dependsOn % j}`,
            condition: CONDITIONS[jobSpec.condition](),
          }]
          : [],
        steps: jobSpec.steps.map((stepSpec, i) =>
          Step.create({
            name: `s${i}`,
            task: stepSpec.gate
              ? StepTask.manualApproval("go?")
              : StepTask.model("m", "run"),
            guard: stepSpec.guarded && !stepSpec.gate
              ? "${{ true }}"
              : undefined,
            forEach: stepSpec.forEach && !stepSpec.gate
              ? { item: "x", in: "${{ [1, 2] }}" }
              : undefined,
            dependsOn: i > 0 && stepSpec.dependsOn !== undefined
              ? [{
                step: `s${stepSpec.dependsOn % i}`,
                condition: CONDITIONS[stepSpec.condition](),
              }]
              : [],
          })
        ),
      })
    ),
  });
}

function setState(step: StepRun, state: StepState): void {
  switch (state) {
    case "pending":
      return;
    case "running":
      step.start();
      return;
    case "waiting_approval":
      step.waitForApproval("go?");
      return;
    case "succeeded":
      step.succeed();
      return;
    case "failed":
      step.fail("boom");
      return;
    case "skipped":
      step.skip({ kind: "dependency" });
      return;
  }
}

/** The stored run: as a suspension, a dead owner or a reopen left it. */
function buildRun(workflow: Workflow, scenario: Scenario): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start(12345);
  scenario.jobs.forEach((jobSpec, j) => {
    const jobRun = run.getJob(`j${j}`)!;
    if (jobSpec.running) jobRun.start();
    jobSpec.steps.forEach((stepSpec, i) => {
      const name = `s${i}`;
      const isForEach = stepSpec.forEach && !stepSpec.gate;
      // A pending job holds only what a reopen leaves: pending or finished.
      const states = stepSpec.states.map((state) =>
        !jobSpec.running &&
          (state === "running" || state === "waiting_approval")
          ? "pending"
          : state
      );
      if (isForEach && stepSpec.expanded) {
        const names = states.map((_, k) => `${name}-${k}`);
        jobRun.replaceExpandedSteps(name, names);
        names.forEach((iteration, k) =>
          setState(jobRun.getStep(iteration)!, states[k])
        );
      } else {
        setState(jobRun.getStep(name)!, states[0]);
      }
    });
  });
  if (scenario.suspended) run.suspend();
  return WorkflowRun.fromData(run.toData());
}

function settlementDefinition(
  workflow: Workflow,
  scenario: Scenario,
): Workflow | undefined {
  if (scenario.definition === "none") return undefined;
  if (scenario.definition === "same" || workflow.jobs.length === 1) {
    return workflow;
  }
  return Workflow.create({
    id: workflow.id,
    name: workflow.name,
    // Dropping the first job also drops every dependsOn naming it.
    jobs: workflow.jobs.slice(1).map((job) =>
      Job.create({
        name: job.name,
        steps: [...job.steps],
        dependsOn: job.dependsOn.filter((d) => d.job !== "j0"),
      })
    ),
  });
}

/** The definition step a record stands for, by name or forEach template. */
function definedStep(
  definition: Workflow | undefined,
  jobName: string,
  step: StepRun,
): Step | undefined {
  const job = definition?.getJob(jobName);
  return job?.getStep(step.forEachTemplate ?? step.stepName);
}

Deno.test("cancelAndSettle: a cancelled run holds no unfinished work but undecided guarded steps", () => {
  fc.assert(
    fc.property(arbScenario, (scenario) => {
      const workflow = buildWorkflow(scenario);
      const run = buildRun(workflow, scenario);
      const definition = settlementDefinition(workflow, scenario);

      cancelAndSettle(run, definition, "cancelled");

      assertEquals(run.status, "cancelled");
      for (const jobRun of run.jobs) {
        assert(jobRun.status !== "running", `${jobRun.jobName} running`);
        for (const step of jobRun.steps) {
          assert(
            step.status !== "running" && step.status !== "waiting_approval",
            `${jobRun.jobName}/${step.stepName} ${step.status}`,
          );
          if (step.status === "pending") {
            assert(
              definedStep(definition, jobRun.jobName, step)?.guard !==
                undefined,
              `${jobRun.jobName}/${step.stepName} pending but not guarded`,
            );
          }
        }
        if (jobRun.status === "pending" || jobRun.status === "unknown") {
          assert(
            jobRun.steps.some((step) => step.status === "pending"),
            `${jobRun.jobName} ${jobRun.status} with every step finished`,
          );
        }
      }
    }),
  );
});

Deno.test("completeAndSettle: a run failed by a rejected gate holds no running job and no waiting gate", () => {
  fc.assert(
    fc.property(arbScenario, (scenario) => {
      const workflow = buildWorkflow(scenario);
      const run = buildRun(workflow, scenario);
      const definition = settlementDefinition(workflow, scenario);
      const gate = run.jobs.flatMap((jobRun) => jobRun.steps).find((step) =>
        step.status === "waiting_approval"
      );
      fc.pre(gate !== undefined);

      gate!.fail("Approval rejected");
      completeAndSettle(run, definition);

      assertEquals(run.status, "failed");
      assertEquals(gate!.error, "Approval rejected");
      assertEquals(gate!.settledByAbort, false);
      for (const jobRun of run.jobs) {
        assert(jobRun.status !== "running", `${jobRun.jobName} running`);
        for (const step of jobRun.steps) {
          assert(
            step.status !== "running" && step.status !== "waiting_approval",
            `${jobRun.jobName}/${step.stepName} ${step.status}`,
          );
        }
      }
    }),
  );
});

Deno.test("settleCancelledRun: settling a second time changes nothing", () => {
  fc.assert(
    fc.property(arbScenario, (scenario) => {
      const workflow = buildWorkflow(scenario);
      const run = buildRun(workflow, scenario);
      const definition = settlementDefinition(workflow, scenario);

      settleCancelledRun(run, definition);
      const once = run.toData();
      const reloaded = WorkflowRun.fromData(once);
      settleCancelledRun(reloaded, definition);

      assertEquals(reloaded.toData(), once);
    }),
  );
});
