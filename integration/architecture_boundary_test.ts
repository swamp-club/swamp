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
import { join } from "@std/path";
import {
  assertPinnedSet,
  collectImportEdges,
  extractImports,
  importsLayer,
  isUnder,
  productionSourceFiles,
  repoRelative,
  resolveImport,
  SRC_DIR,
} from "./arch_fitness_helpers.ts";

const DOMAIN_DIR = join(SRC_DIR, "domain");

function resolveBoundedContext(
  filePath: string,
  importPath: string,
): { source: string; target: string } | undefined {
  const sourceRel = repoRelative(filePath);
  if (!isUnder(sourceRel, "src/domain")) return undefined;
  const sourceContext = sourceRel.split("/")[2];

  const targetRel = resolveImport(filePath, importPath);
  if (targetRel === undefined) return undefined;
  if (!isUnder(targetRel, "src/domain")) return undefined;
  const targetContext = targetRel.split("/")[2];

  if (!sourceContext || !targetContext) return undefined;
  if (targetContext === sourceContext) return undefined;

  return { source: sourceContext, target: targetContext };
}

async function buildBcGraph(): Promise<Map<string, Set<string>>> {
  const graph = new Map<string, Set<string>>();

  for await (const filePath of productionSourceFiles(DOMAIN_DIR)) {
    const source = await Deno.readTextFile(filePath);
    for (const importPath of extractImports(source)) {
      const bc = resolveBoundedContext(filePath, importPath);
      if (!bc) continue;
      if (!graph.has(bc.source)) graph.set(bc.source, new Set());
      graph.get(bc.source)!.add(bc.target);
    }
  }

  return graph;
}

function findMutualDependencies(graph: Map<string, Set<string>>): string[] {
  const pairs: string[] = [];
  for (const [src, targets] of graph) {
    for (const tgt of targets) {
      if (graph.get(tgt)?.has(src) && src < tgt) {
        pairs.push(`${src} <-> ${tgt}`);
      }
    }
  }
  return pairs.sort();
}

// pinned as an exact set, not a count, so breaking one cycle while adding
// another still fails; a new pair needs a reason here, a removed one must be
// deleted from the list
const PINNED_MUTUAL_DEPENDENCIES: readonly string[] = [
  "access <-> models",
  "data <-> definitions",
  "data <-> models",
  "data <-> workflows",
  "datastore <-> extensions",
  "definitions <-> models",
  "definitions <-> reports",
  "expressions <-> models",
  "expressions <-> workflows",
  "extensions <-> models",
  "extensions <-> reports",
  "extensions <-> vaults",
  "extensions <-> workflows",
  "models <-> remote",
  "models <-> reports",
];

Deno.test(
  "findMutualDependencies: bounded-context cycles match the pinned ratchet list",
  async () => {
    const graph = await buildBcGraph();
    const mutualDeps = findMutualDependencies(graph);

    assertPinnedSet(
      mutualDeps,
      PINNED_MUTUAL_DEPENDENCIES,
      "Bounded-context mutual dependencies",
      "Circular dependencies between bounded contexts increase coupling and\n" +
        "make each context impossible to reason about in isolation. Break the\n" +
        "cycle (extract the shared concept, or invert one direction behind an\n" +
        "interface). Only add an entry to PINNED_MUTUAL_DEPENDENCIES if the\n" +
        "cycle is a deliberate, reviewed decision — with a comment saying why.",
    );
  },
);

Deno.test(
  "collectImportEdges: no domain context imports from CLI layer",
  async () => {
    const violations = await collectImportEdges(
      DOMAIN_DIR,
      (filePath, importPath) => importsLayer(filePath, importPath, "cli"),
    );

    assertEquals(
      violations.length,
      0,
      `Domain layer must not import from CLI layer:\n${violations.join("\n")}`,
    );
  },
);

Deno.test(
  "collectImportEdges: no domain context imports from presentation layer",
  async () => {
    const violations = await collectImportEdges(
      DOMAIN_DIR,
      (filePath, importPath) =>
        importsLayer(filePath, importPath, "presentation"),
    );

    assertEquals(
      violations.length,
      0,
      `Domain layer must not import from presentation layer:\n${
        violations.join("\n")
      }`,
    );
  },
);

Deno.test(
  "collectImportEdges: no infrastructure imports from CLI layer",
  async () => {
    const violations = await collectImportEdges(
      join(SRC_DIR, "infrastructure"),
      (filePath, importPath) => importsLayer(filePath, importPath, "cli"),
    );

    assertEquals(
      violations.length,
      0,
      `Infrastructure layer must not import from CLI layer:\n${
        violations.join("\n")
      }`,
    );
  },
);

Deno.test(
  "productionSourceFiles: no production code imports from test files",
  async () => {
    const violations: string[] = [];

    for await (const filePath of productionSourceFiles(SRC_DIR)) {
      const source = await Deno.readTextFile(filePath);
      for (const importPath of extractImports(source)) {
        if (importPath.includes("_test")) {
          violations.push(
            `${repoRelative(filePath)} imports test file: ${importPath}`,
          );
        }
      }
    }

    assertEquals(
      violations.length,
      0,
      `Production code must not import from test files:\n${
        violations.sort().join("\n")
      }`,
    );
  },
);
