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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type ScheduleRow,
  ScheduleTable,
  TriggerRunsTable,
  type WebhookRow,
  WebhookTable,
} from "./TriggerTables.tsx";
import { RunCompare } from "./RunCompare.tsx";
import { compareRuns, type TriggerRun } from "../lib/triggers.ts";

const NOW = Date.parse("2026-10-12T20:30:00.000Z");
const noop = () => {};

const schedule: ScheduleRow = {
  workflowName: "@acme/quota-reset",
  cron: "*/5 * * * *",
  description: "Every 5 minutes",
  nextRun: "2026-10-12T20:35:00.000Z",
  paused: false,
  source: "override",
  running: false,
  runningCount: 0,
  queueLabel: null,
  recent: [
    {
      runId: "r2-aaaaaaaa",
      status: "failed",
      startedAt: "2026-10-12T20:25:00.000Z",
    },
    {
      runId: "r1-bbbbbbbb",
      status: "succeeded",
      startedAt: "2026-10-12T20:20:00.000Z",
    },
  ],
};

Deno.test("ScheduleTable: links the schedule, describes the cron and shows its runs", () => {
  const html = renderToStaticMarkup(
    <ScheduleTable
      rows={[schedule]}
      runsLoading={false}
      now={NOW}
      onOpen={noop}
      renderControls={() => <button type="button">controls</button>}
    />,
  );
  assertStringIncludes(html, 'href="/dashboard/schedules/@acme%2Fquota-reset"');
  assertStringIncludes(html, '<span class="cron-badge">*/5 * * * *</span>');
  assertStringIncludes(html, "Every 5 minutes");
  assertStringIncludes(html, "in 5m");
  assertStringIncludes(html, "Override");
  assertStringIncludes(
    html,
    // A failed run's pip opens its failure log.
    'href="/dashboard/workflows/@acme%2Fquota-reset/runs/r2-aaaaaaaa?focus=failure"',
  );
  assertStringIncludes(html, "5m ago");
  assertStringIncludes(html, ">Idle<");
  assertStringIncludes(html, "controls</button>");
});

Deno.test("ScheduleTable: paused, running and queued states", () => {
  const html = renderToStaticMarkup(
    <ScheduleTable
      rows={[
        { ...schedule, workflowName: "a", paused: true, nextRun: null },
        {
          ...schedule,
          workflowName: "b",
          running: true,
          runningCount: 2,
          queueLabel: "1 queued · waiting 3m",
        },
      ]}
      runsLoading={false}
      now={NOW}
      onOpen={noop}
      renderControls={() => null}
    />,
  );
  assertStringIncludes(html, 'class="trig-row is-paused"');
  assertStringIncludes(html, ">Paused<");
  assertStringIncludes(html, "Running ×2");
  assertStringIncludes(html, "1 queued · waiting 3m");
});

Deno.test("ScheduleTable: placeholders while runs load", () => {
  const html = renderToStaticMarkup(
    <ScheduleTable
      rows={[schedule]}
      runsLoading
      now={NOW}
      onOpen={noop}
      renderControls={() => null}
    />,
  );
  assertStringIncludes(html, "skel");
  assertEquals(html.includes("/runs/r2-aaaaaaaa"), false);
});

const webhook: WebhookRow = {
  route: "/hooks/github-push",
  workflowName: "deploy-api",
  scheme: "github",
  sharedWith: ["/hooks/github-push-mirror"],
  recent: [{
    runId: "w1-cccccccc",
    status: "failed",
    startedAt: "2026-10-12T20:00:00.000Z",
  }],
  runs: 12,
  failed: 3,
};

Deno.test("WebhookTable: route and workflow link, counts and the shared note", () => {
  const html = renderToStaticMarkup(
    <WebhookTable
      rows={[webhook]}
      runsLoading={false}
      now={NOW}
      onOpen={noop}
    />,
  );
  assertStringIncludes(
    html,
    'href="/dashboard/webhooks/%2Fhooks%2Fgithub-push"',
  );
  assertStringIncludes(html, 'href="/dashboard/workflows/deploy-api"');
  assertStringIncludes(html, ">Verification<");
  assertStringIncludes(html, ">github<");
  assertStringIncludes(html, "Shared by 2 routes");
  assertStringIncludes(html, '<span class="trig-failed">3</span>');
  assertStringIncludes(html, ">12<");
});

Deno.test("WebhookTable: hides the verification column when serve doesn't report it", () => {
  const html = renderToStaticMarkup(
    <WebhookTable
      rows={[{ ...webhook, scheme: undefined, sharedWith: [] }]}
      runsLoading={false}
      now={NOW}
      onOpen={noop}
    />,
  );
  assertEquals(html.includes("Verification"), false);
  assertEquals(html.includes("Shared by"), false);
});

const runA: TriggerRun = {
  runId: "aaaaaaaa-1111",
  workflowName: "deploy-api",
  status: "succeeded",
  startedAt: "2026-10-12T19:00:00.000Z",
  duration: 1000,
  triggerSource: "webhook",
  inputs: { ref: "main" },
  stepProgress: { completed: 2, total: 2 },
};
const runB: TriggerRun = {
  ...runA,
  runId: "bbbbbbbb-2222",
  status: "failed",
  startedAt: "2026-10-12T20:00:00.000Z",
  duration: 4000,
  inputs: { ref: "release" },
  failedStep: "test",
  failureReason: "exit 1",
};

Deno.test("TriggerRunsTable: links runs and offers compare checkboxes", () => {
  const html = renderToStaticMarkup(
    <TriggerRunsTable
      runs={[runB, runA]}
      now={NOW}
      selected={["bbbbbbbb-2222"]}
      onToggleSelect={noop}
    />,
  );
  assertStringIncludes(
    html,
    'href="/dashboard/workflows/deploy-api/runs/bbbbbbbb-2222"',
  );
  assertStringIncludes(html, 'aria-label="Compare run bbbbbbbb"');
  assertStringIncludes(html, 'class="is-selected"');
  assertStringIncludes(html, 'Failed at <span class="mono">test</span>');
  assertStringIncludes(html, "2/2");
});

Deno.test("TriggerRunsTable: no compare column without a selection handler", () => {
  const html = renderToStaticMarkup(
    <TriggerRunsTable runs={[runA]} now={NOW} />,
  );
  assertEquals(html.includes('type="checkbox"'), false);
});

Deno.test("RunCompare: highlights differing rows and shows the duration change", () => {
  const rows = compareRuns({ run: runA, jobs: null }, {
    run: runB,
    jobs: null,
  });
  const html = renderToStaticMarkup(
    <RunCompare
      a={runA}
      b={runB}
      rows={rows}
      stepsLoading={false}
      onClear={noop}
    />,
  );
  assertStringIncludes(html, "Comparing two runs");
  assertStringIncludes(html, "differences highlighted");
  assertStringIncludes(html, 'class="is-different"');
  assertStringIncludes(html, "+3.0s");
  assertStringIncludes(html, "release");
  assertStringIncludes(
    html,
    'href="/dashboard/workflows/deploy-api/runs/aaaaaaaa-1111"',
  );
});

Deno.test("RunCompare: placeholder while steps load", () => {
  const rows = compareRuns({ run: runA }, { run: runA });
  const html = renderToStaticMarkup(
    <RunCompare a={runA} b={runA} rows={rows} stepsLoading onClear={noop} />,
  );
  assertStringIncludes(html, "no differences");
  assertStringIncludes(html, ">Steps<");
  assertStringIncludes(html, "skel");
});
