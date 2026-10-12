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
import { TriggerFlow } from "./TriggerFlow.tsx";
import {
  flowJobsOf,
  type FlowSpec,
  jobLayers,
  layoutFlow,
  truncate,
} from "./trigger_flow.ts";

const spec: FlowSpec = {
  trigger: {
    kind: "schedule",
    title: "*/5 * * * *",
    lines: ["Every 5 minutes"],
  },
  inputs: ["region = eu", "size = 3"],
  workflowName: "deploy-api",
  jobs: [
    { name: "build", dependsOn: [], stepCount: 2 },
    { name: "test", dependsOn: ["build"], stepCount: 1 },
    { name: "lint", dependsOn: [], stepCount: 1 },
    { name: "ship", dependsOn: ["test", "lint"], stepCount: 3 },
  ],
};

Deno.test("jobLayers: layers jobs by their deepest dependency", () => {
  assertEquals(jobLayers(spec.jobs), [["build", "lint"], ["test"], ["ship"]]);
});

Deno.test("jobLayers: ignores unknown dependencies and breaks cycles", () => {
  assertEquals(
    jobLayers([
      { name: "a", dependsOn: ["b", "ghost"], stepCount: 1 },
      { name: "b", dependsOn: ["a"], stepCount: 1 },
      { name: "c", dependsOn: ["c"], stepCount: 1 },
    ]).flat().sort(),
    ["a", "b", "c"],
  );
});

Deno.test("layoutFlow: one column per stage, edges follow dependencies", () => {
  const layout = layoutFlow(spec);
  const xs = [...new Set(layout.nodes.map((n) => n.x))];
  // trigger, inputs, workflow + three job layers
  assertEquals(xs.length, 6);
  assertEquals(
    layout.edges.map((e) => `${e.from}->${e.to}`).sort(),
    [
      "inputs->workflow",
      "job:build->job:test",
      "job:lint->job:ship",
      "job:test->job:ship",
      "trigger->inputs",
      "workflow->job:build",
      "workflow->job:lint",
    ],
  );
  for (const n of layout.nodes) {
    assertEquals(n.x + n.w <= layout.width, true);
    assertEquals(n.y >= 0 && n.y + n.h <= layout.height, true);
  }
});

Deno.test("layoutFlow: caps input lines and marks a paused trigger", () => {
  const layout = layoutFlow({
    ...spec,
    trigger: { ...spec.trigger, paused: true },
    inputs: ["a", "b", "c", "d", "e", "f"],
  });
  const inputs = layout.nodes.find((n) => n.id === "inputs")!;
  assertEquals(inputs.lines, ["a", "b", "c", "+3 more"]);
  assertEquals(layout.nodes.find((n) => n.id === "trigger")!.muted, true);
  assertEquals(layout.edges.find((e) => e.from === "trigger")!.dashed, true);
});

Deno.test("layoutFlow: a workflow without jobs still draws its stages", () => {
  const layout = layoutFlow({ ...spec, jobs: [], inputs: null });
  assertEquals(layout.nodes.map((n) => n.id), [
    "trigger",
    "inputs",
    "workflow",
  ]);
  assertEquals(layout.nodes[1].lines, ["No inputs"]);
});

Deno.test("truncate: shortens with an ellipsis", () => {
  assertEquals(truncate("short", 10), "short");
  assertEquals(truncate("a-very-long-name", 8), "a-very-…");
});

Deno.test("TriggerFlow: renders nodes, a workflow link and an accessible label", () => {
  const html = renderToStaticMarkup(<TriggerFlow spec={spec} />);
  assertStringIncludes(html, 'role="img"');
  assertStringIncludes(
    html,
    'aria-label="*/5 * * * * starts deploy-api, which runs build, test, lint, ship"',
  );
  assertStringIncludes(html, 'href="/dashboard/workflows/deploy-api"');
  assertStringIncludes(html, "Every 5 minutes");
  assertStringIncludes(html, "region = eu");
  assertStringIncludes(html, "3 steps");
});

Deno.test("TriggerFlow: escapes names", () => {
  const html = renderToStaticMarkup(
    <TriggerFlow spec={{ ...spec, workflowName: "<script>x</script>" }} />,
  );
  assertEquals(html.includes("<script>"), false);
});

Deno.test("flowJobsOf: reads object and string dependencies and counts steps", () => {
  assertEquals(
    flowJobsOf([
      { name: "build", dependsOn: [], steps: [{}, {}] },
      {
        name: "ship",
        dependsOn: [
          { job: "build", condition: { type: "succeeded" } },
          "lint",
          3,
        ],
      },
    ]),
    [
      { name: "build", dependsOn: [], stepCount: 2 },
      { name: "ship", dependsOn: ["build", "lint"], stepCount: 0 },
    ],
  );
  assertEquals(flowJobsOf(undefined), []);
});
