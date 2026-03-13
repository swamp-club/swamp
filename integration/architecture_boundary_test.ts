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

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join, relative } from "@std/path";

const ROOT = join(import.meta.dirname!, "..");
const DOMAIN_DIR = join(ROOT, "src", "domain");

/**
 * Extract import paths from a TypeScript file's source text.
 * Matches `from "..."` and `from '...'` patterns.
 */
function extractImports(source: string): string[] {
  const importRegex = /from\s+["']([^"']+)["']/g;
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

/**
 * Given a file path and a relative import path, determine the bounded context
 * (subdirectory of src/domain/) for both source and target.
 * Returns undefined if the import is not within src/domain/.
 */
function resolveBoundedContext(
  filePath: string,
  importPath: string,
): { source: string; target: string } | undefined {
  const rel = relative(DOMAIN_DIR, filePath);
  const sourceContext = rel.split("/")[0];

  // Only handle relative imports
  if (!importPath.startsWith(".")) return undefined;

  // Resolve the import relative to the file's directory
  const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
  const resolved = join(fileDir, importPath);
  const resolvedRel = relative(DOMAIN_DIR, resolved);

  // Must still be under src/domain/
  if (resolvedRel.startsWith("..")) return undefined;

  const targetContext = resolvedRel.split("/")[0];
  if (targetContext === sourceContext) return undefined;

  return { source: sourceContext, target: targetContext };
}

/**
 * Build the cross-context dependency graph.
 */
async function buildBcGraph(): Promise<Map<string, Set<string>>> {
  const graph = new Map<string, Set<string>>();

  for await (
    const entry of walk(DOMAIN_DIR, {
      exts: [".ts"],
      includeDirs: false,
      skip: [/_test\.ts$/],
    })
  ) {
    const source = await Deno.readTextFile(entry.path);
    const imports = extractImports(source);

    for (const imp of imports) {
      const bc = resolveBoundedContext(entry.path, imp);
      if (bc) {
        if (!graph.has(bc.source)) graph.set(bc.source, new Set());
        graph.get(bc.source)!.add(bc.target);
      }
    }
  }

  return graph;
}

/**
 * Find mutual dependencies (A->B and B->A) in a directed graph.
 * Returns pairs sorted alphabetically.
 */
function findMutualDependencies(
  graph: Map<string, Set<string>>,
): string[] {
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

/**
 * Check if an import path resolves to a specific layer.
 */
function importsLayer(
  filePath: string,
  importPath: string,
  targetLayer: string,
): boolean {
  if (!importPath.startsWith(".")) return false;
  const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
  const resolved = join(fileDir, importPath);
  const rel = relative(join(ROOT, "src"), resolved);
  return rel.startsWith(targetLayer + "/");
}

// Ratchet: current number of mutual dependencies between bounded contexts.
// If someone breaks a cycle, the count decreases and the test still passes.
// If someone introduces a new mutual dependency, the test fails.
const KNOWN_MUTUAL_DEPENDENCIES = 7;

Deno.test(
  "no new mutual dependencies between bounded contexts (ratchet)",
  async () => {
    const graph = await buildBcGraph();
    const mutualDeps = findMutualDependencies(graph);
    const count = mutualDeps.length;

    assert(
      count <= KNOWN_MUTUAL_DEPENDENCIES,
      `Mutual dependency count increased from ${KNOWN_MUTUAL_DEPENDENCIES} to ${count}.\n` +
        `Current mutual dependencies:\n${mutualDeps.join("\n")}\n\n` +
        `Adding circular dependencies between bounded contexts increases coupling.\n` +
        `If you fixed a cycle, update KNOWN_MUTUAL_DEPENDENCIES to ${count}.`,
    );

    if (count < KNOWN_MUTUAL_DEPENDENCIES) {
      console.log(
        `  [ratchet] Mutual dependencies decreased from ${KNOWN_MUTUAL_DEPENDENCIES} to ${count}. ` +
          `Update KNOWN_MUTUAL_DEPENDENCIES to ${count} to lock in the improvement.`,
      );
    }
  },
);

Deno.test(
  "no domain context imports from CLI layer",
  async () => {
    const violations: string[] = [];

    for await (
      const entry of walk(DOMAIN_DIR, {
        exts: [".ts"],
        includeDirs: false,
        skip: [/_test\.ts$/],
      })
    ) {
      const source = await Deno.readTextFile(entry.path);
      const imports = extractImports(source);

      for (const imp of imports) {
        if (importsLayer(entry.path, imp, "cli")) {
          violations.push(
            `${relative(ROOT, entry.path)} imports from cli: ${imp}`,
          );
        }
      }
    }

    assertEquals(
      violations.length,
      0,
      `Domain layer must not import from CLI layer:\n${violations.join("\n")}`,
    );
  },
);

Deno.test(
  "no domain context imports from presentation layer",
  async () => {
    const violations: string[] = [];

    for await (
      const entry of walk(DOMAIN_DIR, {
        exts: [".ts"],
        includeDirs: false,
        skip: [/_test\.ts$/],
      })
    ) {
      const source = await Deno.readTextFile(entry.path);
      const imports = extractImports(source);

      for (const imp of imports) {
        if (importsLayer(entry.path, imp, "presentation")) {
          violations.push(
            `${relative(ROOT, entry.path)} imports from presentation: ${imp}`,
          );
        }
      }
    }

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
  "no infrastructure imports from CLI layer",
  async () => {
    const infraDir = join(ROOT, "src", "infrastructure");
    const violations: string[] = [];

    for await (
      const entry of walk(infraDir, {
        exts: [".ts"],
        includeDirs: false,
        skip: [/_test\.ts$/],
      })
    ) {
      const source = await Deno.readTextFile(entry.path);
      const imports = extractImports(source);

      for (const imp of imports) {
        if (importsLayer(entry.path, imp, "cli")) {
          violations.push(
            `${relative(ROOT, entry.path)} imports from cli: ${imp}`,
          );
        }
      }
    }

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
  "no production code imports from test files",
  async () => {
    const srcDir = join(ROOT, "src");
    const violations: string[] = [];

    for await (
      const entry of walk(srcDir, {
        exts: [".ts"],
        includeDirs: false,
        skip: [/_test\.ts$/],
      })
    ) {
      const source = await Deno.readTextFile(entry.path);
      const imports = extractImports(source);

      for (const imp of imports) {
        if (imp.includes("_test")) {
          violations.push(
            `${relative(ROOT, entry.path)} imports test file: ${imp}`,
          );
        }
      }
    }

    assertEquals(
      violations.length,
      0,
      `Production code must not import from test files:\n${
        violations.join("\n")
      }`,
    );
  },
);
