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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  averageDuration,
  compareRuns,
  filterWebhooks,
  formatInputsJson,
  inputRows,
  legacySince,
  parseInputsJson,
  routesByWorkflow,
  runsOfTrigger,
  runStatusBucket,
  runsWithin,
  scheduleErrorMessage,
  successRate,
  sumCounts,
  summarizeRuns,
  toggleCompare,
  type TriggerRun,
  valueText,
  webhookWorkflowName,
} from "./triggers.ts";

const run = (over: Partial<TriggerRun> & { runId: string }): TriggerRun => ({
  workflowName: "deploy-api",
  status: "succeeded",
  triggerSource: "schedule",
  ...over,
});

Deno.test("runsOfTrigger: keeps one trigger's runs of exactly the named workflows, newest first", () => {
  const runs = [
    run({ runId: "a", startedAt: "2026-10-12T10:00:00Z" }),
    run({ runId: "b", startedAt: "2026-10-12T12:00:00Z" }),
    run({
      runId: "c",
      triggerSource: "api",
      startedAt: "2026-10-12T13:00:00Z",
    }),
    run({
      runId: "d",
      workflowName: "deploy-api-v2",
      startedAt: "2026-10-12T14:00:00Z",
    }),
  ];
  assertEquals(
    runsOfTrigger(runs, "schedule", ["deploy-api"]).map((r) => r.runId),
    ["b", "a"],
  );
  assertEquals(
    runsOfTrigger(runs, "schedule").map((r) => r.runId),
    ["d", "b", "a"],
  );
});

Deno.test("summarizeRuns: counts by status, sums finished durations and keeps recent runs newest first", () => {
  const summaries = summarizeRuns([
    run({
      runId: "1",
      status: "failed",
      duration: 100,
      startedAt: "2026-10-12T01:00:00Z",
    }),
    run({
      runId: "2",
      status: "succeeded",
      duration: 300,
      startedAt: "2026-10-12T03:00:00Z",
    }),
    run({
      runId: "3",
      status: "running",
      duration: 50,
      startedAt: "2026-10-12T04:00:00Z",
    }),
    run({
      runId: "4",
      workflowName: "other",
      status: "cancelled",
      startedAt: "2026-10-12T02:00:00Z",
    }),
  ], 2);
  const deploy = summaries.find((s) => s.workflowName === "deploy-api")!;
  assertEquals(deploy.runs, 3);
  assertEquals(deploy.failed, 1);
  assertEquals(deploy.succeeded, 1);
  assertEquals(deploy.running, 1);
  assertEquals(deploy.durationMs, 400);
  assertEquals(deploy.lastStartedAt, "2026-10-12T04:00:00Z");
  assertEquals(deploy.recent.map((r) => r.runId), ["3", "2"]);
  const other = summaries.find((s) => s.workflowName === "other")!;
  assertEquals(other.cancelled, 1);
});

Deno.test("summarizeRuns: buckets interrupted as failed and pending as running, like serve", () => {
  const [deploy] = summarizeRuns([
    run({ runId: "1", status: "interrupted", duration: 100 }),
    run({ runId: "2", status: "pending" }),
    run({ runId: "3", status: "mystery", duration: 5 }),
  ]);
  assertEquals(deploy.runs, 3);
  assertEquals(deploy.failed, 1);
  assertEquals(deploy.running, 1);
  assertEquals(deploy.durationMs, 100);
  assertEquals(runStatusBucket("interrupted"), "failed");
  assertEquals(runStatusBucket("pending"), "running");
  assertEquals(runStatusBucket("succeeded"), "succeeded");
  assertEquals(runStatusBucket("mystery"), undefined);
});

Deno.test("sumCounts / averageDuration / successRate: over finished runs only", () => {
  const total = sumCounts(summarizeRuns([
    run({ runId: "1", status: "failed", duration: 100 }),
    run({ runId: "2", status: "succeeded", duration: 300 }),
    run({ runId: "3", status: "succeeded", duration: 200, workflowName: "x" }),
    run({ runId: "4", status: "running" }),
  ]));
  assertEquals(total.runs, 4);
  assertEquals(averageDuration(total), 200);
  assertEquals(successRate(total), "67%");
  assertEquals(successRate(sumCounts([])), "—");
  assertEquals(averageDuration(sumCounts([])), undefined);
});

Deno.test("webhookWorkflowName: resolves a configured id to its name", () => {
  const workflows = [{ id: "73e6", name: "deploy-api" }];
  assertEquals(webhookWorkflowName("deploy-api", workflows), "deploy-api");
  assertEquals(webhookWorkflowName("73e6", workflows), "deploy-api");
  assertEquals(webhookWorkflowName("missing", workflows), "missing");
});

Deno.test("routesByWorkflow: groups the routes sharing a workflow", () => {
  const map = routesByWorkflow([
    { route: "/hooks/push", workflowName: "deploy-api" },
    { route: "/hooks/release", workflowName: "deploy-web" },
    { route: "/hooks/mirror", workflowName: "deploy-api" },
  ]);
  assertEquals(map.get("deploy-api"), ["/hooks/mirror", "/hooks/push"]);
  assertEquals(map.get("deploy-web"), ["/hooks/release"]);
});

Deno.test("filterWebhooks: fuzzy over route and workflow", () => {
  const hooks = [
    { route: "/hooks/github-push", workflowName: "deploy-api" },
    { route: "/hooks/stripe-events", workflowName: "sync-stripe" },
  ];
  assertEquals(filterWebhooks(hooks, "gh push").map((h) => h.route), [
    "/hooks/github-push",
  ]);
  assertEquals(filterWebhooks(hooks, "sync").map((h) => h.route), [
    "/hooks/stripe-events",
  ]);
  assertEquals(filterWebhooks(hooks, "").length, 2);
});

Deno.test("scheduleErrorMessage: permission refusals read as such", () => {
  for (const code of ["unauthorized", "forbidden", "access_not_configured"]) {
    assertStringIncludes(
      scheduleErrorMessage("pause", "deploy-api", {
        code,
        message: "Access denied: …",
      }),
      "You don't have permission to pause the schedule of deploy-api",
    );
  }
  assertEquals(
    scheduleErrorMessage("save", "deploy-api", {
      code: "invalid_request",
      message: "bad cron",
    }),
    "Couldn't change the schedule: bad cron",
  );
  assertEquals(
    scheduleErrorMessage("reset", "x", { message: "socket closed" }),
    "Couldn't reset the schedule: socket closed",
  );
});

Deno.test("parseInputsJson: empty is {}, objects pass, anything else explains", () => {
  assertEquals(parseInputsJson("  "), { ok: true, value: {} });
  assertEquals(parseInputsJson('{"a": 1}'), { ok: true, value: { a: 1 } });
  for (const text of ["[1]", "1", '"x"', "null"]) {
    const parsed = parseInputsJson(text);
    assertEquals(parsed.ok, false, text);
    if (!parsed.ok) assertStringIncludes(parsed.error, "must be a JSON object");
  }
  const bad = parseInputsJson("{a:");
  assertEquals(bad.ok, false);
  if (!bad.ok) assertStringIncludes(bad.error, "Not valid JSON");
});

Deno.test("formatInputsJson: {} is an empty box, else pretty JSON", () => {
  assertEquals(formatInputsJson({}), "");
  assertEquals(formatInputsJson({ a: 1 }), '{\n  "a": 1\n}');
});

Deno.test("inputRows: marks where each effective value comes from", () => {
  assertEquals(
    inputRows(
      { region: "eu", size: 3 },
      { region: "us", size: 3 },
      { region: "eu" },
    ),
    [
      {
        key: "region",
        effective: "eu",
        builtIn: "us",
        override: "eu",
        origin: "override",
      },
      { key: "size", effective: 3, builtIn: 3, origin: "workflow" },
    ],
  );
  assertEquals(inputRows(undefined, undefined, undefined), []);
});

Deno.test("valueText: strings bare, the rest as JSON", () => {
  assertEquals(valueText("eu"), "eu");
  assertEquals(valueText(3), "3");
  assertEquals(valueText({ a: true }), '{"a":true}');
  assertEquals(valueText(undefined), "—");
});

Deno.test("compareRuns: flags differing status, inputs and steps; durations carry a delta", () => {
  const rows = compareRuns(
    {
      run: run({
        runId: "a",
        status: "succeeded",
        duration: 1000,
        triggerSource: "webhook",
        inputs: { ref: "main", sha: "abc" },
      }),
      jobs: [{
        name: "build",
        status: "succeeded",
        steps: [{ name: "compile", status: "succeeded", duration: 500 }],
      }],
    },
    {
      run: run({
        runId: "b",
        status: "failed",
        duration: 3500,
        triggerSource: "webhook",
        failedStep: "test",
        inputs: { ref: "main", sha: "def" },
      }),
      jobs: [{
        name: "build",
        status: "failed",
        steps: [
          { name: "compile", status: "succeeded", duration: 400 },
          { name: "test", status: "failed", duration: 100 },
        ],
      }],
    },
  );
  const by = (label: string) => rows.find((r) => r.label === label)!;
  assertEquals(by("Status").differs, true);
  assertEquals(by("Status").kind, "status");
  assertEquals(by("Duration").differs, false);
  assertEquals(by("Duration").delta, "+2.5s");
  assertEquals(by("Trigger").differs, false);
  assertEquals(by("Failed step").a, "—");
  assertEquals(by("Failed step").b, "test");
  assertEquals(by("ref").differs, false);
  assertEquals(by("sha").differs, true);
  assertEquals(by("build › compile").differs, false);
  assertEquals(by("build › compile").delta, "−100ms");
  assertEquals(by("build › test").a, "—");
  assertEquals(by("build › test").differs, true);
  assertEquals(rows.some((r) => r.label === "Failure"), false);
});

Deno.test("compareRuns: no step rows until a run's steps are loaded", () => {
  const rows = compareRuns({ run: run({ runId: "a" }) }, {
    run: run({ runId: "b" }),
  });
  assertEquals(rows.filter((r) => r.section === "Steps"), []);
});

Deno.test("toggleCompare: at most two, a third pick drops the earliest", () => {
  assertEquals(toggleCompare([], "a"), ["a"]);
  assertEquals(toggleCompare(["a"], "b"), ["a", "b"]);
  assertEquals(toggleCompare(["a", "b"], "c"), ["b", "c"]);
  assertEquals(toggleCompare(["a", "b"], "a"), ["b"]);
});

Deno.test("legacySince: whole hours back to `since`, rounded up", () => {
  const now = Date.parse("2026-10-12T20:30:00Z");
  assertEquals(legacySince("2026-10-05T20:30:00Z", now), "168h");
  assertEquals(legacySince("2026-10-12T20:29:00Z", now), "1h");
  assertEquals(legacySince("2026-10-12T18:00:00Z", now), "3h");
  assertEquals(legacySince(undefined, now), undefined);
  assertEquals(legacySince("garbage", now), undefined);
});

Deno.test("runsWithin: keeps runs started inside the bounds", () => {
  const runs = [
    { startedAt: "2026-10-01T00:00:00Z" },
    { startedAt: "2026-10-05T00:00:00Z" },
    { startedAt: "2026-10-09T00:00:00Z" },
    {},
  ];
  assertEquals(
    runsWithin(runs, {
      since: "2026-10-02T00:00:00Z",
      until: "2026-10-06T00:00:00Z",
    }),
    [{ startedAt: "2026-10-05T00:00:00Z" }, {}],
  );
  assertEquals(runsWithin(runs, {}).length, 4);
});
