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
import {
  checkResumeInputOverrides,
  type DefinitionData,
} from "./resume_input_guard.ts";
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

/** Every definition a test names exists and reads nothing. */
const NO_READS: DefinitionData = (ref) => Promise.resolve({ name: ref });

function accepts(
  wf: Workflow,
  run: WorkflowRun,
  inputs: Record<string, unknown>,
  reset?: ResumeReset,
  definitions: DefinitionData = NO_READS,
): Promise<void> {
  return checkResumeInputOverrides(wf, run, inputs, reset, definitions);
}

async function refusal(
  wf: Workflow,
  run: WorkflowRun,
  inputs: Record<string, unknown>,
  reset?: ResumeReset,
  definitions: DefinitionData = NO_READS,
): Promise<string> {
  const before = JSON.stringify(run.toData());
  try {
    await checkResumeInputOverrides(wf, run, inputs, reset, definitions);
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

Deno.test("checkResumeInputOverrides: refuses changing an input the gate and approval read", async () => {
  const wf = gatedDestroy();
  const message = await refusal(wf, approvedRun(wf), { target: "protected" });
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

Deno.test("checkResumeInputOverrides: accepts an input only steps still to run read", async () => {
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
  await accepts(
    wfAuth,
    runAuth,
    { authKey: "tskey-abc" },
    undefined,
  );
  await accepts(wfAuth, runAuth, { region: "us-west" }, undefined);
  // The gate still reads target, so even a prompt that hides it pins it.
  await refusal(wf, run, { target: "protected" });
});

Deno.test("checkResumeInputOverrides: an input re-passed with its stored value is not a change", async () => {
  const wf = gatedDestroy();
  await accepts(
    wf,
    approvedRun(wf),
    { target: "scratch" },
    undefined,
  );
});

Deno.test("checkResumeInputOverrides: a nested override is compared at its top-level key", async () => {
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
  await accepts(wf, run, { creds: { key: "old" } }, undefined);
  await refusal(wf, run, { creds: { key: "new" } });
});

Deno.test("checkResumeInputOverrides: a key the run did not have counts as changed", async () => {
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
  assertStringIncludes(await refusal(wf, run, { force: true }), '"force"');
});

Deno.test("checkResumeInputOverrides: steps that never evaluated do not count", async () => {
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
  await accepts(wf, run, { target: "scratch2" }, reset);
  // A record the run's abort settled without starting is reopened.
  const settled = storedRun(wf, "suspended", {
    main: [
      { stepName: "gate", status: "skipped", settledByAbort: true },
      { stepName: "approve" },
      { stepName: "destroy" },
    ],
  });
  await accepts(wf, settled, { target: "x" }, undefined);
});

Deno.test("checkResumeInputOverrides: a guarded skip read its guard", async () => {
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
  await refusal(wf, run, { skip: false });
});

Deno.test("checkResumeInputOverrides: path 1 - --from the approval is refused, --from the gate is not", async () => {
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
  const message = await refusal(
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
  await accepts(
    wf,
    run,
    { target: "protected" },
    planFailedRunResume(wf, run, "gate"),
  );
});

Deno.test("checkResumeInputOverrides: forEach iterations are read through their template", async () => {
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
  const message = await refusal(wf, run, { broken: "none" });
  assertStringIncludes(message, '"deploy-a"');
  await refusal(wf, run, { envs: ["a", "c"] });
});

Deno.test("checkResumeInputOverrides: a step named by an expression is read against its whole job", async () => {
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
  await refusal(wf, run, { suffix: "y" });
  // The fallback reads only steps named by an expression, not "other".
  await accepts(wf, run, { target: "u" }, undefined);
});

Deno.test("checkResumeInputOverrides: a job whose name reads an input pins it once its steps ran", async () => {
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
  assertStringIncludes(await refusal(wf, run, { region: "west" }), '"one"');
});

Deno.test("checkResumeInputOverrides: an assert's expr and run.inputs reads count", async () => {
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
  await refusal(wf, run, { size: 100 });
  await refusal(wf, run, { label: "b" });
});

Deno.test("checkResumeInputOverrides: a step reading inputs whole pins every input", async () => {
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
  await refusal(wf, run, { anything: "new" });
});

Deno.test("checkResumeInputOverrides: a definition that reads an input pins it once its step ran", async () => {
  // The issue's attack with the check moved into the definition: the step
  // passes nothing, the approval shows nothing, and the definition is
  // evaluated with the run's inputs in scope.
  const wf = Workflow.create({
    name: "definition-gate",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.model("gate-check", "execute"),
          }),
          approval("approve", "Proceed?", ["gate"]),
          shell("destroy", "echo ${{ inputs.target }}", ["approve"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [
      { stepName: "gate", status: "succeeded" },
      { stepName: "approve", status: "succeeded" },
      { stepName: "destroy" },
    ],
  });
  const definitions: DefinitionData = (ref) =>
    Promise.resolve(
      ref === "gate-check"
        ? {
          name: ref,
          methods: {
            execute: {
              arguments: { run: 'test "${{ inputs.target }}" != "protected"' },
            },
          },
        }
        : { name: ref },
    );
  const message = await refusal(
    wf,
    run,
    { target: "protected" },
    undefined,
    definitions,
  );
  assertStringIncludes(
    message,
    'Input "target" was already used by step "gate"',
  );
});

Deno.test("checkResumeInputOverrides: a definition that cannot be read reads every input", async () => {
  const wf = gatedDestroy("Proceed?");
  const ran = () =>
    storedRun(wf, "suspended", {
      main: [
        { stepName: "gate", status: "succeeded" },
        { stepName: "approve", status: "succeeded" },
        { stepName: "destroy" },
      ],
    });
  // Missing, or failing to load: what the step ran cannot be told.
  await refusal(
    wf,
    ran(),
    { other: "x" },
    undefined,
    () => Promise.resolve(undefined),
  );
  await refusal(
    wf,
    ran(),
    { other: "x" },
    undefined,
    () => Promise.reject(new Error("unreadable")),
  );

  // A model named by an expression is not looked up at all.
  const computed = Workflow.create({
    name: "computed-model",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({
            name: "gate",
            task: StepTask.model("${{ self.model }}", "execute"),
          }),
          shell("after", "echo", ["gate"]),
        ],
      }),
    ],
  });
  const looked: string[] = [];
  await refusal(
    computed,
    storedRun(computed, "suspended", {
      main: [{ stepName: "gate", status: "succeeded" }, { stepName: "after" }],
    }),
    { other: "x" },
    undefined,
    (ref) => {
      looked.push(ref);
      return Promise.resolve({ name: ref });
    },
  );
  assertEquals(looked, []);
});

Deno.test("checkResumeInputOverrides: the workflow's own fields are read by every step that ran", async () => {
  const wf = Workflow.create({
    name: "tagged",
    tags: { env: "${{ inputs.env }}" },
    jobs: [
      Job.create({
        name: "main",
        steps: [shell("one", "echo"), shell("two", "echo", ["one"])],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [{ stepName: "one", status: "succeeded" }, { stepName: "two" }],
  }, { env: "dev" });
  assertStringIncludes(await refusal(wf, run, { env: "prod" }), '"one"');
  // Before any step ran, nothing read it.
  const fresh = storedRun(wf, "suspended", {
    main: [{ stepName: "one" }, { stepName: "two" }],
  }, { env: "dev" });
  await accepts(wf, fresh, { env: "prod" });
});

Deno.test("checkResumeInputOverrides: a record the workflow no longer has reads every input", async () => {
  // The gate was renamed since the run: its record maps to no step.
  const wf = Workflow.create({
    name: "renamed",
    jobs: [
      Job.create({
        name: "main",
        steps: [shell("check", "echo"), shell("after", "echo", ["check"])],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [{ stepName: "gate", status: "succeeded" }, { stepName: "after" }],
  });
  assertStringIncludes(
    await refusal(wf, run, { anything: "x" }),
    'used by step "gate"',
  );
});

Deno.test("checkResumeInputOverrides: --from names the first step that used any refused input", async () => {
  const wf = Workflow.create({
    name: "two-keys",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          shell("s1", "echo ${{ inputs.b }}"),
          shell("s2", "echo", ["s1"]),
          shell("s3", "echo ${{ inputs.a }}", ["s2"]),
          shell("s4", "echo", ["s3"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "failed", {
    main: [
      { stepName: "s1", status: "succeeded" },
      { stepName: "s2", status: "succeeded" },
      { stepName: "s3", status: "succeeded" },
      { stepName: "s4", status: "failed" },
    ],
  }, { a: 1, b: 1 });
  const message = await refusal(
    wf,
    run,
    { a: 2, b: 2 },
    planFailedRunResume(wf, run),
  );
  assertStringIncludes(message, `--run ${run.id} --from s1)`);
  // Retrying from there resets every step that used them.
  await accepts(wf, run, { a: 2, b: 2 }, planFailedRunResume(wf, run, "s1"));
});
