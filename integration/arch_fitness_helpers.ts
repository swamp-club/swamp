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

// Shared import-scanning helpers for the architectural fitness tests
// (architecture_boundary_test.ts, ddd_layer_rules_test.ts).
//
// Every path this module hands back is normalised to forward slashes and
// expressed relative to the repository root, so the pinned ratchet lists in
// the fitness tests are byte-identical on Linux, macOS and Windows. Path
// arithmetic goes through @std/path — never `lastIndexOf("/")` or
// `split("/")`, which silently match nothing on Windows and turn the
// fitness tests into vacuous passes.

import { AssertionError } from "@std/assert";
import { walk } from "@std/fs/walk";
import { dirname, join, relative, SEPARATOR } from "@std/path";

/** Repository root — the directory containing `integration/`. */
export const ROOT = join(import.meta.dirname!, "..");

/** Absolute path to `src/`. */
export const SRC_DIR = join(ROOT, "src");

/** Normalise a native path to forward slashes. */
export function toPosixPath(path: string): string {
  return SEPARATOR === "/" ? path : path.replaceAll(SEPARATOR, "/");
}

/** A repo-root-relative, forward-slash path for `filePath`. */
export function repoRelative(filePath: string): string {
  return toPosixPath(relative(ROOT, filePath));
}

/**
 * Extract import specifiers from a TypeScript source file.
 * Matches `from "..."` and `from '...'` patterns.
 */
export function extractImports(source: string): string[] {
  const importRegex = /from\s+["']([^"']+)["']/g;
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

/**
 * Resolve a relative import specifier to a repo-root-relative posix path.
 * Returns undefined for bare specifiers (jsr:/npm:/import-map entries) and
 * for anything that resolves outside the repository.
 */
export function resolveImport(
  filePath: string,
  importPath: string,
): string | undefined {
  if (!importPath.startsWith(".")) return undefined;
  const rel = repoRelative(join(dirname(filePath), importPath));
  if (rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
}

/** True when `rel` is `prefix` itself or lives beneath it. */
export function isUnder(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * True when `importPath`, resolved from `filePath`, lands inside
 * `src/<targetLayer>/`. `targetLayer` may be multi-segment, e.g.
 * "infrastructure/logging".
 */
export function importsLayer(
  filePath: string,
  importPath: string,
  targetLayer: string,
): boolean {
  const rel = resolveImport(filePath, importPath);
  if (rel === undefined) return false;
  return isUnder(rel, `src/${targetLayer}`);
}

/**
 * Walk the production TypeScript sources under `dir`: both `.ts` and `.tsx`,
 * excluding `_test.ts` and `_test.tsx`.
 */
export async function* productionSourceFiles(
  dir: string,
): AsyncGenerator<string> {
  for await (
    const entry of walk(dir, {
      exts: [".ts", ".tsx"],
      includeDirs: false,
      skip: [/_test\.tsx?$/],
    })
  ) {
    yield entry.path;
  }
}

/**
 * Collect the distinct import edges under `dir` for which `matches` holds,
 * formatted as `<source file> -> <imported module>` with both sides
 * repo-root-relative. Sorted, so it can be compared against a pinned list.
 */
export async function collectImportEdges(
  dir: string,
  matches: (filePath: string, importPath: string) => boolean,
): Promise<string[]> {
  const edges = new Set<string>();
  for await (const filePath of productionSourceFiles(dir)) {
    const source = await Deno.readTextFile(filePath);
    for (const importPath of extractImports(source)) {
      if (!matches(filePath, importPath)) continue;
      edges.add(
        `${repoRelative(filePath)} -> ${resolveImport(filePath, importPath)}`,
      );
    }
  }
  return [...edges].sort();
}

/**
 * Assert that the live scan result exactly equals the pinned ratchet list.
 *
 * Set equality — not a count — is what makes these ratchets meaningful:
 * a count-only ratchet lets one violation be traded for another, and a
 * `<=` comparison lets a fixed violation be silently replaced by a new one.
 *
 * @param actual  scan result, sorted
 * @param pinned  the checked-in allowlist
 * @param label   short description used in the failure message
 * @param policy  what a reader should do about a NEW entry
 */
export function assertPinnedSet(
  actual: readonly string[],
  pinned: readonly string[],
  label: string,
  policy: string,
): void {
  const actualSet = new Set(actual);
  const pinnedSet = new Set(pinned);
  const added = [...actual].filter((e) => !pinnedSet.has(e)).sort();
  const removed = [...pinned].filter((e) => !actualSet.has(e)).sort();

  if (added.length === 0 && removed.length === 0) return;

  const lines = [`${label}: the pinned list no longer matches the codebase.`];

  if (added.length > 0) {
    lines.push(
      "",
      `NEW — present in the codebase but not pinned (${added.length}):`,
      ...added.map((e) => `  + ${e}`),
      "",
      policy,
    );
  }

  if (removed.length > 0) {
    lines.push(
      "",
      `GONE — pinned but no longer present (${removed.length}):`,
      ...removed.map((e) => `  - ${e}`),
      "",
      "Someone fixed these. Delete them from the pinned list in this test so",
      "they cannot silently come back.",
    );
  }

  throw new AssertionError(lines.join("\n"));
}
