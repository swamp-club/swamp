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
import { selectRetryTemplates } from "./failed_step_retry.ts";
import { Job } from "./job.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import { Workflow } from "./workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

const MAX_CLIENT_ERROR_LENGTH = 200;
const ABSOLUTE_PATH = /(?:^|[\s"'`(])\/[a-z]/i;

function step(name: string, dependsOn: string[] = []): Step {
  return Step.create({
    name,
    task: StepTask.model("test-model", "run"),
    dependsOn: dependsOn.map((dep) => ({
      step: dep,
      condition: TriggerCondition.succeeded(),
    })),
  });
}

/** build → deploy (depends on build), and an independent notify job. */
function createWorkflow(): Workflow {
  return Workflow.create({
    name: "retry-wf",
    jobs: [
      Job.create({ name: "build", steps: [step("compile"), step("lint")] }),
      Job.create({
        name: "deploy",
        steps: [step("push")],
        dependsOn: [{
          job: "build",
          condition: TriggerCondition.succeeded(),
        }],
      }),
      Job.create({ name: "notify", steps: [step("announce")] }),
    ],
  });
}

/** A failed run: compile fails, lint and announce succeed, deploy is skipped. */
function createFailedRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  const build = run.getJob("build")!;
  build.getStep("compile")!.fail("compile error");
  build.getStep("lint")!.succeed();
  build.fail();
  run.getJob("deploy")!.skip();
  const notify = run.getJob("notify")!;
  notify.getStep("announce")!.succeed();
  notify.succeed();
  run.complete();
  return run;
}

function refusal(workflow: Workflow, run: WorkflowRun): UserError {
  const before = JSON.stringify(run.toData());
  try {
    selectRetryTemplates(workflow, run);
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
      `swamp workflow history logs ${run.id}`,
    );
    return error;
  }
  throw new Error("expected selectRetryTemplates to refuse");
}

Deno.test("selectRetryTemplates: returns the failed step of an eligible run", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  assertEquals(selectRetryTemplates(workflow, run), ["compile"]);
});

Deno.test("selectRetryTemplates: returns every failed step across jobs in stored order", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  const notify = run.getJob("notify")!;
  notify.getStep("announce")!.fail("smtp down");
  notify.fail();
  assertEquals(selectRetryTemplates(workflow, run), ["compile", "announce"]);
});

Deno.test("selectRetryTemplates: ignores recorded allowed failures", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  const lint = run.getJob("build")!.getStep("lint")!;
  lint.fail("style");
  lint.markAllowedFailure();
  assertEquals(selectRetryTemplates(workflow, run), ["compile"]);
});

Deno.test("selectRetryTemplates: maps forEach iterations to one entry template", () => {
  const workflow = Workflow.create({
    name: "each-wf",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "read",
            task: StepTask.model("test-model", "run"),
            forEach: { item: "plate", in: "${{ inputs.plates }}" },
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  const job = run.getJob("main")!;
  job.replaceExpandedSteps("read", ["read-a", "read-b", "read-c"]);
  job.getStep("read-a")!.fail("a");
  job.getStep("read-b")!.succeed();
  job.getStep("read-c")!.fail("c");
  job.fail();
  run.complete();
  assertEquals(selectRetryTemplates(workflow, run), ["read"]);
});

Deno.test("selectRetryTemplates: refuses a rejected approval and suggests --from", () => {
  const workflow = Workflow.create({
    name: "gate-wf",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Ship it?"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  const gate = run.getJob("main")!.getStep("gate")!;
  gate.recordApprovalDecision({
    approved: false,
    decidedAt: new Date().toISOString(),
  });
  gate.fail("Approval rejected");
  run.getJob("main")!.fail();
  run.complete();
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, `Step "gate" in job "main" was rejected`);
  assertStringIncludes(error.message, "--from gate");
});

Deno.test("selectRetryTemplates: refuses a rejected approval with pending work", () => {
  const workflow = Workflow.create({
    name: "gate-wf",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.manualApproval("Ship it?"),
          }),
          step("ship", ["gate"]),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  const gate = run.getJob("main")!.getStep("gate")!;
  gate.recordApprovalDecision({
    approved: false,
    decidedAt: new Date().toISOString(),
  });
  gate.fail("Approval rejected");
  run.getJob("main")!.fail();
  run.complete();
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, "was rejected");
});

for (
  const status of ["running", "waiting_approval", "unknown"] as const
) {
  Deno.test(`selectRetryTemplates: refuses a ${status} step`, () => {
    const workflow = createWorkflow();
    const run = createFailedRun(workflow);
    const lint = run.getJob("build")!.getStep("lint")!;
    if (status === "running") lint.start();
    if (status === "waiting_approval") lint.waitForApproval("ok?");
    if (status === "unknown") lint.markUnknown("crashed");
    const error = refusal(workflow, run);
    assertStringIncludes(
      error.message,
      `Step "lint" in job "build" is ${status}`,
    );
    assert(!error.message.includes("--from"), error.message);
  });
}

Deno.test("selectRetryTemplates: refuses a pending step and suggests --from", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  run.getJob("build")!.getStep("lint")!.resetToPending();
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, `Step "lint" in job "build" is pending`);
  assertStringIncludes(error.message, "--from lint");
});

Deno.test("selectRetryTemplates: refuses a job left running by an expansion error", () => {
  const workflow = createWorkflow();
  const run = WorkflowRun.create(workflow);
  run.start();
  run.getJob("build")!.start();
  run.complete();
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, `Step "compile" in job "build"`);
  assertStringIncludes(error.message, "pending");
});

Deno.test("selectRetryTemplates: refuses a non-terminal job whose steps finished", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  run.getJob("notify")!.start();
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, `Job "notify" is running`);
});

Deno.test("selectRetryTemplates: refuses a run with no failed step", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  run.getJob("build")!.getStep("compile")!.succeed();
  run.getJob("build")!.succeed();
  run.getJob("deploy")!.getStep("push")!.succeed();
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, "no failed step");
});

Deno.test("selectRetryTemplates: refuses a failed job without a failed step", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  const notify = run.getJob("notify")!;
  notify.fail();
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, `Job "notify" failed before any step`);
});

Deno.test("selectRetryTemplates: refuses a failed step removed from the workflow", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  const renamed = Workflow.create({
    id: workflow.id,
    name: workflow.name,
    jobs: [
      Job.create({ name: "build", steps: [step("compile2"), step("lint")] }),
      Job.create({ name: "deploy", steps: [step("push")] }),
      Job.create({ name: "notify", steps: [step("announce")] }),
    ],
  });
  const error = refusal(renamed, run);
  assertStringIncludes(
    error.message,
    `Step "compile" in job "build" is not in the current workflow`,
  );
  assertStringIncludes(error.message, "Start a new run.");
  assert(!error.message.includes("--from"), error.message);
});

Deno.test("selectRetryTemplates: refuses a failed step moved to another job", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  const moved = Workflow.create({
    id: workflow.id,
    name: workflow.name,
    jobs: [
      Job.create({ name: "build", steps: [step("lint")] }),
      Job.create({ name: "deploy", steps: [step("compile"), step("push")] }),
      Job.create({ name: "notify", steps: [step("announce")] }),
    ],
  });
  const error = refusal(moved, run);
  assertStringIncludes(error.message, "is not in the current workflow");
  assertStringIncludes(error.message, "Start a new run.");
  assert(!error.message.includes("--from"), error.message);
});

Deno.test("selectRetryTemplates: refuses an older forEach record without forEachTemplate", () => {
  const workflow = Workflow.create({
    name: "each-wf",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "read",
            task: StepTask.model("test-model", "run"),
            forEach: { item: "plate", in: "${{ inputs.plates }}" },
          }),
        ],
      }),
    ],
  });
  const data = WorkflowRun.create(workflow).toData();
  data.status = "failed";
  data.jobs[0].status = "failed";
  data.jobs[0].steps = [
    { stepName: "read-a", status: "failed", error: "a" },
    { stepName: "read-b", status: "succeeded" },
  ];
  const run = WorkflowRun.fromData(data);
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, `Step "read-a" in job "main"`);
});

Deno.test("selectRetryTemplates: refuses repeated step names across jobs", () => {
  const workflow = Workflow.create({
    name: "dup-wf",
    jobs: [
      Job.create({ name: "one", steps: [step("check")] }),
      Job.create({ name: "two", steps: [step("check"), step("other")] }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  run.getJob("one")!.getStep("check")!.fail("x");
  run.getJob("one")!.fail();
  run.getJob("two")!.getStep("check")!.succeed();
  run.getJob("two")!.getStep("other")!.succeed();
  run.getJob("two")!.succeed();
  run.complete();
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, `Step name "check"`);
});

Deno.test("selectRetryTemplates: refuses repeated stored step names", () => {
  const workflow = Workflow.create({
    name: "dup-wf",
    jobs: [
      Job.create({ name: "one", steps: [step("a")] }),
      Job.create({ name: "two", steps: [step("b")] }),
    ],
  });
  const data = WorkflowRun.create(workflow).toData();
  data.status = "failed";
  data.jobs[0].status = "failed";
  data.jobs[0].steps = [{ stepName: "a", status: "failed", error: "x" }];
  data.jobs[1].status = "succeeded";
  data.jobs[1].steps = [
    { stepName: "b", status: "succeeded" },
    { stepName: "a", status: "succeeded" },
  ];
  const run = WorkflowRun.fromData(data);
  const error = refusal(workflow, run);
  assertStringIncludes(error.message, `Step name "a" is stored more than once`);
});

Deno.test("selectRetryTemplates: refusals stay within the serve limit for long names", () => {
  // Names serve refusals must fit: 16 characters each.
  const long = "a".repeat(11);
  const workflow = Workflow.create({
    name: `wf-${long}`,
    jobs: [
      Job.create({
        name: `job-${long}`,
        steps: [
          Step.create({
            name: `gate-${long}`,
            task: StepTask.manualApproval("ok?"),
          }),
        ],
      }),
    ],
  });
  const run = WorkflowRun.create(workflow);
  const gate = run.getJob(`job-${long}`)!.getStep(`gate-${long}`)!;
  gate.recordApprovalDecision({
    approved: false,
    decidedAt: new Date().toISOString(),
  });
  gate.fail("Approval rejected");
  run.getJob(`job-${long}`)!.fail();
  run.complete();
  refusal(workflow, run);
});

Deno.test("selectRetryTemplates: refuses a step stranded by a workflow change", () => {
  const workflow = createWorkflow();
  const run = createFailedRun(workflow);
  run.resetForResumeFrom(new Set(["compile"]), [
    { jobName: "build", stepName: "compile" },
  ]);
  run.resumeFromFailed();
  const build = run.getJob("build")!;
  build.failStrandedResetSteps();
  build.fail();
  run.complete();
  const error = refusal(workflow, run);
  assertStringIncludes(
    error.message,
    `Step "compile" in job "build" did not run: the workflow or a forEach collection changed. Start a new run.`,
  );
});

Deno.test("selectRetryTemplates: a stranded-step refusal stays within the serve limit for long names", () => {
  const long = (prefix: string) =>
    `${prefix}-${"a".repeat(15 - prefix.length)}`;
  const workflow = Workflow.create({
    name: long("wf"),
    jobs: [Job.create({ name: long("job"), steps: [step(long("step"))] })],
  });
  const run = WorkflowRun.create(workflow);
  run.start();
  run.resetForResumeFrom(new Set([long("step")]), [
    { jobName: long("job"), stepName: long("step") },
  ]);
  const job = run.getJob(long("job"))!;
  job.failStrandedResetSteps();
  job.fail();
  run.complete();
  refusal(workflow, run);
});
