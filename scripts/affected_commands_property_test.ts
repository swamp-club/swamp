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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import {
  computeAffectedCommands,
  type ImportGraph,
} from "./affected_commands.ts";

const MODULES = Array.from({ length: 12 }, (_, i) => `src/m${i}.ts`);
const COMMANDS = ["a", "b", "c", "d"];
const commandFile = (name: string) => `src/cli/commands/${name}.ts`;

/** A random graph: main.ts imports every command, the rest is arbitrary. */
const arbGraph: fc.Arbitrary<ImportGraph> = fc.array(
  fc.subarray(MODULES),
  { minLength: MODULES.length + COMMANDS.length, maxLength: MODULES.length + COMMANDS.length },
).map((imports) => {
  const graph = new Map<string, Set<string>>();
  graph.set("main.ts", new Set([...COMMANDS.map(commandFile), MODULES[0]]));
  COMMANDS.forEach((name, i) => graph.set(commandFile(name), new Set(imports[i])));
  MODULES.forEach((m, i) => graph.set(m, new Set(imports[COMMANDS.length + i])));
  return graph;
});

const INDEX = Object.fromEntries(COMMANDS.map((n) => [n, commandFile(n)]));

/** Modules in the graph, files with no effect, and files that force all. */
const arbChanged = fc.subarray([
  ...MODULES,
  ...COMMANDS.map(commandFile),
  "README.md",
  "integration/x_test.ts",
  "deno.lock",
  "mystery.bin",
]);

function compute(graph: ImportGraph, changedFiles: string[]) {
  return computeAffectedCommands({ graph, index: INDEX, changedFiles, diffBase: "b" });
}

Deno.test("computeAffectedCommands: the result is a sorted subset of the index", () => {
  fc.assert(
    fc.property(arbGraph, arbChanged, (graph, changed) => {
      const result = compute(graph, changed);
      assert(result.commands.every((c) => COMMANDS.includes(c)));
      assertEquals(result.commands, [...result.commands].sort());
      assertEquals(result.totalCommands, COMMANDS.length);
    }),
    { numRuns: 200 },
  );
});

Deno.test("computeAffectedCommands: adding a changed file never removes a command", () => {
  fc.assert(
    fc.property(arbGraph, arbChanged, arbChanged, (graph, changed, more) => {
      const before = compute(graph, changed);
      const after = compute(graph, [...changed, ...more]);
      assert(before.commands.every((c) => after.commands.includes(c)));
      assert(after.startupPath.count >= before.startupPath.count);
    }),
    { numRuns: 200 },
  );
});

Deno.test("computeAffectedCommands: a file that forces all yields every command", () => {
  fc.assert(
    fc.property(
      arbGraph,
      arbChanged,
      fc.constantFrom("deno.json", "deno.lock", "mystery.bin"),
      (graph, changed, forcing) => {
        const result = compute(graph, [...changed, forcing]);
        assertEquals(result.commands, COMMANDS);
        assertEquals(result.scope, "all");
        assert(result.forcedAll.count >= 1);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("computeAffectedCommands: the order of changed files does not change the result", () => {
  fc.assert(
    fc.property(arbGraph, arbChanged, (graph, changed) => {
      assertEquals(
        compute(graph, [...changed].reverse()),
        compute(graph, changed),
      );
    }),
    { numRuns: 200 },
  );
});
