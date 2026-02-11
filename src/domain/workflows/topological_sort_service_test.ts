// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { assertEquals, assertThrows } from "@std/assert";
import {
  CyclicDependencyError,
  type GraphNode,
  TopologicalSortService,
} from "./topological_sort_service.ts";

const service = new TopologicalSortService();

Deno.test("sorts single node", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: [] },
  ];

  const result = service.sort(nodes);
  assertEquals(result.levels, [["a"]]);
});

Deno.test("sorts independent nodes into one level", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: [] },
    { name: "b", weight: 0, dependencies: [] },
    { name: "c", weight: 0, dependencies: [] },
  ];

  const result = service.sort(nodes);
  assertEquals(result.levels, [["a", "b", "c"]]);
});

Deno.test("sorts linear dependency chain", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: [] },
    { name: "b", weight: 0, dependencies: ["a"] },
    { name: "c", weight: 0, dependencies: ["b"] },
  ];

  const result = service.sort(nodes);
  assertEquals(result.levels, [["a"], ["b"], ["c"]]);
});

Deno.test("sorts diamond dependency pattern", () => {
  // a -> b -> d
  // a -> c -> d
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: [] },
    { name: "b", weight: 0, dependencies: ["a"] },
    { name: "c", weight: 0, dependencies: ["a"] },
    { name: "d", weight: 0, dependencies: ["b", "c"] },
  ];

  const result = service.sort(nodes);
  assertEquals(result.levels, [["a"], ["b", "c"], ["d"]]);
});

Deno.test("sorts by weight within same level", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 10, dependencies: [] },
    { name: "b", weight: 5, dependencies: [] },
    { name: "c", weight: 1, dependencies: [] },
  ];

  const result = service.sort(nodes);
  // Sorted by weight ascending: c(1), b(5), a(10)
  assertEquals(result.levels, [["c", "b", "a"]]);
});

Deno.test("sorts by name when weights are equal", () => {
  const nodes: GraphNode[] = [
    { name: "charlie", weight: 0, dependencies: [] },
    { name: "alpha", weight: 0, dependencies: [] },
    { name: "bravo", weight: 0, dependencies: [] },
  ];

  const result = service.sort(nodes);
  assertEquals(result.levels, [["alpha", "bravo", "charlie"]]);
});

Deno.test("weight takes precedence over name", () => {
  const nodes: GraphNode[] = [
    { name: "alpha", weight: 2, dependencies: [] },
    { name: "bravo", weight: 1, dependencies: [] },
  ];

  const result = service.sort(nodes);
  // bravo has lower weight, so comes first despite alphabetical order
  assertEquals(result.levels, [["bravo", "alpha"]]);
});

Deno.test("handles complex dependency graph", () => {
  // Build:
  //   level 0: start (no deps)
  //   level 1: build1, build2 (depend on start)
  //   level 2: test1, test2 (test1 depends on build1, test2 depends on build2)
  //   level 3: deploy (depends on test1 and test2)
  const nodes: GraphNode[] = [
    { name: "start", weight: 0, dependencies: [] },
    { name: "build1", weight: 1, dependencies: ["start"] },
    { name: "build2", weight: 2, dependencies: ["start"] },
    { name: "test1", weight: 0, dependencies: ["build1"] },
    { name: "test2", weight: 0, dependencies: ["build2"] },
    { name: "deploy", weight: 0, dependencies: ["test1", "test2"] },
  ];

  const result = service.sort(nodes);
  assertEquals(result.levels.length, 4);
  assertEquals(result.levels[0], ["start"]);
  assertEquals(result.levels[1], ["build1", "build2"]);
  assertEquals(result.levels[2], ["test1", "test2"]);
  assertEquals(result.levels[3], ["deploy"]);
});

Deno.test("detects simple cycle", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: ["b"] },
    { name: "b", weight: 0, dependencies: ["a"] },
  ];

  assertThrows(
    () => service.sort(nodes),
    CyclicDependencyError,
  );
});

Deno.test("detects cycle in larger graph", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: [] },
    { name: "b", weight: 0, dependencies: ["a", "d"] }, // d creates cycle
    { name: "c", weight: 0, dependencies: ["b"] },
    { name: "d", weight: 0, dependencies: ["c"] },
  ];

  assertThrows(
    () => service.sort(nodes),
    CyclicDependencyError,
  );
});

Deno.test("detects self-referential cycle", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: ["a"] },
  ];

  assertThrows(
    () => service.sort(nodes),
    CyclicDependencyError,
  );
});

Deno.test("ignores dependencies to unknown nodes", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: ["unknown"] },
    { name: "b", weight: 0, dependencies: ["a"] },
  ];

  const result = service.sort(nodes);
  assertEquals(result.levels, [["a"], ["b"]]);
});

Deno.test("handles empty input", () => {
  const result = service.sort([]);
  assertEquals(result.levels, []);
});

Deno.test("flatten produces ordered array", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: [] },
    { name: "b", weight: 0, dependencies: ["a"] },
    { name: "c", weight: 0, dependencies: [] },
    { name: "d", weight: 0, dependencies: ["b", "c"] },
  ];

  const result = service.sort(nodes);
  const flattened = service.flatten(result);

  // Check that dependencies come before dependents
  const indexOf = (name: string) => flattened.indexOf(name);
  assertEquals(indexOf("a") < indexOf("b"), true);
  assertEquals(indexOf("b") < indexOf("d"), true);
  assertEquals(indexOf("c") < indexOf("d"), true);
});

Deno.test("deterministic output for identical input", () => {
  const nodes: GraphNode[] = [
    { name: "d", weight: 3, dependencies: [] },
    { name: "c", weight: 2, dependencies: [] },
    { name: "b", weight: 1, dependencies: [] },
    { name: "a", weight: 0, dependencies: [] },
  ];

  // Run multiple times
  const result1 = service.flatten(service.sort(nodes));
  const result2 = service.flatten(service.sort(nodes));
  const result3 = service.flatten(service.sort(nodes));

  assertEquals(result1, result2);
  assertEquals(result2, result3);
  // All in same level, sorted by weight then name
  assertEquals(result1, ["a", "b", "c", "d"]);
});

Deno.test("CyclicDependencyError contains cycle path", () => {
  const nodes: GraphNode[] = [
    { name: "a", weight: 0, dependencies: ["b"] },
    { name: "b", weight: 0, dependencies: ["c"] },
    { name: "c", weight: 0, dependencies: ["a"] },
  ];

  try {
    service.sort(nodes);
    throw new Error("Expected CyclicDependencyError");
  } catch (error) {
    if (error instanceof CyclicDependencyError) {
      // Cycle should contain all three nodes
      assertEquals(error.cycle.length >= 3, true);
    } else {
      throw error;
    }
  }
});
