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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import type { CardRunSummary } from "./WorkflowCard.tsx";
import type { WorkflowFacets } from "../lib/workflow_facets.ts";

// The router reads the page location when it loads, and the dashboard's
// browser globals aren't in Deno's test types. Each test file runs in its
// own isolate, so stubbing them here touches nothing else.
declare global {
  var history: {
    state: unknown;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void;
  };
}
if (!globalThis.location) {
  Object.defineProperty(globalThis, "location", {
    value: new URL("http://localhost/"),
    configurable: true,
  });
}
const { WorkflowCard } = await import("./WorkflowCard.tsx");

const NOW = Date.parse("2026-10-12T12:00:00Z");

const workflow = {
  id: "wf-1",
  name: "deploy-api",
  stepCount: 4,
  description: "Ships the API",
};

const scheduled: WorkflowFacets = {
  prefix: "deploy",
  scheduled: true,
  webhooks: [],
  kinds: ["schedule"],
};

const summary: CardRunSummary = {
  runs: 12_345,
  succeeded: 12_000,
  failed: 345,
  running: 0,
  durationMs: 90_000,
  lastStartedAt: "2026-10-12T11:55:00Z",
  recent: [
    { runId: "run-newest-0001", status: "failed", duration: 1200 },
    { runId: "run-older-00002", status: "succeeded", duration: 900 },
  ],
};

Deno.test("WorkflowCard: name links to the workflow and meta shows cron, steps and last run", () => {
  const html = renderToStaticMarkup(
    <WorkflowCard
      workflow={workflow}
      facets={scheduled}
      cron="*/5 * * * *"
      summary={summary}
      now={NOW}
    />,
  );
  assertStringIncludes(html, '/workflows/deploy-api" class="wf-card-link"');
  assertStringIncludes(html, "<h3");
  assertStringIncludes(html, 'class="cron-badge"');
  assertStringIncludes(html, "*/5 * * * *");
  assertStringIncludes(html, "4 steps");
  assertStringIncludes(html, "5m ago");
  assertStringIncludes(html, "Ships the API");
});

Deno.test("WorkflowCard: last run status, compact counts and pips linking to runs", () => {
  const html = renderToStaticMarkup(
    <WorkflowCard
      workflow={workflow}
      facets={scheduled}
      summary={summary}
      now={NOW}
    />,
  );
  assertStringIncludes(html, ">failed</span>"); // last run's StatusPill
  assertStringIncludes(html, "12.3K runs");
  assertStringIncludes(html, "345 failed");
  assertStringIncludes(html, "1m 30s");
  assertStringIncludes(html, "/workflows/deploy-api/runs/run-newest-0001");
  assertStringIncludes(html, "/workflows/deploy-api/runs/run-older-00002");
});

Deno.test("WorkflowCard: in-progress runs show the running badge instead of the last status", () => {
  const html = renderToStaticMarkup(
    <WorkflowCard
      workflow={workflow}
      facets={scheduled}
      summary={{ ...summary, running: 3 }}
      now={NOW}
    />,
  );
  assertStringIncludes(html, "Running ×3");
  assertEquals(html.includes(">failed</span>"), false);
});

Deno.test("WorkflowCard: webhook routes and manual triggers", () => {
  const hooked = renderToStaticMarkup(
    <WorkflowCard
      workflow={workflow}
      facets={{
        prefix: "deploy",
        scheduled: false,
        webhooks: ["/hooks/a", "/hooks/b"],
        kinds: ["webhook"],
      }}
    />,
  );
  assertStringIncludes(hooked, "/hooks/a");
  assertStringIncludes(hooked, "+1");
  assertStringIncludes(hooked, ">webhook<");

  const manual = renderToStaticMarkup(
    <WorkflowCard
      workflow={workflow}
      facets={{
        prefix: "deploy",
        scheduled: false,
        webhooks: [],
        kinds: ["manual"],
      }}
    />,
  );
  assertStringIncludes(manual, ">manual<");
  assertStringIncludes(manual, "No runs in range");
});

Deno.test("WorkflowCard: pending summary shows placeholders, unavailable shows no counts", () => {
  const pending = renderToStaticMarkup(
    <WorkflowCard workflow={workflow} facets={scheduled} summaryPending />,
  );
  assert(pending.includes('class="skel"'));
  assertEquals(pending.includes("wf-card-counts"), false);
  assertEquals(pending.includes("run-pip"), false);

  const unavailable = renderToStaticMarkup(
    <WorkflowCard workflow={workflow} facets={scheduled} summaryUnavailable />,
  );
  assertEquals(unavailable.includes("wf-card-counts"), false);
  assertEquals(unavailable.includes("wf-card-foot"), false);
  assertEquals(unavailable.includes("run-history"), false);
});
