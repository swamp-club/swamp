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

import { assert } from "@std/assert";
import fc from "fast-check";
import { buildExpandedStepGraph } from "./expanded_step_graph.ts";
import type { ExpandedStep } from "./for_each_expansion_service.ts";
import { Step } from "./step.ts";
import { StepTask } from "./step_task.ts";
import {
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";

const MAX_STEPS = 10;

// an iteration count, or -1 for a step without forEach
interface GeneratedJob {
  shapes: number[];
  edges: boolean[];
}

const arbJob: fc.Arbitrary<GeneratedJob> = fc
  .integer({ min: 1, max: MAX_STEPS })
  .chain((n) =>
    fc.record({
      shapes: fc.array(fc.integer({ min: -1, max: 3 }), {
        minLength: n,
        maxLength: n,
      }),
      edges: fc.array(fc.boolean(), {
        minLength: (n * (n - 1)) / 2,
        maxLength: (n * (n - 1)) / 2,
      }),
    })
  );

interface BuiltJob {
  nodes: GraphNode[];
  expanded: Map<string, ExpandedStep[]>;
  names: string[];
}

function build({ shapes, edges }: GeneratedJob): BuiltJob {
  const nodes: GraphNode[] = [];
  const expanded = new Map<string, ExpandedStep[]>();
  const names = shapes.map((_, i) => `s${i}`);
  let edge = 0;
  for (const [i, shape] of shapes.entries()) {
    const dependencies: string[] = [];
    for (let j = 0; j < i; j++) {
      if (edges[edge++]) dependencies.push(names[j]);
    }
    nodes.push({ name: names[i], weight: 0, dependencies });
    const step = Step.create({
      name: names[i],
      task: StepTask.model("m", "run"),
    });
    expanded.set(
      names[i],
      shape < 0
        ? [{
          step,
          expandedName: names[i],
          forEachVar: { name: "", value: undefined },
        }]
        : Array.from({ length: shape }, (_, k) => ({
          step,
          expandedName: `${names[i]}-${k}`,
          forEachVar: { name: "x", value: k },
        })),
    );
  }
  return { nodes, expanded, names };
}

// every step the authored edges reach from name, through any step
function upstreamOf(nodes: GraphNode[], name: string): Set<string> {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const seen = new Set<string>();
  const stack = [...byName.get(name)!.dependencies];
  while (stack.length > 0) {
    const dep = stack.pop()!;
    if (seen.has(dep)) continue;
    seen.add(dep);
    stack.push(...byName.get(dep)!.dependencies);
  }
  return seen;
}

function levelOf(levels: string[][], name: string): number {
  return levels.findIndex((level) => level.includes(name));
}

Deno.test("buildExpandedStepGraph: authored ordering survives empty forEach steps", () => {
  fc.assert(
    fc.property(arbJob, (generated) => {
      const { nodes, expanded, names } = build(generated);
      const { levels } = new TopologicalSortService().sort(
        buildExpandedStepGraph(nodes, expanded),
      );
      const iterations = (name: string) =>
        expanded.get(name)!.map((e) => e.expandedName);
      for (const later of names) {
        for (const earlier of upstreamOf(nodes, later)) {
          for (const b of iterations(later)) {
            for (const a of iterations(earlier)) {
              assert(
                levelOf(levels, a) < levelOf(levels, b),
                `${a} must run before ${b}`,
              );
            }
          }
        }
      }
    }),
    { numRuns: 300 },
  );
});

Deno.test("buildExpandedStepGraph: every dependency names a node of the graph", () => {
  fc.assert(
    fc.property(arbJob, (generated) => {
      const { nodes, expanded } = build(generated);
      const graph = buildExpandedStepGraph(nodes, expanded);
      const known = new Set(graph.map((n) => n.name));
      for (const node of graph) {
        for (const dep of node.dependencies) {
          assert(known.has(dep), `${node.name} depends on missing ${dep}`);
        }
      }
    }),
    { numRuns: 300 },
  );
});
