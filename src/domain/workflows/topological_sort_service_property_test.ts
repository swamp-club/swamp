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

import { assert, assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import {
  CyclicDependencyError,
  DuplicateNodeNameError,
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";

/**
 * Names are drawn from a pool whose alphabetical order deliberately differs
 * from insertion order, so the name tie-break inside a level is exercised
 * rather than accidentally satisfied.
 */
const NAME_POOL = [
  "zulu",
  "alpha",
  "mike",
  "bravo",
  "yankee",
  "charlie",
  "delta",
  "november",
  "echo",
  "papa",
];

const MAX_NODES = 8;

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

interface GeneratedGraph {
  /** Nodes in a random input order. */
  nodes: GraphNode[];
  /** A permutation of the node indices, used to re-order the input. */
  order: number[];
}

/**
 * Builds a random DAG: node `i` may only depend on nodes with a lower index,
 * which makes the graph acyclic by construction.
 */
function buildNodes(
  names: string[],
  weights: number[],
  edges: boolean[],
): GraphNode[] {
  const nodes: GraphNode[] = [];
  let edgeIndex = 0;
  for (let i = 0; i < names.length; i++) {
    const dependencies: string[] = [];
    for (let j = 0; j < i; j++) {
      if (edges[edgeIndex++]) {
        dependencies.push(names[j]);
      }
    }
    nodes.push({ name: names[i], weight: weights[i], dependencies });
  }
  return nodes;
}

const arbGraph: fc.Arbitrary<GeneratedGraph> = fc
  .integer({ min: 1, max: MAX_NODES })
  .chain((n) =>
    fc
      .record({
        weights: fc.array(fc.integer({ min: -3, max: 3 }), {
          minLength: n,
          maxLength: n,
        }),
        edges: fc.array(fc.boolean(), {
          minLength: (n * (n - 1)) / 2,
          maxLength: (n * (n - 1)) / 2,
        }),
        names: fc.shuffledSubarray(NAME_POOL, {
          minLength: n,
          maxLength: n,
        }),
        order: fc.shuffledSubarray(range(n), { minLength: n, maxLength: n }),
      })
      .map(({ weights, edges, names, order }) => ({
        nodes: buildNodes(names, weights, edges),
        order,
      }))
  );

function levelOf(levels: string[][], name: string): number {
  return levels.findIndex((level) => level.includes(name));
}

Deno.test("TopologicalSortService.sort: dependencies always land in an earlier level", () => {
  fc.assert(
    fc.property(arbGraph, ({ nodes }) => {
      const { levels } = new TopologicalSortService().sort(nodes);
      const known = new Set(nodes.map((n) => n.name));
      for (const node of nodes) {
        const own = levelOf(levels, node.name);
        assert(own >= 0, `${node.name} missing from result`);
        for (const dep of node.dependencies) {
          if (!known.has(dep)) continue;
          assert(
            levelOf(levels, dep) < own,
            `${dep} must precede ${node.name}`,
          );
        }
      }
    }),
    { numRuns: 200 },
  );
});

Deno.test("TopologicalSortService.sort: output is a permutation of the input", () => {
  fc.assert(
    fc.property(arbGraph, ({ nodes }) => {
      const service = new TopologicalSortService();
      const result = service.sort(nodes);
      const flattened = service.flatten(result);
      assertEquals(flattened.length, nodes.length);
      assertEquals(new Set(flattened).size, nodes.length);
      assertEquals(
        [...flattened].sort(),
        nodes.map((n) => n.name).sort(),
      );
      assertEquals(flattened, result.levels.flat());
    }),
    { numRuns: 200 },
  );
});

Deno.test("TopologicalSortService.sort: result is invariant under input order", () => {
  fc.assert(
    fc.property(arbGraph, ({ nodes, order }) => {
      const service = new TopologicalSortService();
      const reordered = order.map((index) => nodes[index]);
      assertEquals(service.sort(reordered).levels, service.sort(nodes).levels);
    }),
    { numRuns: 200 },
  );
});

Deno.test("TopologicalSortService.sort: levels are ordered by weight then name", () => {
  fc.assert(
    fc.property(arbGraph, ({ nodes }) => {
      const byName = new Map(nodes.map((n) => [n.name, n]));
      const { levels } = new TopologicalSortService().sort(nodes);
      for (const level of levels) {
        for (let i = 1; i < level.length; i++) {
          const prev = byName.get(level[i - 1])!;
          const curr = byName.get(level[i])!;
          if (prev.weight === curr.weight) {
            assert(
              prev.name.localeCompare(curr.name) <= 0,
              `${prev.name} should sort before ${curr.name}`,
            );
          } else {
            assert(
              prev.weight < curr.weight,
              `${prev.name} (${prev.weight}) should sort before ${curr.name} (${curr.weight})`,
            );
          }
        }
      }
    }),
    { numRuns: 200 },
  );
});

Deno.test("TopologicalSortService.sort: dependency-free graphs collapse to one level", () => {
  fc.assert(
    fc.property(arbGraph, ({ nodes }) => {
      const independent = nodes.map((n) => ({ ...n, dependencies: [] }));
      const { levels } = new TopologicalSortService().sort(independent);
      assertEquals(levels.length, 1);
      assertEquals(levels[0].length, nodes.length);
    }),
    { numRuns: 100 },
  );
});

Deno.test("TopologicalSortService.sort: unknown dependencies are ignored", () => {
  fc.assert(
    fc.property(arbGraph, ({ nodes }) => {
      const service = new TopologicalSortService();
      const withGhosts = nodes.map((n) => ({
        ...n,
        dependencies: [...n.dependencies, "not-a-node"],
      }));
      // The validation service reports dangling references; the sort simply
      // skips them, so the levels must be unchanged.
      assertEquals(service.sort(withGhosts).levels, service.sort(nodes).levels);
    }),
    { numRuns: 200 },
  );
});

Deno.test("TopologicalSortService.sort: a self-dependency is a cycle", () => {
  fc.assert(
    fc.property(arbGraph, fc.nat(), ({ nodes }, pick) => {
      const target = pick % nodes.length;
      const cyclic = nodes.map((n, i) =>
        i === target
          ? { ...n, dependencies: [...n.dependencies, n.name] }
          : { ...n }
      );
      const error = assertThrows(
        () => new TopologicalSortService().sort(cyclic),
        CyclicDependencyError,
      ) as CyclicDependencyError;
      assert(error.cycle.includes(nodes[target].name));
    }),
    { numRuns: 200 },
  );
});

Deno.test("TopologicalSortService.sort: a mutual dependency is a cycle", () => {
  fc.assert(
    fc.property(
      arbGraph.filter(({ nodes }) => nodes.length >= 2),
      fc.nat(),
      fc.nat(),
      ({ nodes }, a, b) => {
        const first = a % nodes.length;
        let second = b % nodes.length;
        if (second === first) second = (first + 1) % nodes.length;
        const cyclic = nodes.map((n, i) => {
          if (i === first) {
            return {
              ...n,
              dependencies: [...n.dependencies, nodes[second].name],
            };
          }
          if (i === second) {
            return {
              ...n,
              dependencies: [...n.dependencies, nodes[first].name],
            };
          }
          return { ...n };
        });
        assertThrows(
          () => new TopologicalSortService().sort(cyclic),
          CyclicDependencyError,
        );
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("TopologicalSortService.sort: duplicate node names are rejected", () => {
  fc.assert(
    fc.property(arbGraph, fc.nat(), ({ nodes }, pick) => {
      const duplicated = nodes[pick % nodes.length];
      const error = assertThrows(
        () => new TopologicalSortService().sort([...nodes, { ...duplicated }]),
        DuplicateNodeNameError,
      ) as DuplicateNodeNameError;
      assertEquals(error.duplicates, [duplicated.name]);
    }),
    { numRuns: 200 },
  );
});

Deno.test("TopologicalSortService.sort: an empty graph yields no levels", () => {
  assertEquals(new TopologicalSortService().sort([]).levels, []);
});
