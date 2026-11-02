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
import { fitView, RunGraph, viewportHeight } from "./RunGraph.tsx";
import { buildRunGraph, type RunLike } from "./run_graph_model.ts";
import { layoutGraph } from "./run_graph_layout.ts";
import { RunStatusIcon } from "./RunStatusIcon.tsx";

const run: RunLike = {
  status: "running",
  jobs: [
    {
      name: "build",
      status: "succeeded",
      duration: 4200,
      steps: [{ name: "compile", status: "succeeded" }],
    },
    {
      name: "test",
      status: "failed",
      duration: 61_000,
      steps: [
        { name: "unit", status: "failed", error: "2 tests failed" },
        { name: "lint", status: "succeeded" },
      ],
    },
    {
      name: "deploy",
      status: "running",
      startedAt: "2026-10-12T10:00:00.000Z",
      steps: [
        { name: "push", status: "succeeded" },
        { name: "rollout", status: "running" },
        {
          name: "child",
          status: "pending",
          nestedRun: { workflowName: "deploy-app", runId: "child-run-1" },
        },
      ],
    },
    {
      name: "publish",
      status: "skipped",
      steps: [{ name: "upload", status: "skipped" }],
    },
  ],
};

const definition = {
  jobs: [
    { name: "build" },
    { name: "test", dependsOn: [{ job: "build" }] },
    {
      name: "deploy",
      dependsOn: [{ job: "build", condition: { type: "succeeded" as const } }],
    },
    {
      name: "publish",
      dependsOn: [{ job: "test", condition: { type: "succeeded" as const } }],
    },
  ],
};

const now = Date.parse("2026-10-12T10:00:07.000Z");

function render(selected: string | null = null) {
  return renderToStaticMarkup(
    <RunGraph
      graph={buildRunGraph(run, definition)}
      selected={selected}
      onSelect={() => {}}
      now={now}
      onNavigate={() => {}}
    />,
  );
}

Deno.test("RunGraph: renders one card per job with its status", () => {
  const html = render();
  assertEquals(html.match(/class="rg-node /g)?.length, 4);
  assertStringIncludes(html, "rg-node rg-succeeded");
  assertStringIncludes(html, "rg-node rg-failed");
  assertStringIncludes(html, "rg-node rg-running");
  assertStringIncludes(html, "rg-node rg-skipped");
});

Deno.test("RunGraph: a failed job names the failing step", () => {
  const html = render();
  assertStringIncludes(html, "unit failed");
  assertStringIncludes(html, "unit: 2 tests failed");
});

Deno.test("RunGraph: a running job ticks its duration and shows progress", () => {
  const html = render();
  // 7s since it started, from the live clock.
  assertStringIncludes(html, "7.0s");
  assertStringIncludes(html, "1/3 steps");
  assertStringIncludes(html, 'class="rg-progress"');
});

Deno.test("RunGraph: edges draw dashed when their condition was not met", () => {
  const html = render();
  assertEquals(html.match(/class="rg-edge /g)?.length, 3);
  assertStringIncludes(html, "rg-edge rg-edge-unmet");
  assertStringIncludes(
    html,
    "test → publish: runs when test succeeded (not met)",
  );
  // The edge into the running job animates.
  assertStringIncludes(html, "rg-edge rg-edge-met is-active");
  assertStringIncludes(html, 'class="rg-edge-flow"');
});

Deno.test("RunGraph: a nested workflow step links to its child run", () => {
  const html = render();
  assertStringIncludes(
    html,
    'href="/dashboard/workflows/deploy-app/runs/child-run-1"',
  );
});

Deno.test("RunGraph: one job is the tab stop, and the selected job is pressed", () => {
  const html = render("deploy");
  assertEquals(html.match(/tabindex="0"/g)?.length, 1);
  const pressed = html.match(/<button[^>]*aria-pressed="true"[^>]*>/)?.[0];
  assertStringIncludes(pressed ?? "", 'tabindex="0"');
  assertStringIncludes(pressed ?? "", 'aria-label="deploy,');
  assertEquals(html.match(/aria-pressed="true"/g)?.length, 1);
});

Deno.test("RunGraph: cards are labelled for assistive tech", () => {
  const html = render();
  assertStringIncludes(html, 'aria-label="deploy, Running, 1/3 steps, 7.0s"');
  assertStringIncludes(html, 'aria-label="publish, Skipped"');
  assertStringIncludes(html, 'aria-label="Zoom in"');
});

Deno.test("RunGraph: without dependencies it says so", () => {
  const html = renderToStaticMarkup(
    <RunGraph
      graph={buildRunGraph(run, null)}
      selected={null}
      onSelect={() => {}}
      now={now}
      onNavigate={() => {}}
    />,
  );
  assertStringIncludes(html, "Dependencies unavailable");
});

Deno.test("RunGraph: a run with no jobs shows an empty state", () => {
  const html = renderToStaticMarkup(
    <RunGraph
      graph={{ jobs: [], edges: [], hasDependencies: true }}
      selected={null}
      onSelect={() => {}}
      now={now}
      onNavigate={() => {}}
    />,
  );
  assertStringIncludes(html, "This run has no jobs");
});

Deno.test("fitView: never enlarges past 100% and centres the graph", () => {
  const layout = layoutGraph([{ id: "a" }, { id: "b" }], [{
    from: "a",
    to: "b",
  }]);
  const view = fitView(layout, 2000, 400);
  assertEquals(view.k, 1);
  assertEquals(view.x, (2000 - layout.width) / 2);
});

Deno.test("fitView: a graph too wide to read when fitted opens readable, from the left", () => {
  const ids = Array.from({ length: 12 }, (_, i) => ({ id: `j${i}` }));
  const edges = ids.slice(1).map((n, i) => ({ from: ids[i].id, to: n.id }));
  const layout = layoutGraph(ids, edges);
  const view = fitView(layout, 800, viewportHeight(layout, 800));
  assertEquals(view.k, 0.8);
  assertEquals(view.x, 28);
  // "Fit" shows all of it.
  const all = fitView(layout, 800, 400, "all");
  assert(all.k < 0.3 && all.k >= 0.25);
  // A graph that fits legibly is fitted and centred.
  const roomy = fitView(layout, 3000, 400);
  assert(roomy.k >= 0.6 && roomy.k < 1);
  assert(Math.abs(roomy.x - (3000 - layout.width * roomy.k) / 2) < 1);
});

Deno.test("RunStatusIcon: names the status unless told not to", () => {
  assertStringIncludes(
    renderToStaticMarkup(<RunStatusIcon status="failed" />),
    'aria-label="Failed"',
  );
  assertStringIncludes(
    renderToStaticMarkup(<RunStatusIcon status="failed" label="" />),
    'aria-hidden="true"',
  );
});
