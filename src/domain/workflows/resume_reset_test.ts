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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { UserError } from "../errors.ts";
import { Job } from "./job.ts";
import { planFailedRunResume } from "./resume_reset.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import { Workflow } from "./workflow.ts";
import { type StepRunRef, WorkflowRun } from "./workflow_run.ts";

const MAX_CLIENT_ERROR_LENGTH = 200;
const ABSOLUTE_PATH = /(?:^|[\s"'`(])\/[a-z]/i;

function plain(name: string, dependsOn: string[] = []): Step {
  return Step.create({
    name,
    task: StepTask.model("test-model", "run"),
    dependsOn: dependsOn.map((dep) => ({
      step: dep,
      condition: TriggerCondition.succeeded(),
    })),
  });
}

function each(name: string, dependsOn: string[] = []): Step {
  return Step.create({
    name,
    task: StepTask.model("test-model", "run"),
    forEach: { item: "env", in: "${{ inputs.envs }}" },
    dependsOn: dependsOn.map((dep) => ({
      step: dep,
      condition: TriggerCondition.succeeded(),
    })),
  });
}

interface JobSpec {
  name: string;
  steps: Step[];
  dependsOn?: string[];
  condition?: TriggerCondition;
}

function workflow(jobs: JobSpec[]): Workflow {
  return Workflow.create({
    name: "resume-wf",
    jobs: jobs.map((j) =>
      Job.create({
        name: j.name,
        steps: j.steps,
        dependsOn: (j.dependsOn ?? []).map((job) => ({
          job,
          condition: j.condition ?? TriggerCondition.succeeded(),
        })),
      })
    ),
  });
}

/**
 * Finishes a run created from `wf`: every step named in `failed` fails, every
 * other step succeeds, and a job fails when one of its steps did.
 */
function failedRun(wf: Workflow, failed: string[]): WorkflowRun {
  const run = WorkflowRun.create(wf);
  run.start();
  for (const job of run.jobs) {
    let jobFailed = false;
    for (const step of job.steps) {
      if (failed.includes(step.stepName)) {
        step.fail(`${step.stepName} failed`);
        jobFailed = true;
      } else {
        step.succeed();
      }
    }
    if (jobFailed) job.fail();
    else job.succeed();
  }
  run.complete();
  return run;
}

function refusal(wf: Workflow, run: WorkflowRun, fromStep?: string): string {
  const before = JSON.stringify(run.toData());
  try {
    planFailedRunResume(wf, run, fromStep);
  } catch (error) {
    assert(error instanceof UserError, `expected UserError, got ${error}`);
    assertEquals(JSON.stringify(run.toData()), before, "run was mutated");
    assert(
      error.message.length <= MAX_CLIENT_ERROR_LENGTH,
      `message is ${error.message.length} characters: ${error.message}`,
    );
    assert(!ABSOLUTE_PATH.test(error.message), error.message);
    assertStringIncludes(error.message, "Start a new run.");
    assertStringIncludes(
      error.message,
      `swamp workflow history logs ${run.id}`,
    );
    return error.message;
  }
  throw new Error("expected planFailedRunResume to refuse");
}

function sortRefs(refs: readonly StepRunRef[]): string[] {
  return refs.map((r) => `${r.jobName}/${r.stepName}`).sort();
}

/** build: compile → test (fails); release (depends on build): publish. */
function movedBefore(): Workflow {
  return workflow([
    { name: "build", steps: [plain("compile"), plain("test", ["compile"])] },
    { name: "release", steps: [plain("publish")], dependsOn: ["build"] },
  ]);
}

function movedRun(): WorkflowRun {
  const run = WorkflowRun.create(movedBefore());
  run.start();
  const build = run.getJob("build")!;
  build.getStep("compile")!.succeed();
  build.getStep("test")!.fail("exit 1");
  build.fail();
  run.getJob("release")!.skip();
  run.complete();
  return run;
}

Deno.test("planFailedRunResume: resets the step and its dependents of an unchanged workflow", () => {
  const wf = movedBefore();
  const plan = planFailedRunResume(wf, movedRun(), "test");
  assertEquals(plan.steps, new Set(["test", "publish"]));
  assertEquals(sortRefs(plan.tracked), ["build/test", "release/publish"]);
});

Deno.test("planFailedRunResume: refuses a --from step moved to a job nothing re-enters", () => {
  const moved = workflow([
    { name: "build", steps: [plain("compile")] },
    {
      name: "release",
      steps: [plain("publish"), plain("test")],
      dependsOn: ["build"],
    },
  ]);
  assertStringIncludes(
    refusal(moved, movedRun(), "test"),
    `Step "test" is in job "build" in the run, job "release" in the workflow.`,
  );
});

Deno.test("planFailedRunResume: refuses a --from step moved next to a step that depends on it", () => {
  const moved = workflow([
    { name: "build", steps: [plain("compile")] },
    {
      name: "release",
      steps: [plain("test"), plain("publish", ["test"])],
      dependsOn: ["build"],
    },
  ]);
  assertStringIncludes(
    refusal(moved, movedRun(), "test"),
    `Step "test" is in job "build" in the run, job "release" in the workflow.`,
  );
});

Deno.test("planFailedRunResume: refuses a renamed --from step", () => {
  const before = workflow([
    { name: "main", steps: [plain("a"), plain("b", ["a"]), plain("c", ["b"])] },
  ]);
  const run = failedRun(before, ["b"]);
  const renamed = workflow([
    {
      name: "main",
      steps: [plain("a"), plain("b2", ["a"]), plain("c", ["b2"])],
    },
  ]);
  assertStringIncludes(
    refusal(renamed, run, "b2"),
    `Step "b2" in job "main" is not in the run.`,
  );
});

Deno.test("planFailedRunResume: a retry refuses a step added to a job it re-enters", () => {
  const before = workflow([
    { name: "main", steps: [plain("a"), plain("b", ["a"])] },
  ]);
  const run = failedRun(before, ["b"]);
  const added = workflow([
    { name: "main", steps: [plain("a"), plain("b", ["a"]), plain("lint")] },
  ]);
  assertStringIncludes(
    refusal(added, run),
    `Step "lint" in job "main" is not in the run.`,
  );
});

Deno.test("planFailedRunResume: a retry refuses a renamed dependent of the failed step", () => {
  const before = workflow([
    { name: "main", steps: [plain("a"), plain("b", ["a"]), plain("c", ["b"])] },
  ]);
  const run = failedRun(before, ["b"]);
  const renamed = workflow([
    {
      name: "main",
      steps: [plain("a"), plain("b", ["a"]), plain("c2", ["b"])],
    },
  ]);
  assertStringIncludes(
    refusal(renamed, run),
    `Step "c2" in job "main" is not in the run.`,
  );
});

Deno.test("planFailedRunResume: refuses a renamed job before anything is reset", () => {
  const before = workflow([
    { name: "build", steps: [plain("compile")] },
    { name: "release", steps: [plain("publish")], dependsOn: ["build"] },
  ]);
  const run = failedRun(before, ["compile"]);
  const renamed = workflow([
    { name: "build2", steps: [plain("compile")] },
    { name: "release", steps: [plain("publish")], dependsOn: ["build2"] },
  ]);
  assertStringIncludes(
    refusal(renamed, run, "compile"),
    `Job "build2" is not in the run.`,
  );
});

Deno.test("planFailedRunResume: names the stored job of a step moved into a re-entered job", () => {
  // The moved record is not reset (nothing upstream of it is), so only the
  // walk of the job it moved into can find it missing.
  const before = workflow([
    { name: "build", steps: [plain("compile")] },
    { name: "docs", steps: [plain("render"), plain("index")] },
  ]);
  const run = failedRun(before, ["compile"]);
  const moved = workflow([
    { name: "build", steps: [plain("compile"), plain("render")] },
    { name: "docs", steps: [plain("index")] },
  ]);
  assertStringIncludes(
    refusal(moved, run, "compile"),
    `Step "render" is in job "docs" in the run, job "build" in the workflow.`,
  );
});

Deno.test("planFailedRunResume: allows a step added to a job it does not re-enter", () => {
  const before = workflow([
    { name: "build", steps: [plain("compile")] },
    { name: "docs", steps: [plain("render")] },
  ]);
  const run = failedRun(before, ["compile"]);
  const added = workflow([
    { name: "build", steps: [plain("compile")] },
    { name: "docs", steps: [plain("render"), plain("spell")] },
  ]);
  assertEquals(
    planFailedRunResume(added, run, "compile").steps,
    new Set(["compile"]),
  );
});

Deno.test("planFailedRunResume: conservatively refuses an added step in a re-entered job its condition would skip", () => {
  const before = workflow([
    { name: "main", steps: [plain("b")] },
    {
      name: "on-failure",
      steps: [plain("alert")],
      dependsOn: ["main"],
      condition: TriggerCondition.failed(),
    },
  ]);
  const run = failedRun(before, ["b"]);
  const added = workflow([
    { name: "main", steps: [plain("b")] },
    {
      name: "on-failure",
      steps: [plain("alert"), plain("page")],
      dependsOn: ["main"],
      condition: TriggerCondition.failed(),
    },
  ]);
  assertStringIncludes(
    refusal(added, run, "b"),
    `Step "page" in job "on-failure" is not in the run.`,
  );
});

Deno.test("planFailedRunResume: allows removing a step upstream of the --from step", () => {
  const before = workflow([
    { name: "main", steps: [plain("a"), plain("b", ["a"]), plain("c", ["b"])] },
  ]);
  const run = failedRun(before, ["b"]);
  const removed = workflow([
    { name: "main", steps: [plain("b"), plain("c", ["b"])] },
  ]);
  const plan = planFailedRunResume(removed, run, "b");
  assertEquals(plan.steps, new Set(["b", "c"]));
  assertEquals(sortRefs(plan.tracked), ["main/b", "main/c"]);
});

Deno.test("planFailedRunResume: allows removing a step downstream of the --from step", () => {
  const before = workflow([
    { name: "main", steps: [plain("a"), plain("b", ["a"]), plain("c", ["b"])] },
  ]);
  const run = failedRun(before, ["b"]);
  const removed = workflow([
    { name: "main", steps: [plain("a"), plain("b", ["a"])] },
  ]);
  assertEquals(planFailedRunResume(removed, run, "b").steps, new Set(["b"]));
});

Deno.test("planFailedRunResume: tracks the iterations of a reset forEach template", () => {
  const wf = workflow([{ name: "deploy", steps: [each("push")] }]);
  const run = WorkflowRun.create(wf);
  const job = run.getJob("deploy")!;
  job.replaceExpandedSteps("push", ["push-dev", "push-qa"]);
  job.getStep("push-dev")!.succeed();
  job.getStep("push-qa")!.fail("qa");
  job.fail();
  run.complete();
  const plan = planFailedRunResume(wf, run);
  assertEquals(plan.steps, new Set(["push-dev", "push-qa"]));
  assertEquals(sortRefs(plan.tracked), ["deploy/push-dev", "deploy/push-qa"]);
});

Deno.test("planFailedRunResume: resets legacy forEach records by prefix without tracking them", () => {
  const wf = workflow([{ name: "deploy", steps: [each("push")] }]);
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: wf.id,
    workflowName: wf.name,
    status: "failed",
    jobs: [{
      jobName: "deploy",
      status: "failed",
      steps: [
        { stepName: "push-dev", status: "succeeded" },
        { stepName: "push-qa", status: "failed" },
      ],
    }],
  });
  const plan = planFailedRunResume(wf, run, "push");
  assertEquals(plan.steps, new Set(["push-dev", "push-qa"]));
  assertEquals(plan.tracked, []);
});

Deno.test("planFailedRunResume: allows evaluated records of an expression-named forEach template", () => {
  // A run started with --last-evaluated stores concrete iteration names and
  // no forEachTemplate. They are neither reset nor checked.
  const template = "deploy-${{ self.env }}";
  const wf = workflow([
    { name: "main", steps: [plain("prep"), each(template)] },
  ]);
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: wf.id,
    workflowName: wf.name,
    status: "failed",
    jobs: [{
      jobName: "main",
      status: "failed",
      steps: [
        { stepName: "prep", status: "failed" },
        { stepName: "deploy-prod", status: "skipped" },
      ],
    }],
  });
  const plan = planFailedRunResume(wf, run, "prep");
  assertEquals(plan.steps, new Set(["prep"]));
});

Deno.test("planFailedRunResume: ignores a prefix over-selection across jobs", () => {
  const wf = workflow([
    { name: "a", steps: [each("build")] },
    { name: "b", steps: [each("build-docs")] },
  ]);
  const run = WorkflowRun.create(wf);
  run.getJob("a")!.replaceExpandedSteps("build", ["build-x"]);
  run.getJob("a")!.getStep("build-x")!.fail("x");
  run.getJob("a")!.fail();
  run.getJob("b")!.replaceExpandedSteps("build-docs", ["build-docs-y"]);
  run.getJob("b")!.getStep("build-docs-y")!.succeed();
  run.getJob("b")!.succeed();
  run.complete();
  const plan = planFailedRunResume(wf, run);
  assertEquals(plan.steps, new Set(["build-x", "build-docs-y"]));
  assertEquals(sortRefs(plan.tracked), ["a/build-x"]);
});

Deno.test("planFailedRunResume: allows removing a forEach step that shares a prefix with a reset one", () => {
  const before = workflow([
    { name: "j", steps: [each("deploy"), each("deploy-canary")] },
  ]);
  const run = WorkflowRun.create(before);
  const job = run.getJob("j")!;
  job.replaceExpandedSteps("deploy", ["deploy-a"]);
  job.replaceExpandedSteps("deploy-canary", ["deploy-canary-x"]);
  job.getStep("deploy-a")!.fail("a");
  job.getStep("deploy-canary-x")!.succeed();
  job.fail();
  run.complete();
  const removed = workflow([{ name: "j", steps: [each("deploy")] }]);
  const plan = planFailedRunResume(removed, run);
  assertEquals(sortRefs(plan.tracked), ["j/deploy-a"]);
});

Deno.test("planFailedRunResume: allows removing a plain step named with a forEach prefix", () => {
  const before = workflow([
    { name: "j", steps: [each("deploy"), plain("deploy-notify")] },
  ]);
  const run = WorkflowRun.create(before);
  const job = run.getJob("j")!;
  job.replaceExpandedSteps("deploy", ["deploy-a"]);
  job.getStep("deploy-a")!.fail("a");
  job.getStep("deploy-notify")!.succeed();
  job.fail();
  run.complete();
  const removed = workflow([{ name: "j", steps: [each("deploy")] }]);
  const plan = planFailedRunResume(removed, run);
  assertEquals(plan.steps, new Set(["deploy-a", "deploy-notify"]));
  assertEquals(sortRefs(plan.tracked), ["j/deploy-a"]);
});

Deno.test("planFailedRunResume: refuses a plain step moved away from a forEach step it shares a prefix with", () => {
  const before = workflow([
    { name: "build", steps: [each("test"), plain("test-unit")] },
    { name: "release", steps: [plain("publish")], dependsOn: ["build"] },
  ]);
  const run = WorkflowRun.create(before);
  const build = run.getJob("build")!;
  build.replaceExpandedSteps("test", ["test-a"]);
  build.getStep("test-a")!.succeed();
  build.getStep("test-unit")!.fail("unit");
  build.fail();
  run.getJob("release")!.skip();
  run.complete();
  const moved = workflow([
    { name: "build", steps: [each("test")] },
    {
      name: "release",
      steps: [plain("publish"), plain("test-unit")],
      dependsOn: ["build"],
    },
  ]);
  assertStringIncludes(
    refusal(moved, run, "test-unit"),
    `Step "test-unit" is in job "build" in the run, job "release" in the workflow.`,
  );
});

Deno.test("planFailedRunResume: accepts an iteration whose name equals a reset step in another job", () => {
  const wf = workflow([
    { name: "x", steps: [each("deploy")] },
    { name: "y", steps: [plain("deploy-notify")] },
  ]);
  const run = WorkflowRun.create(wf);
  run.getJob("x")!.replaceExpandedSteps("deploy", ["deploy-notify"]);
  run.getJob("x")!.getStep("deploy-notify")!.succeed();
  run.getJob("x")!.succeed();
  run.getJob("y")!.getStep("deploy-notify")!.fail("y");
  run.getJob("y")!.fail();
  run.complete();
  const plan = planFailedRunResume(wf, run, "deploy-notify");
  assertEquals(sortRefs(plan.tracked), ["x/deploy-notify", "y/deploy-notify"]);
});

Deno.test("planFailedRunResume: refuses a duplicate step name removed from one job but kept in another", () => {
  const before = workflow([
    { name: "a", steps: [plain("x"), plain("y")] },
    { name: "b", steps: [plain("x")] },
  ]);
  const run = failedRun(before, ["x"]);
  const removed = workflow([
    { name: "a", steps: [plain("y")] },
    { name: "b", steps: [plain("x")] },
  ]);
  assertStringIncludes(
    refusal(removed, run, "x"),
    `Step "x" is in job "a" in the run, job "b" in the workflow.`,
  );
});

Deno.test("planFailedRunResume: a retry classifies records once across several entry templates", () => {
  // Two failed forEach steps in different jobs: one pass over the union
  // selects each iteration by its own template.
  const wf = workflow([
    { name: "a", steps: [each("build")] },
    { name: "b", steps: [each("build-docs")] },
  ]);
  const run = WorkflowRun.create(wf);
  run.getJob("a")!.replaceExpandedSteps("build", ["build-x"]);
  run.getJob("a")!.getStep("build-x")!.fail("x");
  run.getJob("a")!.fail();
  run.getJob("b")!.replaceExpandedSteps("build-docs", ["build-docs-y"]);
  run.getJob("b")!.getStep("build-docs-y")!.fail("y");
  run.getJob("b")!.fail();
  run.complete();
  const plan = planFailedRunResume(wf, run);
  assertEquals(sortRefs(plan.tracked), ["a/build-x", "b/build-docs-y"]);
});

Deno.test("planFailedRunResume: keeps the unknown --from step and zero-match refusals", () => {
  const wf = movedBefore();
  const run = movedRun();
  let error = refusalOf(() => planFailedRunResume(wf, run, "nope"));
  assertStringIncludes(error, `Step "nope" not found in workflow`);
  const neverReached = WorkflowRun.fromData({
    ...run.toData(),
    jobs: [
      { jobName: "build", status: "failed", steps: [] },
      { jobName: "release", status: "skipped", steps: [] },
    ],
  });
  error = refusalOf(() => planFailedRunResume(wf, neverReached, "test"));
  assertStringIncludes(error, `--from "test" matched zero persisted steps`);
});

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert(error instanceof UserError, `expected UserError, got ${error}`);
    return error.message;
  }
  throw new Error("expected a UserError");
}

Deno.test("planFailedRunResume: refusals stay within the serve limit for long names", () => {
  // Names serve refusals must fit: 16 characters each, and a UUID run id.
  const long = (prefix: string) =>
    `${prefix}-${"a".repeat(15 - prefix.length)}`;
  const [build, release, compile, test] = [
    long("build"),
    long("release"),
    long("compile"),
    long("test"),
  ];
  const before = workflow([
    { name: build, steps: [plain(compile), each(test, [compile])] },
    { name: release, steps: [plain("publish")], dependsOn: [build] },
  ]);
  const run = WorkflowRun.create(before);
  const job = run.getJob(build)!;
  job.getStep(compile)!.succeed();
  job.replaceExpandedSteps(test, [`${test}-production-eu-west`]);
  job.getStep(`${test}-production-eu-west`)!.fail("x");
  job.fail();
  run.getJob(release)!.skip();
  run.complete();
  const moved = workflow([
    { name: build, steps: [plain(compile)] },
    {
      name: release,
      steps: [plain("publish"), each(test)],
      dependsOn: [build],
    },
  ]);
  // The refusal names the template, not the longer iteration name.
  const message = refusal(moved, run, test);
  assertStringIncludes(
    message,
    `Step "${test}" is in job "${build}" in the run, job "${release}" in the workflow.`,
  );
});

Deno.test("planFailedRunResume: leaves job and step names written with an expression to evaluation", () => {
  // Names like these are stored evaluated ("deploy-prod", "notify-prod").
  const wf = workflow([
    {
      name: "deploy-${{ inputs.env }}",
      steps: [plain("a"), plain("b", ["a"])],
    },
    {
      name: "main",
      steps: [plain("prep"), plain("notify-${{ inputs.env }}"), plain("c")],
    },
  ]);
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: wf.id,
    workflowName: wf.name,
    status: "failed",
    jobs: [
      {
        jobName: "deploy-prod",
        status: "failed",
        steps: [
          { stepName: "a", status: "succeeded" },
          { stepName: "b", status: "failed" },
        ],
      },
      {
        jobName: "main",
        status: "failed",
        steps: [
          { stepName: "prep", status: "succeeded" },
          { stepName: "notify-prod", status: "succeeded" },
          { stepName: "c", status: "failed" },
        ],
      },
    ],
  });
  assertEquals(planFailedRunResume(wf, run, "b").steps, new Set(["b"]));
  assertEquals(planFailedRunResume(wf, run, "c").steps, new Set(["c"]));
});

Deno.test("planFailedRunResume: says when a reset forEach step became a plain step", () => {
  const before = workflow([{ name: "deploy", steps: [each("push")] }]);
  const run = WorkflowRun.create(before);
  const job = run.getJob("deploy")!;
  job.replaceExpandedSteps("push", ["push-dev"]);
  job.getStep("push-dev")!.fail("dev");
  job.fail();
  run.complete();
  const plainNow = workflow([{ name: "deploy", steps: [plain("push")] }]);
  assertStringIncludes(
    refusal(plainNow, run, "push"),
    `Step "push" in job "deploy" is no longer a forEach step.`,
  );
});
