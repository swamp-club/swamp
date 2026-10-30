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
  jobRunsAfterFailure,
  runsAfterFailure,
  settleCancelledRun,
  shouldJobRun,
  shouldStepRun,
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

const arbCondition: fc.Arbitrary<TriggerCondition> = fc.letrec<
  { condition: TriggerCondition }
>((tie) => ({
  condition: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom(
      TriggerCondition.always(),
      TriggerCondition.succeeded(),
      TriggerCondition.failed(),
      TriggerCondition.completed(),
      TriggerCondition.skipped(),
    ),
    tie("condition").map((c) => TriggerCondition.not(c)),
    fc.array(tie("condition"), { minLength: 2, maxLength: 2 })
      .map((cs) => TriggerCondition.and(cs)),
    fc.array(tie("condition"), { minLength: 2, maxLength: 2 })
      .map((cs) => TriggerCondition.or(cs)),
  ),
})).condition;

type DependencyOutcome = "succeeded" | "failed" | "skipped";

/**
 * A job whose steps d0, d1... all ended `outcome`, and a step gated on them.
 * With `cleanupDeps` each is always-gated on a root step, so each is a cleanup
 * step; otherwise each is work.
 */
function gatedOnFinished(
  conditions: TriggerCondition[],
  outcome: DependencyOutcome,
  cleanupDeps: boolean,
) {
  const root = Step.create({ name: "root", task: StepTask.model("m", "run") });
  const deps = conditions.map((_, i) =>
    Step.create({
      name: `d${i}`,
      task: StepTask.model("m", "run"),
      dependsOn: cleanupDeps
        ? [{ step: "root", condition: TriggerCondition.always() }]
        : [],
    })
  );
  const gated = Step.create({
    name: "gated",
    task: StepTask.model("m", "run"),
    dependsOn: conditions.map((condition, i) => ({
      step: `d${i}`,
      condition,
    })),
  });
  const job = Job.create({ name: "main", steps: [root, ...deps, gated] });
  const workflow = Workflow.create({ name: "gated-wf", jobs: [job] });
  const jobRun = WorkflowRun.create(workflow).getJob("main")!;
  for (const dep of deps) {
    const record = jobRun.getStep(dep.name)!;
    if (outcome === "skipped") {
      record.skip({ kind: "dependency" });
      continue;
    }
    record.start();
    if (outcome === "succeeded") record.succeed();
    else record.fail("boom");
  }
  return { gated, job, jobRun };
}

const arbConditions = fc.array(arbCondition, { minLength: 1, maxLength: 3 });

Deno.test("runsAfterFailure: agrees with shouldStepRun on a job whose dependencies failed", () => {
  fc.assert(
    fc.property(arbConditions, fc.boolean(), (conditions, cleanupDeps) => {
      const { gated, job, jobRun } = gatedOnFinished(
        conditions,
        "failed",
        cleanupDeps,
      );
      assertEquals(
        runsAfterFailure(gated, job, jobRun),
        shouldStepRun(gated, jobRun),
      );
    }),
  );
});

Deno.test("runsAfterFailure: agrees with shouldStepRun when its dependencies are cleanup steps that ran", () => {
  fc.assert(
    fc.property(
      arbConditions,
      fc.constantFrom<DependencyOutcome>("succeeded", "failed"),
      (conditions, outcome) => {
        const { gated, job, jobRun } = gatedOnFinished(
          conditions,
          outcome,
          true,
        );
        assertEquals(
          runsAfterFailure(gated, job, jobRun),
          shouldStepRun(gated, jobRun),
        );
      },
    ),
  );
});

Deno.test("runsAfterFailure: a dependency that was skipped, or is work, answers as if it failed", () => {
  fc.assert(
    fc.property(
      arbConditions,
      fc.record({
        outcome: fc.constantFrom<DependencyOutcome>("succeeded", "skipped"),
        cleanupDeps: fc.boolean(),
      }).filter(({ outcome, cleanupDeps }) =>
        outcome === "skipped" || !cleanupDeps
      ),
      (conditions, { outcome, cleanupDeps }) => {
        const { gated, job, jobRun } = gatedOnFinished(
          conditions,
          outcome,
          cleanupDeps,
        );
        const failed = gatedOnFinished(conditions, "failed", cleanupDeps);
        assertEquals(
          runsAfterFailure(gated, job, jobRun),
          shouldStepRun(failed.gated, failed.jobRun),
        );
      },
    ),
  );
});

/**
 * Jobs d0, d1... that all ended `outcome`, and a job gated on them. With
 * `cleanupDeps` each is always-gated on a root job, so each is a cleanup job;
 * otherwise each is work.
 */
function jobGatedOnFinished(
  conditions: TriggerCondition[],
  outcome: "succeeded" | "failed",
  cleanupDeps: boolean,
) {
  const steps = () => [
    Step.create({ name: "s", task: StepTask.model("m", "run") }),
  ];
  const deps = conditions.map((_, i) =>
    Job.create({
      name: `d${i}`,
      steps: steps(),
      dependsOn: cleanupDeps
        ? [{ job: "root", condition: TriggerCondition.always() }]
        : [],
    })
  );
  const gated = Job.create({
    name: "gated",
    steps: steps(),
    dependsOn: conditions.map((condition, i) => ({
      job: `d${i}`,
      condition,
    })),
  });
  const workflow = Workflow.create({
    name: "job-gated-wf",
    jobs: [Job.create({ name: "root", steps: steps() }), ...deps, gated],
  });
  const run = WorkflowRun.create(workflow);
  for (const dep of deps) {
    const record = run.getJob(dep.name)!;
    record.start();
    if (outcome === "succeeded") record.succeed();
    else record.fail();
  }
  return { gated, workflow, run };
}

Deno.test("jobRunsAfterFailure: agrees with shouldJobRun on a run whose dependencies failed", () => {
  fc.assert(
    fc.property(arbConditions, fc.boolean(), (conditions, cleanupDeps) => {
      const { gated, workflow, run } = jobGatedOnFinished(
        conditions,
        "failed",
        cleanupDeps,
      );
      assertEquals(
        jobRunsAfterFailure(gated, workflow, run),
        shouldJobRun(gated, run),
      );
    }),
  );
});

Deno.test("jobRunsAfterFailure: agrees with shouldJobRun when its dependencies are cleanup jobs that ran", () => {
  fc.assert(
    fc.property(
      arbConditions,
      fc.constantFrom<"succeeded" | "failed">("succeeded", "failed"),
      (conditions, outcome) => {
        const { gated, workflow, run } = jobGatedOnFinished(
          conditions,
          outcome,
          true,
        );
        assertEquals(
          jobRunsAfterFailure(gated, workflow, run),
          shouldJobRun(gated, run),
        );
      },
    ),
  );
});

Deno.test("jobRunsAfterFailure: a work dependency that succeeded answers as if it failed", () => {
  fc.assert(
    fc.property(arbConditions, (conditions) => {
      const { gated, workflow, run } = jobGatedOnFinished(
        conditions,
        "succeeded",
        false,
      );
      const failed = jobGatedOnFinished(conditions, "failed", false);
      assertEquals(
        jobRunsAfterFailure(gated, workflow, run),
        shouldJobRun(failed.gated, failed.run),
      );
    }),
  );
});
