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
import { buildExpandedStepGraph } from "./expanded_step_graph.ts";
import type { ExpandedStep } from "./for_each_expansion_service.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import type { GraphNode } from "./topological_sort_service.ts";

// a step's iteration count; "plain" is a step without forEach
type Shape = number | "plain";

function job(
  steps: [name: string, shape: Shape, dependencies: string[]][],
): {
  nodes: GraphNode[];
  expanded: Map<string, ExpandedStep[]>;
} {
  const nodes: GraphNode[] = [];
  const expanded = new Map<string, ExpandedStep[]>();
  for (const [name, shape, dependencies] of steps) {
    nodes.push({ name, weight: 0, dependencies });
    const step = Step.create({ name, task: StepTask.model("m", "run") });
    expanded.set(
      name,
      shape === "plain"
        ? [{
          step,
          expandedName: name,
          forEachVar: { name: "", value: undefined },
        }]
        : Array.from({ length: shape }, (_, i) => ({
          step,
          expandedName: `${name}-${i}`,
          forEachVar: { name: "x", value: i },
        })),
    );
  }
  return { nodes, expanded };
}

function dependenciesOf(graph: GraphNode[]): Record<string, string[]> {
  return Object.fromEntries(graph.map((n) => [n.name, n.dependencies]));
}

Deno.test("buildExpandedStepGraph: a graph without an empty forEach maps dependencies to iterations", () => {
  const { nodes, expanded } = job([
    ["a", "plain", []],
    ["fan", 2, ["a"]],
    ["b", "plain", ["fan"]],
  ]);

  const graph = buildExpandedStepGraph(nodes, expanded);

  assertEquals(graph, [
    { name: "a", weight: 0, group: undefined, dependencies: [] },
    {
      name: "fan-0",
      weight: 0,
      group: { key: "fan", index: 0 },
      dependencies: ["a"],
    },
    {
      name: "fan-1",
      weight: 0,
      group: { key: "fan", index: 1 },
      dependencies: ["a"],
    },
    {
      name: "b",
      weight: 0,
      group: undefined,
      dependencies: ["fan-0", "fan-1"],
    },
  ]);
});

Deno.test("buildExpandedStepGraph: a dependent of an empty forEach depends on that forEach's dependencies", () => {
  const { nodes, expanded } = job([
    ["slow", "plain", []],
    ["fan", 0, ["slow"]],
    ["after", "plain", ["fan"]],
  ]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    slow: [],
    after: ["slow"],
  });
});

Deno.test("buildExpandedStepGraph: a chain of empty forEach steps passes through to the first one's dependencies", () => {
  const { nodes, expanded } = job([
    ["slow", "plain", []],
    ["fan1", 0, ["slow"]],
    ["fan2", 0, ["fan1"]],
    ["after", "plain", ["fan2"]],
  ]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    slow: [],
    after: ["slow"],
  });
});

Deno.test("buildExpandedStepGraph: an empty forEach after a non-empty one passes through to every iteration", () => {
  const { nodes, expanded } = job([
    ["full", 2, []],
    ["fan", 0, ["full"]],
    ["after", "plain", ["fan"]],
  ]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    "full-0": [],
    "full-1": [],
    after: ["full-0", "full-1"],
  });
});

Deno.test("buildExpandedStepGraph: every iteration of a forEach after an empty one depends on the empty one's dependencies", () => {
  const { nodes, expanded } = job([
    ["slow", "plain", []],
    ["fan", 0, ["slow"]],
    ["full", 2, ["fan"]],
  ]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    slow: [],
    "full-0": ["slow"],
    "full-1": ["slow"],
  });
});

Deno.test("buildExpandedStepGraph: an empty forEach with no dependencies leaves its dependent with none", () => {
  const { nodes, expanded } = job([
    ["fan", 0, []],
    ["after", "plain", ["fan"]],
  ]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    after: [],
  });
});

Deno.test("buildExpandedStepGraph: a dependency reached through two paths is listed once", () => {
  const { nodes, expanded } = job([
    ["slow", "plain", []],
    ["fan1", 0, ["slow"]],
    ["fan2", 0, ["slow"]],
    ["after", "plain", ["fan1", "fan2", "slow"]],
  ]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    slow: [],
    after: ["slow"],
  });
});

Deno.test("buildExpandedStepGraph: an unknown dependency name is kept for the sort to ignore", () => {
  const { nodes, expanded } = job([["after", "plain", ["missing"]]]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    after: ["missing"],
  });
});

Deno.test("buildExpandedStepGraph: a cycle of empty forEach steps terminates", () => {
  const { nodes, expanded } = job([
    ["slow", "plain", []],
    ["fan1", 0, ["slow", "fan2"]],
    ["fan2", 0, ["fan1"]],
    ["after", "plain", ["fan2"]],
  ]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    slow: [],
    after: ["slow"],
  });
});

Deno.test("buildExpandedStepGraph: a step resolved inside a cycle of empty forEach steps keeps every dependency for a later dependent", () => {
  const { nodes, expanded } = job([
    ["slow", "plain", []],
    ["other", "plain", []],
    ["fan1", 0, ["fan2", "slow"]],
    ["fan2", 0, ["fan1", "other"]],
    ["a1", "plain", ["fan1"]],
    ["a2", "plain", ["fan2"]],
  ]);

  assertEquals(dependenciesOf(buildExpandedStepGraph(nodes, expanded)), {
    slow: [],
    other: [],
    a1: ["other", "slow"],
    a2: ["slow", "other"],
  });
});
