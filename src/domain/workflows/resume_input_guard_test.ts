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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { UserError } from "../errors.ts";
import { Job } from "./job.ts";
import { checkResumeInputOverrides } from "./resume_input_guard.ts";
import { planFailedRunResume, type ResumeReset } from "./resume_reset.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import { TriggerCondition } from "./trigger_condition.ts";
import { Workflow } from "./workflow.ts";
import { type StepRunData, WorkflowRun } from "./workflow_run.ts";

const MAX_CLIENT_ERROR_LENGTH = 512;

function shell(name: string, run: string, dependsOn: string[] = []): Step {
  return Step.create({
    name,
    task: StepTask.model("sh", "execute", { run }),
    dependsOn: dependsOn.map((dep) => ({
      step: dep,
      condition: TriggerCondition.succeeded(),
    })),
  });
}

function approval(name: string, prompt: string, dependsOn: string[]): Step {
  return Step.create({
    name,
    task: StepTask.manualApproval(prompt),
    dependsOn: dependsOn.map((dep) => ({
      step: dep,
      condition: TriggerCondition.succeeded(),
    })),
  });
}

/** The issue's workflow: a gate, an approval, then the step it guards. */
function gatedDestroy(prompt = "Destroy ${{ inputs.target }}?"): Workflow {
  return Workflow.create({
    name: "gated-destroy",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          shell("gate", 'test "${{ inputs.target }}" != "protected"'),
          approval("approve", prompt, ["gate"]),
          shell("destroy", "echo DESTROYED ${{ inputs.target }}", ["approve"]),
        ],
      }),
    ],
  });
}

type Records = Record<string, Partial<StepRunData>[]>;

/**
 * A stored run of `wf` with the given step records per job and the given run
 * status. Records default to pending.
 */
function storedRun(
  wf: Workflow,
  status: "suspended" | "failed",
  records: Records,
  inputs: Record<string, unknown> = { target: "scratch" },
): WorkflowRun {
  const created = WorkflowRun.create(wf);
  created.start();
  const data = created.toData();
  data.status = status;
  data.inputs = inputs;
  data.jobs = Object.entries(records).map(([jobName, steps]) => ({
    jobName,
    status: status === "failed" ? "failed" : "running",
    steps: steps.map((s) => ({ status: "pending", ...s }) as StepRunData),
  }));
  return WorkflowRun.fromData(data);
}

function refusal(
  wf: Workflow,
  run: WorkflowRun,
  inputs: Record<string, unknown>,
  reset?: ResumeReset,
): string {
  const before = JSON.stringify(run.toData());
  try {
    checkResumeInputOverrides(wf, run, inputs, reset);
  } catch (error) {
    assert(error instanceof UserError, `expected UserError, got ${error}`);
    assertEquals(error.code, "resume_input_consumed");
    assertEquals(JSON.stringify(run.toData()), before, "run was mutated");
    assert(
      error.message.length <= MAX_CLIENT_ERROR_LENGTH,
      `message is ${error.message.length} characters: ${error.message}`,
    );
    assertStringIncludes(error.message, `Run ${run.id} is unchanged`);
    return error.message;
  }
  throw new Error("expected the resume to be refused");
}

const approvedRun = (wf: Workflow, inputs?: Record<string, unknown>) =>
  storedRun(wf, "suspended", {
    main: [
      { stepName: "gate", status: "succeeded" },
      { stepName: "approve", status: "succeeded" },
      { stepName: "destroy" },
    ],
  }, inputs);

Deno.test("checkResumeInputOverrides: refuses changing an input the gate and approval read", () => {
  const wf = gatedDestroy();
  const message = refusal(wf, approvedRun(wf), { target: "protected" });
  assertStringIncludes(
    message,
    'Input "target" was already used by steps "gate", "approve"',
  );
  assertStringIncludes(
    message,
    "Start a new run with the new value (swamp workflow run gated-destroy --input target=<value>)",
  );
  assertEquals(message.includes("protected"), false, "message leaks a value");
  assertEquals(message.includes("scratch"), false, "message leaks a value");
});

Deno.test("checkResumeInputOverrides: accepts an input only steps still to run read", () => {
  // The #467 pattern: a placeholder the approval does not show, minted
  // during the gate and read only after it.
  const wf = gatedDestroy("Proceed?");
  const run = storedRun(wf, "suspended", {
    main: [
      { stepName: "gate", status: "succeeded" },
      { stepName: "approve", status: "succeeded" },
      { stepName: "destroy" },
    ],
  });
  const wfAuth = Workflow.create({
    name: "deploy",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          approval("verify", "Verify SSH", []),
          shell("harden", "use ${{ inputs.authKey }}", ["verify"]),
        ],
      }),
    ],
  });
  const runAuth = storedRun(wfAuth, "suspended", {
    main: [{ stepName: "verify", status: "succeeded" }, {
      stepName: "harden",
    }],
  }, { authKey: "PENDING" });
  checkResumeInputOverrides(
    wfAuth,
    runAuth,
    { authKey: "tskey-abc" },
    undefined,
  );
  checkResumeInputOverrides(wfAuth, runAuth, { region: "us-west" }, undefined);
  // The gate still reads target, so even a prompt that hides it pins it.
  refusal(wf, run, { target: "protected" });
});

Deno.test("checkResumeInputOverrides: an input re-passed with its stored value is not a change", () => {
  const wf = gatedDestroy();
  checkResumeInputOverrides(
    wf,
    approvedRun(wf),
    { target: "scratch" },
    undefined,
  );
});

Deno.test("checkResumeInputOverrides: a nested override is compared at its top-level key", () => {
  const wf = Workflow.create({
    name: "nested",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          shell("first", "echo ${{ inputs.creds.user }}"),
          shell("second", "echo ${{ inputs.creds.key }}", ["first"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [{ stepName: "first", status: "succeeded" }, {
      stepName: "second",
    }],
  }, { creds: { user: "u", key: "old" } });
  // Merged, the same value: no change.
  checkResumeInputOverrides(wf, run, { creds: { key: "old" } }, undefined);
  refusal(wf, run, { creds: { key: "new" } });
});

Deno.test("checkResumeInputOverrides: a key the run did not have counts as changed", () => {
  const wf = Workflow.create({
    name: "absent",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          shell("check", "echo ${{ has(inputs.force) }}"),
          shell("act", "echo go", ["check"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [{ stepName: "check", status: "succeeded" }, { stepName: "act" }],
  }, {});
  assertStringIncludes(refusal(wf, run, { force: true }), '"force"');
});

Deno.test("checkResumeInputOverrides: steps that never evaluated do not count", () => {
  const wf = gatedDestroy();
  const run = storedRun(wf, "failed", {
    main: [
      { stepName: "gate", status: "failed" },
      {
        stepName: "approve",
        status: "skipped",
        skipReason: { kind: "dependency" },
      },
      {
        stepName: "destroy",
        status: "skipped",
        skipReason: { kind: "job_skipped" },
      },
    ],
  });
  // The retry resets the failed gate, so it runs again with the new value.
  const reset = planFailedRunResume(wf, run);
  checkResumeInputOverrides(wf, run, { target: "scratch2" }, reset);
  // A record the run's abort settled without starting is reopened.
  const settled = storedRun(wf, "suspended", {
    main: [
      { stepName: "gate", status: "skipped", settledByAbort: true },
      { stepName: "approve" },
      { stepName: "destroy" },
    ],
  });
  checkResumeInputOverrides(wf, settled, { target: "x" }, undefined);
});

Deno.test("checkResumeInputOverrides: a guarded skip read its guard", () => {
  const wf = Workflow.create({
    name: "guarded",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "maybe",
            task: StepTask.model("sh", "execute", { run: "echo" }),
            guard: "${{ inputs.skip }}",
          }),
          shell("after", "echo", ["maybe"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [
      {
        stepName: "maybe",
        status: "skipped",
        skipReason: { kind: "guarded" },
      },
      { stepName: "after" },
    ],
  }, { skip: true });
  refusal(wf, run, { skip: false });
});

Deno.test("checkResumeInputOverrides: path 1 - --from the approval is refused, --from the gate is not", () => {
  const wf = gatedDestroy();
  const run = storedRun(wf, "failed", {
    main: [
      { stepName: "gate", status: "succeeded" },
      { stepName: "approve", status: "failed" },
      {
        stepName: "destroy",
        status: "skipped",
        skipReason: { kind: "dependency" },
      },
    ],
  });
  const message = refusal(
    wf,
    run,
    { target: "protected" },
    planFailedRunResume(wf, run, "approve"),
  );
  assertStringIncludes(
    message,
    'Input "target" was already used by step "gate"',
  );
  assertStringIncludes(
    message,
    `swamp workflow resume gated-destroy --run ${run.id} --from gate`,
  );
  checkResumeInputOverrides(
    wf,
    run,
    { target: "protected" },
    planFailedRunResume(wf, run, "gate"),
  );
});

Deno.test("checkResumeInputOverrides: forEach iterations are read through their template", () => {
  const wf = Workflow.create({
    name: "fan",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "deploy-${{ self.env }}",
            task: StepTask.model("sh", "execute", {
              run: "test ${{ self.env }} != ${{ inputs.broken }}",
            }),
            forEach: { item: "env", in: "${{ inputs.envs }}" },
          }),
          shell("after", "echo", ["deploy-${{ self.env }}"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [
      {
        stepName: "deploy-a",
        status: "succeeded",
        forEachTemplate: "deploy-${{ self.env }}",
      },
      { stepName: "after" },
    ],
  }, { envs: ["a"], broken: "b" });
  const message = refusal(wf, run, { broken: "none" });
  assertStringIncludes(message, '"deploy-a"');
  refusal(wf, run, { envs: ["a", "c"] });
});

Deno.test("checkResumeInputOverrides: a step named by an expression is read against its whole job", () => {
  const wf = Workflow.create({
    name: "named",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          shell("step-${{ inputs.suffix }}", "echo"),
          shell("other", "echo ${{ inputs.target }}"),
          shell("later", "echo ${{ inputs.late }}", ["other"]),
        ],
      }),
    ],
  });
  // The record holds the evaluated name, which matches no authored step.
  const run = storedRun(wf, "suspended", {
    main: [
      { stepName: "step-x", status: "succeeded" },
      { stepName: "other" },
      { stepName: "later" },
    ],
  }, { suffix: "x", target: "t" });
  refusal(wf, run, { suffix: "y" });
  // The fallback reads only steps named by an expression, not "other".
  checkResumeInputOverrides(wf, run, { target: "u" }, undefined);
});

Deno.test("checkResumeInputOverrides: a job whose name reads an input pins it once its steps ran", () => {
  const wf = Workflow.create({
    name: "jobs",
    jobs: [
      Job.create({
        name: "deploy-${{ inputs.region }}",
        steps: [shell("one", "echo"), shell("two", "echo", ["one"])],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    "deploy-east": [{ stepName: "one", status: "succeeded" }, {
      stepName: "two",
    }],
  }, { region: "east" });
  assertStringIncludes(refusal(wf, run, { region: "west" }), '"one"');
});

Deno.test("checkResumeInputOverrides: an assert's expr and run.inputs reads count", () => {
  const wf = Workflow.create({
    name: "assert",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "check",
            task: StepTask.assert("inputs.size < 10", "too big"),
          }),
          shell("echo-run", "echo ${{ run.inputs.label }}"),
          shell("after", "echo", ["check", "echo-run"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [
      { stepName: "check", status: "succeeded" },
      { stepName: "echo-run", status: "succeeded" },
      { stepName: "after" },
    ],
  }, { size: 1, label: "a" });
  refusal(wf, run, { size: 100 });
  refusal(wf, run, { label: "b" });
});

Deno.test("checkResumeInputOverrides: a step reading inputs whole pins every input", () => {
  const wf = Workflow.create({
    name: "whole",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "child",
            task: StepTask.workflow("child-wf", { all: "${{ inputs }}" }),
          }),
          shell("after", "echo", ["child"]),
        ],
      }),
    ],
  });
  // A nested workflow step waiting on its suspended child already forwarded
  // its inputs.
  const run = storedRun(wf, "suspended", {
    main: [{ stepName: "child", status: "waiting" }, { stepName: "after" }],
  }, { a: 1 });
  refusal(wf, run, { anything: "new" });
});
