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
import { checkResumeInputOverrides } from "./resume_input_guard.ts";
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

function accepts(
  wf: Workflow,
  run: WorkflowRun,
  inputs: Record<string, unknown>,
): void {
  const before = JSON.stringify(run.toData());
  checkResumeInputOverrides(wf, run, inputs);
  assertEquals(JSON.stringify(run.toData()), before, "run was mutated");
}

function refusal(
  wf: Workflow,
  run: WorkflowRun,
  inputs: Record<string, unknown>,
): string {
  const before = JSON.stringify(run.toData());
  try {
    checkResumeInputOverrides(wf, run, inputs);
  } catch (error) {
    assert(error instanceof UserError, `expected UserError, got ${error}`);
    assertEquals(error.code, "resume_input_immutable");
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

Deno.test("checkResumeInputOverrides: refuses changing a value the run has", () => {
  // The issue's path 2: the gate passed and the approver saw "scratch".
  const wf = gatedDestroy();
  const run = approvedRun(wf);
  const message = refusal(wf, run, { target: "protected" });
  assertStringIncludes(
    message,
    'input "target" already has a value, and a value a run has cannot change',
  );
  assertStringIncludes(
    message,
    `To cancel it: 'swamp workflow cancel gated-destroy --run ${run.id}'. Then start a new run with all its inputs (swamp workflow run gated-destroy --input ...)`,
  );
  assertEquals(message.includes("protected"), false, "message leaks a value");
  assertEquals(message.includes("scratch"), false, "message leaks a value");
});

Deno.test("checkResumeInputOverrides: refuses regardless of what any step read", () => {
  // The check reads the run record only: a value the run has is pinned even
  // when no step that ran names it, and an approval whose prompt hides it
  // pins it too.
  const wf = Workflow.create({
    name: "unread",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          approval("verify", "Proceed?", []),
          shell("act", "echo ${{ inputs.target }}", ["verify"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [{ stepName: "verify", status: "succeeded" }, { stepName: "act" }],
  });
  refusal(wf, run, { target: "protected" });
});

Deno.test("checkResumeInputOverrides: accepts a key the run does not have", () => {
  // A late input: a vault key name minted during the gate, read only after
  // it (swamp-club#467).
  const wf = Workflow.create({
    name: "deploy",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          approval("verify", "Verify SSH", []),
          shell("harden", "use ${{ inputs.?authKey.orValue('') }}", ["verify"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [{ stepName: "verify", status: "succeeded" }, { stepName: "harden" }],
  }, { region: "us-east" });
  accepts(wf, run, { authKey: "tskey-abc" });
  accepts(wf, run, { authKey: "tskey-abc", other: { nested: true } });
});

Deno.test("checkResumeInputOverrides: accepts a key the run does not have even when a finished step tested for it", () => {
  // The limit the design accepts (design/enablers/input-pinning.md, Late
  // inputs): `check` ran `has(inputs.force)` and saw the key absent. Whether
  // it did cannot be told without reading what the step evaluated, which is
  // the inference this check does not do. The key is added. A check that
  // must bind a late input runs after the input arrives.
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
  accepts(wf, run, { force: true });
});

Deno.test("checkResumeInputOverrides: an input re-passed with its stored value is not a change", () => {
  const wf = gatedDestroy();
  const run = approvedRun(wf);
  accepts(wf, run, { target: "scratch" });
});

Deno.test("checkResumeInputOverrides: a nested override is compared at its top-level key", () => {
  const wf = Workflow.create({
    name: "nested",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          shell("gate", "echo ${{ inputs.creds.key }}"),
          shell("act", "echo", ["gate"]),
        ],
      }),
    ],
  });
  const run = storedRun(wf, "suspended", {
    main: [{ stepName: "gate", status: "succeeded" }, { stepName: "act" }],
  }, { creds: { user: "u", key: "old" } });
  // Merged, the same value: no change.
  accepts(wf, run, { creds: { key: "old" } });
  // Merged, a different value: the top-level key changes.
  refusal(wf, run, { creds: { key: "new" } });
  // Merged, a key added inside: the top-level key changes too.
  refusal(wf, run, { creds: { extra: 1 } });
});

Deno.test("checkResumeInputOverrides: a value is compared after type coercion", () => {
  // The caller coerces supplied values to the schema's types before the
  // check, so a stored number and a coerced number compare equal.
  const wf = gatedDestroy();
  const run = approvedRun(wf, { target: "scratch", count: 3 });
  accepts(wf, run, { count: 3 });
  refusal(wf, run, { count: 4 });
});

Deno.test("checkResumeInputOverrides: a failed run's retry makes no difference", () => {
  // A --from retry runs the step again, but the value it ran with stays.
  const wf = gatedDestroy();
  const run = storedRun(wf, "failed", {
    main: [
      { stepName: "gate", status: "succeeded" },
      { stepName: "approve", status: "succeeded" },
      { stepName: "destroy", status: "failed" },
    ],
  });
  const message = refusal(wf, run, { target: "protected" });
  assertStringIncludes(
    message,
    "Start a new run with all its inputs (swamp workflow run gated-destroy --input ...)",
  );
  assertEquals(message.includes("--from"), false);
  assertEquals(message.includes("cancel"), false);
});

Deno.test("checkResumeInputOverrides: an input named like an Object property is compared as the run's own", () => {
  const wf = Workflow.create({
    name: "own-keys",
    jobs: [
      Job.create({
        name: "main",
        steps: [
          shell("first", "echo ${{ inputs.constructor }}"),
          shell("second", "echo", ["first"]),
        ],
      }),
    ],
  });
  const absent = storedRun(wf, "suspended", {
    main: [{ stepName: "first", status: "succeeded" }, { stepName: "second" }],
  }, {});
  // Not an own property of the stored inputs: added, not changed.
  accepts(wf, absent, { constructor: "x" });
  const present = storedRun(wf, "suspended", {
    main: [{ stepName: "first", status: "succeeded" }, { stepName: "second" }],
  }, { constructor: "x" });
  accepts(wf, present, { constructor: "x" });
  refusal(wf, present, { constructor: "y" });
});

Deno.test("checkResumeInputOverrides: a refusal of several inputs names them all and fits serve's error limit", () => {
  const wf = gatedDestroy();
  const run = approvedRun(wf, { target: "a", region: "b", account: "c" });
  // refusal() asserts the 512-character bound.
  const message = refusal(wf, run, {
    target: "x",
    region: "y",
    account: "z",
    added: "ok",
  });
  assertStringIncludes(
    message,
    'inputs "target", "region", "account" already have values',
  );
  assertEquals(message.includes("added"), false);
});

Deno.test("checkResumeInputOverrides: a serve-started run is pointed to cancel it through serve", () => {
  const wf = gatedDestroy();
  const data = approvedRun(wf).toData();
  data.instanceId = "serve-a";
  const run = WorkflowRun.fromData(data);
  const message = refusal(wf, run, { target: "protected" });
  assertStringIncludes(
    message,
    `'swamp workflow cancel --run ${run.id} --server <url>'`,
  );
  assertEquals(message.includes("swamp workflow cancel gated-destroy"), false);
});

Deno.test("checkResumeInputOverrides: a key an older swamp resumed with, and recorded no value for, cannot take another", () => {
  // Before swamp-club#3583 a resume listed the keys it supplied and kept the
  // run's inputs as started. Such a run has the key with a value nothing can
  // compare, so it is pinned like any other.
  const wf = gatedDestroy();
  const data = approvedRun(wf, { target: "scratch" }).toData();
  data.resumeInputs = ["authKey"];
  const run = WorkflowRun.fromData(data);
  const message = refusal(wf, run, { authKey: "other" });
  assertStringIncludes(
    message,
    'input "authKey" was supplied at an earlier resume, which recorded no value to compare with, and a value a run has cannot change',
  );
  assertEquals(message.includes("other"), false, "message leaks a value");
  // Both kinds in one refusal, and a key the run never had still added.
  const both = refusal(wf, run, { target: "x", authKey: "y", region: "eu" });
  assertStringIncludes(both, 'input "target" already has a value');
  assertStringIncludes(both, 'input "authKey" was supplied');
  assertEquals(both.includes("region"), false);
  accepts(wf, run, { region: "eu" });
});

Deno.test("checkResumeInputOverrides: nothing supplied is nothing to check", () => {
  const wf = gatedDestroy();
  accepts(wf, approvedRun(wf), {});
});
