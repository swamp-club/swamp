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

// paths are normalised to forward slashes relative to the repo root so pinned
// lists match on every OS; use @std/path, since `lastIndexOf("/")` or
// `split("/")` match nothing on Windows and make the tests pass vacuously

import { AssertionError } from "@std/assert";
import { walk } from "@std/fs/walk";
import { dirname, join, relative, SEPARATOR } from "@std/path";

export const ROOT = join(import.meta.dirname!, "..");

export const SRC_DIR = join(ROOT, "src");

export function toPosixPath(path: string): string {
  return SEPARATOR === "/" ? path : path.replaceAll(SEPARATOR, "/");
}

export function repoRelative(filePath: string): string {
  return toPosixPath(relative(ROOT, filePath));
}

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

export function isUnder(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

export function importsLayer(
  filePath: string,
  importPath: string,
  targetLayer: string,
): boolean {
  const rel = resolveImport(filePath, importPath);
  if (rel === undefined) return false;
  return isUnder(rel, `src/${targetLayer}`);
}

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
 * set equality, not a count: a count or `<=` comparison lets one violation be
 * traded for another
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

/**
 * A declaration at column 0: a function (generators included), or a const,
 * let or class. Serve's command handlers live inside
 * `export const serveCommand = new Command()...`, so they share that owner.
 */
export const TOP_LEVEL_DECLARATION =
  /^(?:export )?(?:async )?(?:function\s*\*?\s*|const |let |class )(\w+)/;

export function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

export function topLevelOwners(lines: readonly string[]): string[] {
  let owner = "<module>";
  return lines.map((line) => {
    const declaration = line.match(TOP_LEVEL_DECLARATION);
    if (declaration) owner = declaration[1];
    return owner;
  });
}

export interface ConstructorCall {
  line: number;
  args: string[];
}

/**
 * handles calls that span lines or pass generics; comment lines are blanked
 * first so line numbers still match the source
 */
export function constructorCalls(
  code: string,
  className: string,
): ConstructorCall[] {
  const source = code
    .split("\n")
    .map((line) => isCommentLine(line) ? "" : line)
    .join("\n");
  const marker = new RegExp(
    `\\bnew\\s+${className}\\s*(?:<[^()]*?>)?\\s*\\(`,
    "g",
  );
  const calls: ConstructorCall[] = [];
  for (const match of source.matchAll(marker)) {
    const args: string[] = [];
    let depth = 0;
    let current = "";
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const ch = source[i];
      if (depth === 0 && ch === ")") break;
      if (depth === 0 && ch === ",") {
        args.push(current.trim());
        current = "";
        continue;
      }
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      current += ch;
    }
    if (current.trim() !== "") args.push(current.trim());
    calls.push({
      line: source.slice(0, match.index).split("\n").length - 1,
      args,
    });
  }
  return calls;
}

export function constructorArgs(code: string, className: string): string[][] {
  return constructorCalls(code, className).map((call) => call.args);
}

/**
 * a key seen N times becomes `<key> (xN)`, so a second occurrence under an
 * already pinned owner still changes the list
 */
export function countedKeys(keys: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .map(([key, n]) => n > 1 ? `${key} (x${n})` : key)
    .sort();
}

/** `open` is the index just past the call's `(`; quoted commas and nested brackets do not split */
export function callArguments(source: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i++; i < source.length && source[i] !== quote; i++) {
        if (source[i] === "\\") i++;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        args.push(source.slice(start, i).trim());
        return args.filter((a) => a !== "");
      }
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}
