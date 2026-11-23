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
import { fanOutJobView } from "./fan_out_view.ts";
import type { JobRunData, StepRunData } from "./workflow_run.ts";

const PLAN_GATE = "patch[approve-plan]";
const CANARY_GATE = "patch[approve-canary]";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";

function step(
  stepName: string,
  status: StepRunData["status"],
  extra: Partial<StepRunData> = {},
): StepRunData {
  return { stepName, status, ...extra };
}

const held = (name: string) =>
  step(name, "skipped", { skipReason: { kind: "job_skipped" } });

function job(
  steps: StepRunData[],
  extra: Partial<JobRunData> = {},
): JobRunData {
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
    ...extra,
  };
}

function lanes(view: ReturnType<typeof fanOutJobView>) {
  return Object.fromEntries(
    view!.members.map((member) => [member.worker, member.lane]),
  );
}

Deno.test("fanOutJobView: a job without a plan has no view", () => {
  const { fanOutPlan: _, ...plain } = job([]);
  assertEquals(fanOutJobView(plain), undefined);
});

Deno.test("fanOutJobView: members keep disposition, reason and batch, and only lanes get a result", () => {
  const view = fanOutJobView(job([
    step("apply[a]", "succeeded", { startedAt: T0 }),
    step("apply[b]", "running", { startedAt: T0 }),
    step("apply[c]", "pending"),
  ]))!;
  assertEquals(view.selector, { labels: { role: "web" } });
  assertEquals(view.plannedLanes, 3);
  assertEquals(view.batches, [["a"], ["b", "c"]]);
  assertEquals(view.members[2], {
    worker: "c",
    disposition: "waiting",
    reason: "disconnected",
    batch: 1,
    lane: "not_run",
  });
  assertEquals(view.members[3], {
    worker: "d",
    disposition: "excluded",
    reason: "draining",
  });
  assertEquals(lanes(view), {
    a: "succeeded",
    b: "running",
    c: "not_run",
    d: undefined,
  });
  assertEquals(view.halts, []);
  assertEquals(view.gates, []);
  assertEquals(view.resume, undefined);
  assertEquals(view.policy, undefined);
});

Deno.test("fanOutJobView: no instance UUID reaches the view", () => {
  const view = fanOutJobView(job([step("apply[a]", "succeeded")]));
  assert(!JSON.stringify(view).includes("u-"));
});

Deno.test("fanOutJobView: a failed lane names its failing step, error and assertion, masked", () => {
  const view = fanOutJobView(
    job([
      step("apply[a]", "succeeded", { startedAt: T0 }),
      step("verify[a]", "failed", {
        startedAt: T0,
        error: "health check saw SECRET",
        assertResult: {
          passed: false,
          expr: "x",
          message: "status was SECRET",
          severity: "high",
        },
      }),
      step("apply[b]", "failed", { allowedFailure: true, error: "tolerated" }),
    ]),
    { mask: (text) => text.replaceAll("SECRET", "***") },
  )!;
  assertEquals(view.members[0].lane, "failed");
  assertEquals(view.members[0].failedSteps, [
    { step: "verify[a]", error: "health check saw ***" },
  ]);
  assertEquals(view.members[0].assertions, [
    { step: "verify[a]", severity: "high", message: "status was ***" },
  ]);
  // an allowed failure neither fails the lane nor spends the budget
  assertEquals(view.members[1].lane, "succeeded");
  assertEquals(view.members[1].failedSteps, undefined);
  assertEquals(view.budget, { allowed: 0, used: 1 });
});

Deno.test("fanOutJobView: a budget halt holds the lanes it names and is kept as recorded", () => {
  const view = fanOutJobView(job(
    [
      step("apply[a]", "failed", { startedAt: T0, error: "boom" }),
      held("apply[b]"),
      held("apply[c]"),
    ],
    {
      status: "failed",
      fanOutHalts: [{
        batch: 1,
        maxFailures: 0,
        failed: ["a"],
        held: [
          "b",
          "c",
        ],
      }],
    },
  ))!;
  assertEquals(lanes(view), {
    a: "failed",
    b: "held",
    c: "held",
    d: undefined,
  });
  assertEquals(view.halts, [{
    reason: "budget",
    batch: 1,
    maxFailures: 0,
    failed: ["a"],
    held: ["b", "c"],
  }]);
});

Deno.test("fanOutJobView: a lane skipped with job_skipped that no halt or rejection named is not held", () => {
  const view = fanOutJobView(job([
    step("apply[a]", "succeeded", { startedAt: T0 }),
    held("apply[b]"),
    step("apply[c]", "skipped", {
      skipReason: { kind: "guarded", expression: "false" },
    }),
  ]))!;
  // a cancelled lane settles as job_skipped too: never run, not held
  assertEquals(view.members[1].lane, "not_run");
  // a guarded skip ran its guard: the lane passed
  assertEquals(view.members[2].lane, "succeeded");
});

Deno.test("fanOutJobView: a rejected gate is a final halt holding the lanes it stopped", () => {
  const view = fanOutJobView(job(
    [
      step(PLAN_GATE, "succeeded", {
        approvalDecision: { approved: true, decidedAt: T0, decidedBy: "u1" },
      }),
      step(CANARY_GATE, "failed", {
        startedAt: T1,
        approvalDecision: {
          approved: false,
          decidedAt: T2,
          decidedBy: "u2",
          reason: "canary looked wrong",
        },
      }),
      step("apply[a]", "succeeded", { startedAt: T0 }),
      held("apply[b]"),
      held("apply[c]"),
    ],
    { status: "failed" },
  ))!;
  assertEquals(view.gates, [
    { kind: "plan", step: PLAN_GATE, status: "approved" },
    { kind: "canary", step: CANARY_GATE, status: "rejected" },
  ]);
  assertEquals(view.halts, [{
    reason: "gate_rejected",
    gate: "canary",
    held: ["b", "c"],
  }]);
  assertEquals(lanes(view), {
    a: "succeeded",
    b: "held",
    c: "held",
    d: undefined,
  });
});

Deno.test("fanOutJobView: a gate still waiting past its approveTimeout reads expired", () => {
  const waiting = (timeout?: number) =>
    job([
      step(PLAN_GATE, "waiting_approval", {
        startedAt: T0,
        ...(timeout !== undefined ? { approvalTimeout: timeout } : {}),
      }),
      step("apply[a]", "pending"),
    ]);
  const now = new Date(T2);
  assertEquals(fanOutJobView(waiting(60), { now })!.gates, [{
    kind: "plan",
    step: PLAN_GATE,
    status: "expired",
    expiredAt: T1,
  }]);
  assertEquals(
    fanOutJobView(waiting(600), { now })!.gates[0].status,
    "waiting",
  );
  assertEquals(fanOutJobView(waiting(), { now })!.gates[0].status, "waiting");
});

Deno.test("fanOutJobView: an unreached gate reads held, and a gate not yet asked reads pending", () => {
  const view = fanOutJobView(job([
    step(PLAN_GATE, "pending"),
    step(CANARY_GATE, "skipped", { skipReason: { kind: "job_skipped" } }),
    step("apply[a]", "pending"),
  ]))!;
  assertEquals(view.gates.map((gate) => gate.status), ["pending", "held"]);
});

Deno.test("fanOutJobView: two halts stay in order and the latest resume names what it reran and kept", () => {
  const view = fanOutJobView(
    job(
      [
        step("apply[a]", "succeeded", { startedAt: T0, completedAt: T0 }),
        step("apply[b]", "succeeded", { startedAt: T2, completedAt: T2 }),
        step("apply[c]", "pending"),
      ],
      {
        fanOutHalts: [
          { batch: 0, maxFailures: 0, failed: ["a"], held: ["b", "c"] },
          { batch: 1, maxFailures: 0, failed: ["b"], held: ["c"] },
        ],
      },
    ),
    { resumedAt: T1 },
  )!;
  assertEquals(view.halts.map((halt) => halt.reason), ["budget", "budget"]);
  assertEquals(view.halts[1], {
    reason: "budget",
    batch: 1,
    maxFailures: 0,
    failed: ["b"],
    held: ["c"],
  });
  assertEquals(view.resume, { at: T1, rerun: ["b", "c"], kept: ["a"] });
});

Deno.test("fanOutJobView: a lane held again by the resumed attempt reads rerun, and a guard-only kept lane reads kept", () => {
  const view = fanOutJobView(
    job(
      [
        step("apply[a]", "skipped", {
          skipReason: { kind: "guarded", expression: "false" },
        }),
        step("apply[b]", "failed", { startedAt: T2, error: "boom" }),
        held("apply[c]"),
      ],
      {
        fanOutHalts: [
          { batch: 1, maxFailures: 0, failed: ["b"], held: ["c"] },
        ],
      },
    ),
    { resumedAt: T1 },
  )!;
  assertEquals(view.resume, { at: T1, rerun: ["b", "c"], kept: ["a"] });
});

Deno.test("fanOutJobView: the policy is shown only when it is supplied", () => {
  const view = fanOutJobView(job([]), {
    policy: { offline: "skip", minWorkers: 2 },
  })!;
  assertEquals(view.policy, { offline: "skip", minWorkers: 2 });
});
