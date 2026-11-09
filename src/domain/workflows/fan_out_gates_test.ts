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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { fanOutGateName, fanOutGateOf } from "../remote/fan_out.ts";
import {
  fanOutGatePrompt,
  fanOutGatePromptText,
  fanOutGates,
  gateApproved,
  plannedGateNames,
} from "./fan_out_gates.ts";
import { laneStepOf, planLaneSteps } from "./fan_out_lanes.ts";
import type { JobRunData, StepRunData } from "./workflow_run.ts";

function step(
  stepName: string,
  status: StepRunData["status"],
  extra: Partial<StepRunData> = {},
): StepRunData {
  return { stepName, status, ...extra };
}

function gatedJob(steps: StepRunData[]): JobRunData {
  return {
    jobName: "patch",
    status: "running",
    steps,
    fanOutPlan: {
      members: [
        { worker: "a", instanceUuid: "u-a", disposition: "dispatch", batch: 0 },
        { worker: "b", instanceUuid: "u-b", disposition: "dispatch", batch: 1 },
        {
          worker: "c",
          instanceUuid: "u-c",
          disposition: "waiting",
          reason: "disconnected",
          batch: 1,
        },
        {
          worker: "d",
          instanceUuid: "u-d",
          disposition: "excluded",
          reason: "draining",
        },
      ],
      plannedLanes: 3,
      maxFailures: 0,
      batches: [["a"], ["b", "c"]],
      lanes: ["a", "b", "c"].map((worker) => ({
        name: `patch[${worker}]`,
        worker,
        instanceUuid: `u-${worker}`,
        steps: [],
      })),
    },
    fanOutSnapshot: { selector: { labels: { role: "web" } }, workers: [] },
  };
}

Deno.test("fanOutGateName: gates take the job[worker] lane form and are recognised by name", () => {
  assertEquals(fanOutGateName("patch", "plan"), "patch[approve-plan]");
  assertEquals(fanOutGateName("patch", "canary"), "patch[approve-canary]");
  assertEquals(fanOutGateOf("patch", "patch[approve-plan]"), "plan");
  assertEquals(fanOutGateOf("patch", "patch[approve-canary]"), "canary");
  assertEquals(fanOutGateOf("other", "patch[approve-plan]"), undefined);
  assertEquals(fanOutGateOf("patch", "apply[approve-plan]"), undefined);
});

Deno.test("planLaneSteps: a worker named as a gate is refused only when that gate is planned", () => {
  assertThrows(
    () => planLaneSteps("patch", ["apply"], ["approve-plan"], ["plan"]),
    Error,
    "worker 'approve-plan' has the name its plan approval gate takes",
  );
  // the lane patch[approve-plan] of step patch would be the gate's record
  assertThrows(
    () => planLaneSteps("patch", ["patch"], ["approve-canary"], ["canary"]),
    Error,
    "canary approval gate",
  );
  assertEquals(
    planLaneSteps("patch", ["apply"], ["approve-plan"], ["canary"]).size,
    1,
  );
  assertEquals(planLaneSteps("patch", ["apply"], ["approve-plan"]).size, 1);
});

Deno.test("plannedGateNames: a canary gate needs a batch after the canary", () => {
  assertEquals(plannedGateNames("patch", ["plan", "canary"], 2), [
    "patch[approve-plan]",
    "patch[approve-canary]",
  ]);
  assertEquals(plannedGateNames("patch", ["canary"], 1), []);
  assertEquals(plannedGateNames("patch", ["canary", "plan"], 1), [
    "patch[approve-plan]",
  ]);
  assertEquals(plannedGateNames("patch", [], 3), []);
});

Deno.test("fanOutGates: finds gate records, never as lanes of the plan", () => {
  const job = gatedJob([
    step("patch[approve-plan]", "succeeded"),
    step("apply[a]", "pending"),
    step("patch[approve-canary]", "pending"),
  ]);
  const gates = fanOutGates(job);
  assertEquals([...gates.keys()], ["plan", "canary"]);
  assertEquals(
    laneStepOf("patch[approve-plan]", job.fanOutPlan!.lanes),
    undefined,
  );
  assertEquals(fanOutGates({ ...job, fanOutPlan: undefined }).size, 0);
});

Deno.test("gateApproved: only a succeeded gate with an approving decision", () => {
  const decidedAt = new Date().toISOString();
  assertEquals(
    gateApproved(
      step("g", "succeeded", {
        approvalDecision: { approved: true, decidedAt },
      }),
    ),
    true,
  );
  assertEquals(gateApproved(step("g", "succeeded")), false);
  assertEquals(
    gateApproved(
      step("g", "failed", { approvalDecision: { approved: false, decidedAt } }),
    ),
    false,
  );
  assertEquals(gateApproved(step("g", "waiting_approval")), false);
  assertEquals(gateApproved(undefined), false);
});

Deno.test("fanOutGatePrompt: the plan gate names every member, its disposition, the batches and the budget", () => {
  const prompt = fanOutGatePrompt(gatedJob([]), "plan")!;
  assertEquals(prompt.gate, "plan");
  assertEquals(prompt.selector, { labels: { role: "web" } });
  assertEquals(prompt.members, [
    { worker: "a", disposition: "dispatch", batch: 0 },
    { worker: "b", disposition: "dispatch", batch: 1 },
    { worker: "c", disposition: "waiting", reason: "disconnected", batch: 1 },
    { worker: "d", disposition: "excluded", reason: "draining" },
  ]);
  assertEquals(prompt.batches, [["a"], ["b", "c"]]);
  assertEquals(prompt.budget, { allowed: 0 });
  assertEquals(prompt.canary, undefined);
  const text = fanOutGatePromptText(prompt);
  assertStringIncludes(text, "Approve the fan-out plan of job 'patch'");
  assertStringIncludes(text, "Selector: role=web");
  assertStringIncludes(text, "d: excluded (draining), no lane");
  assertStringIncludes(text, "c: waiting (disconnected), lane in batch 2");
  assertStringIncludes(text, "Batch 2: b, c");
  assertStringIncludes(text, "Budget: 0 failed lane(s) allowed");
});

Deno.test("fanOutGatePrompt: the canary gate shows the canary's results, failed assertions, budget used and the next batch", () => {
  const prompt = fanOutGatePrompt(
    gatedJob([
      step("apply[a]", "succeeded"),
      step("check[a]", "succeeded", {
        assertResult: {
          passed: false,
          expr: "x",
          message: "disk above 80%",
          severity: "low",
        },
      }),
      step("apply[b]", "pending"),
      step("apply[c]", "pending"),
    ]),
    "canary",
  )!;
  assertEquals(prompt.budget, { allowed: 0, used: 0 });
  assertEquals(prompt.canary, {
    lanes: [{
      worker: "a",
      status: "succeeded",
      failedSteps: [],
      assertions: [{
        step: "check[a]",
        severity: "low",
        message: "disk above 80%",
      }],
    }],
  });
  assertEquals(prompt.next, ["b", "c"]);
  const text = fanOutGatePromptText(prompt);
  assertStringIncludes(text, "Canary a: succeeded");
  assertStringIncludes(text, "assertion check[a] (low): disk above 80%");
  assertStringIncludes(text, "Next batch: b, c");
  assertStringIncludes(text, "Budget: 0 used, 0 failed lane(s) allowed");
});

Deno.test("fanOutGatePrompt: a failed canary lane counts as budget used", () => {
  const prompt = fanOutGatePrompt(
    gatedJob([
      step("apply[a]", "failed", { error: "exit 1" }),
      step("tidy[a]", "failed", { allowedFailure: true }),
    ]),
    "canary",
  )!;
  assertEquals(prompt.budget.used, 1);
  assertEquals(prompt.canary!.lanes[0].failedSteps, [
    { step: "apply[a]", error: "exit 1" },
  ]);
});

Deno.test("fanOutGatePrompt: none without a plan", () => {
  assertEquals(
    fanOutGatePrompt({ jobName: "patch", steps: [] }, "plan"),
    undefined,
  );
});

Deno.test("fanOutGatePrompt: canary errors and assertion messages pass through the run's mask", () => {
  const prompt = fanOutGatePrompt(
    gatedJob([
      step("apply[a]", "failed", { error: "token s3cret refused" }),
      step("check[a]", "succeeded", {
        assertResult: {
          passed: false,
          expr: "x",
          message: "saw s3cret",
          severity: "high",
        },
      }),
    ]),
    "canary",
    (text) => text.replaceAll("s3cret", "***"),
  )!;
  assertEquals(
    prompt.canary!.lanes[0].failedSteps[0].error,
    "token *** refused",
  );
  assertEquals(prompt.canary!.lanes[0].assertions[0].message, "saw ***");
});

Deno.test("fanOutGatePromptText: a line break inside a value cannot add a line", () => {
  const prompt = fanOutGatePrompt(
    gatedJob([
      step("apply[a]", "failed", {
        error: "exit 1\nCanary a: succeeded\nBudget: 0 used",
      }),
    ]),
    "canary",
  )!;
  const lines = fanOutGatePromptText(prompt).split("\n");
  assertEquals(lines.filter((line) => line.startsWith("Canary a:")), [
    "Canary a: failed",
  ]);
  assertEquals(lines.filter((line) => line.startsWith("Budget:")).length, 1);
  assertStringIncludes(
    lines.find((line) => line.includes("failed apply[a]"))!,
    "exit 1\\x0aCanary a: succeeded",
  );
});
