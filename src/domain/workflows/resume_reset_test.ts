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
import {
  checkSuspendedRunResume,
  planFailedRunResume,
} from "./resume_reset.ts";
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

function workflow(jobs: JobSpec[], name = "resume-wf"): Workflow {
  return Workflow.create({
    name,
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

Deno.test("planFailedRunResume: an added step named like one kept in another job is not called moved", () => {
  const before = workflow([
    { name: "a", steps: [plain("x")] },
    { name: "b", steps: [plain("y")] },
  ]);
  const run = failedRun(before, ["x"]);
  const added = workflow([
    { name: "a", steps: [plain("x"), plain("y")] },
    { name: "b", steps: [plain("y")] },
  ]);
  assertStringIncludes(
    refusal(added, run, "x"),
    `Step "y" in job "a" is not in the run.`,
  );
});

/**
 * main: prep → gate → deploy → notify; post (depends on main): announce.
 * The shape of the swamp-club#2498 reproduction.
 */
function gatedBefore(): Workflow {
  return workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
        plain("notify", ["deploy"]),
      ],
    },
    { name: "post", steps: [plain("announce")], dependsOn: ["main"] },
  ]);
}

/**
 * A run of `wf` suspended at `gate` in job `main` and then approved: the
 * steps up to the gate succeeded, the rest of `main` is pending, `main` is
 * running, and every other job is pending.
 */
function suspendedRun(wf: Workflow): WorkflowRun {
  const run = WorkflowRun.create(wf);
  run.start();
  const main = run.getJob("main")!;
  main.start();
  for (const step of main.steps) {
    if (step.stepName === "gate") {
      step.waitForApproval("Approve deploy?");
      step.succeed();
      break;
    }
    step.succeed();
  }
  run.suspend();
  return run;
}

function suspendedRefusal(wf: Workflow, run: WorkflowRun): string {
  const before = JSON.stringify(run.toData());
  try {
    checkSuspendedRunResume(wf, run);
  } catch (error) {
    assert(error instanceof UserError, `expected UserError, got ${error}`);
    assertEquals(JSON.stringify(run.toData()), before, "run was mutated");
    assert(
      error.message.length <= MAX_CLIENT_ERROR_LENGTH,
      `message is ${error.message.length} characters: ${error.message}`,
    );
    assert(!ABSOLUTE_PATH.test(error.message), error.message);
    assertStringIncludes(
      error.message,
      `To cancel: 'swamp workflow cancel ${wf.name} --run ${run.id}'.`,
    );
    return error.message;
  }
  throw new Error("expected checkSuspendedRunResume to refuse");
}

Deno.test("checkSuspendedRunResume: accepts an unchanged workflow", () => {
  const wf = gatedBefore();
  checkSuspendedRunResume(wf, suspendedRun(wf));
});

Deno.test("checkSuspendedRunResume: refuses a step added to a job it re-enters", () => {
  const added = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
        plain("notify", ["deploy"]),
        plain("lint", ["gate"]),
      ],
    },
    { name: "post", steps: [plain("announce")], dependsOn: ["main"] },
  ]);
  assertStringIncludes(
    suspendedRefusal(added, suspendedRun(gatedBefore())),
    `Step "lint" in job "main" is not in the run.`,
  );
});

Deno.test("checkSuspendedRunResume: refuses a pending step moved into a job it re-enters", () => {
  const moved = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
      ],
    },
    {
      name: "post",
      steps: [plain("announce"), plain("notify")],
      dependsOn: ["main"],
    },
  ]);
  assertStringIncludes(
    suspendedRefusal(moved, suspendedRun(gatedBefore())),
    `Step "notify" is in job "main" in the run, job "post" in the workflow.`,
  );
});

Deno.test("checkSuspendedRunResume: refuses a pending step moved into a finished job", () => {
  // Resume skips the finished job "pre", so only the record left pending in
  // "main" shows the move; without the check the run would report success.
  const before = workflow([
    { name: "pre", steps: [plain("check")] },
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
        plain("notify", ["deploy"]),
      ],
    },
  ]);
  const run = suspendedRun(before);
  run.getJob("pre")!.getStep("check")!.succeed();
  run.getJob("pre")!.succeed();
  const moved = workflow([
    { name: "pre", steps: [plain("check"), plain("notify")] },
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
      ],
    },
  ]);
  assertStringIncludes(
    suspendedRefusal(moved, run),
    `Step "notify" is in job "main" in the run, job "pre" in the workflow.`,
  );
});

Deno.test("checkSuspendedRunResume: refuses a step moved out of a job the workflow no longer has", () => {
  const moved = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
        plain("notify", ["deploy"]),
        plain("announce", ["notify"]),
      ],
    },
  ]);
  assertStringIncludes(
    suspendedRefusal(moved, suspendedRun(gatedBefore())),
    `Step "announce" is in job "post" in the run, job "main" in the workflow.`,
  );
});

Deno.test("checkSuspendedRunResume: refuses an added or renamed job", () => {
  const run = suspendedRun(gatedBefore());
  const mainSpec = (): JobSpec => ({
    name: "main",
    steps: [
      plain("prep"),
      plain("gate", ["prep"]),
      plain("deploy", ["gate"]),
      plain("notify", ["deploy"]),
    ],
  });
  const extra = workflow([
    mainSpec(),
    { name: "post", steps: [plain("announce")], dependsOn: ["main"] },
    { name: "extra", steps: [plain("audit")], dependsOn: ["main"] },
  ]);
  assertStringIncludes(
    suspendedRefusal(extra, run),
    `Job "extra" is not in the run.`,
  );
  const renamed = workflow([
    mainSpec(),
    { name: "post2", steps: [plain("announce")], dependsOn: ["main"] },
  ]);
  assertStringIncludes(
    suspendedRefusal(renamed, run),
    `Job "post2" is not in the run.`,
  );
});

/** main: prep → gate → deploy (forEach), expanded to deploy-dev, deploy-prod. */
function gatedForEach(): { before: Workflow; run: WorkflowRun } {
  const before = workflow([
    {
      name: "main",
      steps: [plain("prep"), plain("gate", ["prep"]), each("deploy", ["gate"])],
    },
    { name: "post", steps: [plain("announce")], dependsOn: ["main"] },
  ]);
  const run = suspendedRun(before);
  // A job expands its forEach steps when it starts, before the gate suspends.
  run.getJob("main")!.replaceExpandedSteps("deploy", [
    "deploy-dev",
    "deploy-prod",
  ]);
  return { before, run };
}

Deno.test("checkSuspendedRunResume: says when an expanded forEach step became a plain step", () => {
  const { run } = gatedForEach();
  const plainNow = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
      ],
    },
    { name: "post", steps: [plain("announce")], dependsOn: ["main"] },
  ]);
  assertStringIncludes(
    suspendedRefusal(plainNow, run),
    `Step "deploy" in job "main" is no longer a forEach step.`,
  );
});

Deno.test("checkSuspendedRunResume: refuses a forEach step moved to another job", () => {
  const { run } = gatedForEach();
  const moved = workflow([
    { name: "main", steps: [plain("prep"), plain("gate", ["prep"])] },
    {
      name: "post",
      steps: [plain("announce"), each("deploy")],
      dependsOn: ["main"],
    },
  ]);
  assertStringIncludes(
    suspendedRefusal(moved, run),
    `Step "deploy" is in job "main" in the run, job "post" in the workflow.`,
  );
});

Deno.test("checkSuspendedRunResume: accepts iterations of a forEach step, whatever its collection now holds", () => {
  // The check never evaluates a collection, so narrowing it through a
  // resume --input still resumes, as before.
  const { before, run } = gatedForEach();
  checkSuspendedRunResume(before, run);
});

Deno.test("checkSuspendedRunResume: accepts a removed step, which stays pending", () => {
  const removed = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
      ],
    },
    { name: "post", steps: [plain("announce")], dependsOn: ["main"] },
  ]);
  checkSuspendedRunResume(removed, suspendedRun(gatedBefore()));
});

Deno.test("checkSuspendedRunResume: accepts a step removed from one job but kept in another", () => {
  // Step names are unique only within a job. "post" already had its own
  // "notify", so the one in "main" was removed, not moved.
  const before = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
        plain("notify", ["deploy"]),
      ],
    },
    {
      name: "post",
      steps: [plain("announce"), plain("notify")],
      dependsOn: ["main"],
    },
  ]);
  const removed = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
      ],
    },
    {
      name: "post",
      steps: [plain("announce"), plain("notify")],
      dependsOn: ["main"],
    },
  ]);
  checkSuspendedRunResume(removed, suspendedRun(before));
});

Deno.test("checkSuspendedRunResume: an added step named like one kept in another job is not called moved", () => {
  const added = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
        plain("notify", ["deploy"]),
        plain("announce", ["notify"]),
      ],
    },
    { name: "post", steps: [plain("announce")], dependsOn: ["main"] },
  ]);
  assertStringIncludes(
    suspendedRefusal(added, suspendedRun(gatedBefore())),
    `Step "announce" in job "main" is not in the run.`,
  );
});

Deno.test("checkSuspendedRunResume: accepts a removed unfinished job", () => {
  const removed = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
        plain("notify", ["deploy"]),
      ],
    },
  ]);
  checkSuspendedRunResume(removed, suspendedRun(gatedBefore()));
});

Deno.test("checkSuspendedRunResume: accepts a step added to a finished job, which resume does not walk", () => {
  const before = workflow([
    { name: "pre", steps: [plain("check")] },
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
      ],
    },
  ]);
  const run = suspendedRun(before);
  run.getJob("pre")!.getStep("check")!.succeed();
  run.getJob("pre")!.succeed();
  const added = workflow([
    { name: "pre", steps: [plain("check"), plain("lint")] },
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
      ],
    },
  ]);
  checkSuspendedRunResume(added, run);
});

Deno.test("checkSuspendedRunResume: accepts a forEach step added to a job it re-enters", () => {
  // Resume adds its iteration records as it expands them.
  const added = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("deploy", ["gate"]),
        plain("notify", ["deploy"]),
        each("smoke", ["deploy"]),
      ],
    },
    { name: "post", steps: [plain("announce")], dependsOn: ["main"] },
  ]);
  checkSuspendedRunResume(added, suspendedRun(gatedBefore()));
});

Deno.test("checkSuspendedRunResume: accepts records with no forEachTemplate from an evaluated workflow", () => {
  // --last-evaluated and older runs store concrete iteration names with no
  // forEachTemplate; they match no step by name.
  const wf = workflow([
    {
      name: "main",
      steps: [plain("prep"), plain("gate", ["prep"]), each("deploy", ["gate"])],
    },
  ]);
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: wf.id,
    workflowName: wf.name,
    status: "suspended",
    jobs: [{
      jobName: "main",
      status: "running",
      steps: [
        { stepName: "prep", status: "succeeded" },
        { stepName: "gate", status: "succeeded" },
        { stepName: "deploy-dev", status: "pending" },
        { stepName: "deploy-prod", status: "pending" },
      ],
    }],
  });
  checkSuspendedRunResume(wf, run);
});

Deno.test("checkSuspendedRunResume: leaves job and step names written with an expression to evaluation", () => {
  const wf = workflow([
    {
      name: "main",
      steps: [
        plain("prep"),
        plain("gate", ["prep"]),
        plain("notify-${{ inputs.env }}", ["gate"]),
      ],
    },
    { name: "deploy-${{ inputs.env }}", steps: [plain("push")] },
  ]);
  const run = WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: wf.id,
    workflowName: wf.name,
    status: "suspended",
    jobs: [
      {
        jobName: "main",
        status: "running",
        steps: [
          { stepName: "prep", status: "succeeded" },
          { stepName: "gate", status: "succeeded" },
          { stepName: "notify-prod", status: "pending" },
        ],
      },
      {
        jobName: "deploy-prod",
        status: "pending",
        steps: [{ stepName: "push", status: "pending" }],
      },
    ],
  });
  checkSuspendedRunResume(wf, run);
});

Deno.test("checkSuspendedRunResume: accepts a run that suspended again at a gate a failed-run resume reset", () => {
  const wf = gatedBefore();
  const run = suspendedRun(wf);
  run.getJob("main")!.getStep("deploy")!.markResetByResume();
  checkSuspendedRunResume(wf, run);
});

Deno.test("checkSuspendedRunResume: refusals stay within the serve limit for long names", () => {
  // Names serve refusals must fit: 16 characters each, including the
  // workflow name in the cancel command, and a UUID run id.
  const long = (prefix: string) =>
    `${prefix}-${"a".repeat(15 - prefix.length)}`;
  const [name, main, post, notify] = [
    long("workflow"),
    long("main"),
    long("post"),
    long("notify"),
  ];
  const before = workflow([
    {
      name: main,
      steps: [plain("gate"), plain(notify, ["gate"])],
    },
    { name: post, steps: [plain("announce")], dependsOn: [main] },
  ], name);
  const run = WorkflowRun.create(before);
  run.start();
  run.getJob(main)!.start();
  run.getJob(main)!.getStep("gate")!.succeed();
  run.suspend();
  const moved = workflow([
    { name: main, steps: [plain("gate")] },
    {
      name: post,
      steps: [plain("announce"), plain(notify)],
      dependsOn: [main],
    },
  ], name);
  assertStringIncludes(
    suspendedRefusal(moved, run),
    `Step "${notify}" is in job "${main}" in the run, job "${post}" in the workflow.`,
  );
});
