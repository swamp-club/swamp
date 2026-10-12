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

import { assertEquals } from "@std/assert";
import {
  buildRunGraph,
  describeCondition,
  displayStatus,
  elapsed,
  evaluateCondition,
  failureTarget,
  firstFailure,
  jobSummary,
  type RunLike,
  stepProgress,
  type WorkflowDefinitionLike,
} from "./run_graph_model.ts";

const definition: WorkflowDefinitionLike = {
  jobs: [
    { name: "load", dependsOn: [] },
    {
      name: "notify",
      dependsOn: [{ job: "load", condition: { type: "succeeded" } }],
    },
    {
      name: "apply",
      dependsOn: [
        { job: "notify", condition: { type: "succeeded" } },
        { job: "load", condition: { type: "succeeded" } },
      ],
    },
    {
      name: "cleanup",
      dependsOn: [{ job: "notify", condition: { type: "failed" } }],
    },
    { name: "removed-since", dependsOn: [{ job: "load" }] },
  ],
};

const failedRun: RunLike = {
  status: "failed",
  jobs: [
    {
      name: "load",
      status: "succeeded",
      duration: 1500,
      steps: [{ name: "load-1", status: "succeeded" }],
    },
    {
      name: "notify",
      status: "failed",
      steps: [
        { name: "notify-1", status: "failed", error: "exit 1" },
        { name: "notify-2", status: "failed", allowedFailure: true },
        { name: "notify-3", status: "succeeded" },
      ],
    },
    {
      name: "apply",
      status: "skipped",
      steps: [{
        name: "apply-1",
        status: "skipped",
        skipReason: { kind: "job_skipped" },
      }],
    },
    {
      name: "cleanup",
      status: "running",
      startedAt: "2026-10-12T10:00:00.000Z",
      steps: [{ name: "cleanup-1", status: "running" }],
    },
  ],
};

Deno.test("buildRunGraph: nodes follow the run, edges the definition", () => {
  const graph = buildRunGraph(failedRun, definition);
  assertEquals(graph.jobs.map((j) => j.name), [
    "load",
    "notify",
    "apply",
    "cleanup",
  ]);
  assertEquals(graph.hasDependencies, true);
  assertEquals(
    graph.edges.map((e) => `${e.from}->${e.to}:${e.state}`),
    [
      "load->notify:met",
      "notify->apply:unmet",
      "load->apply:met",
      "notify->cleanup:met",
    ],
  );
});

Deno.test("buildRunGraph: edges into a job still going animate", () => {
  const graph = buildRunGraph({ ...failedRun, status: "running" }, definition);
  const active = graph.edges.filter((e) => e.active).map((e) => e.to);
  assertEquals(active, ["cleanup"]);
});

Deno.test("buildRunGraph: a failed job names the step that failed it", () => {
  const graph = buildRunGraph(failedRun, definition);
  const notify = graph.jobs.find((j) => j.name === "notify")!;
  assertEquals(notify.status, "failed");
  assertEquals(notify.failedStep, { name: "notify-1", error: "exit 1" });
  assertEquals(notify.allowedFailures, 1);
  assertEquals(notify.stepsDone, 3);
  assertEquals(notify.stepsTotal, 3);
});

Deno.test("buildRunGraph: a finished run shows unreached work as stopped", () => {
  const graph = buildRunGraph(failedRun, definition);
  assertEquals(
    graph.jobs.find((j) => j.name === "cleanup")!.status,
    "cancelled",
  );
});

Deno.test("buildRunGraph: without a definition there are no edges", () => {
  const graph = buildRunGraph(failedRun, null);
  assertEquals(graph.edges, []);
  assertEquals(graph.hasDependencies, false);
  assertEquals(graph.jobs.length, 4);
});

Deno.test("buildRunGraph: nested workflow steps link their child run", () => {
  const graph = buildRunGraph({
    status: "suspended",
    nestedWaits: [{ runId: "child-1", stepName: "deploy", status: "running" }],
    jobs: [{
      name: "release",
      status: "waiting_approval",
      steps: [{
        name: "deploy",
        status: "waiting_approval",
        nestedRun: { workflowName: "deploy-app", runId: "child-1" },
      }],
    }],
  }, null);
  const job = graph.jobs[0];
  assertEquals(job.status, "waiting");
  assertEquals(job.waitingOn, "nested");
  assertEquals(job.nested, [{
    stepName: "deploy",
    workflowName: "deploy-app",
    runId: "child-1",
    status: "running",
  }]);
  assertEquals(jobSummary(job), "Waiting on a nested run");
});

Deno.test("buildRunGraph: approval and signal waits are told apart", () => {
  const graph = buildRunGraph({
    status: "suspended",
    jobs: [
      {
        name: "gate",
        status: "waiting_approval",
        steps: [{ name: "sign-off", status: "waiting_approval" }],
      },
      {
        name: "hook",
        status: "waiting",
        steps: [{ name: "await", status: "waiting" }],
      },
    ],
  }, null);
  assertEquals(graph.jobs.map((j) => j.waitingOn), ["approval", "signal"]);
});

Deno.test("displayStatus: maps run statuses to what a node shows", () => {
  assertEquals(displayStatus("succeeded"), "succeeded");
  assertEquals(displayStatus("waiting_approval"), "waiting");
  assertEquals(displayStatus("waiting_signal", "suspended"), "waiting");
  assertEquals(displayStatus("pending", "running"), "pending");
  assertEquals(displayStatus("pending", "cancelled"), "cancelled");
  assertEquals(displayStatus("running", "interrupted"), "cancelled");
  assertEquals(displayStatus("weird"), "unknown");
});

Deno.test("evaluateCondition: follows the trigger condition grammar", () => {
  assertEquals(evaluateCondition({ type: "succeeded" }, "running"), null);
  assertEquals(evaluateCondition(undefined, "succeeded"), true);
  assertEquals(evaluateCondition({ type: "always" }, "failed"), true);
  assertEquals(evaluateCondition({ type: "completed" }, "failed"), true);
  assertEquals(evaluateCondition({ type: "completed" }, "skipped"), false);
  assertEquals(
    evaluateCondition({
      type: "or",
      conditions: [{ type: "failed" }, { type: "skipped" }],
    }, "skipped"),
    true,
  );
  assertEquals(
    evaluateCondition({
      type: "not",
      condition: { type: "succeeded" },
    }, "succeeded"),
    false,
  );
  assertEquals(
    evaluateCondition({
      type: "and",
      conditions: [{ type: "completed" }, {
        type: "not",
        condition: { type: "failed" },
      }],
    }, "succeeded"),
    true,
  );
});

Deno.test("describeCondition: reads like the YAML", () => {
  assertEquals(describeCondition(undefined), "succeeded");
  assertEquals(describeCondition({ type: "failed" }), "failed");
  assertEquals(
    describeCondition({
      type: "not",
      condition: {
        type: "or",
        conditions: [{ type: "failed" }, { type: "skipped" }],
      },
    }),
    "not (failed or skipped)",
  );
});

Deno.test("elapsed: recorded duration, else live time since start", () => {
  const now = Date.parse("2026-10-12T10:00:05.000Z");
  assertEquals(elapsed({ duration: 42 }, now, true), 42);
  assertEquals(
    elapsed({ startedAt: "2026-10-12T10:00:00.000Z" }, now, true),
    5000,
  );
  assertEquals(
    elapsed({ startedAt: "2026-10-12T10:00:00.000Z" }, now, false),
    undefined,
  );
  assertEquals(
    elapsed(
      {
        startedAt: "2026-10-12T10:00:00.000Z",
        completedAt: "2026-10-12T10:00:02.000Z",
      },
      now,
      false,
    ),
    2000,
  );
  assertEquals(elapsed({}, now, true), undefined);
});

Deno.test("stepProgress and firstFailure: summarise the run", () => {
  assertEquals(stepProgress(failedRun), { done: 5, total: 6 });
  assertEquals(firstFailure(failedRun), {
    job: "notify",
    step: "notify-1",
    error: "exit 1",
  });
  assertEquals(firstFailure({ status: "succeeded", jobs: [] }), null);
});

Deno.test("jobSummary: says why a job is not moving", () => {
  const graph = buildRunGraph(failedRun, definition);
  assertEquals(graph.jobs.map(jobSummary), [
    "1/1 step",
    "3/3 steps",
    "Skipped",
    "Did not finish",
  ]);
});

Deno.test("failureTarget: the named step, else the first failure", () => {
  assertEquals(failureTarget(failedRun), { job: "notify", step: "notify-1" });
  assertEquals(failureTarget(failedRun, "notify-2"), {
    job: "notify",
    step: "notify-2",
  });
  assertEquals(failureTarget(failedRun, "no-such-step"), {
    job: "notify",
    step: "notify-1",
  });
  assertEquals(failureTarget({ status: "succeeded", jobs: [] }), null);
});
