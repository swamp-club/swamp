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


import { fromFileUrl, relative, SEPARATOR } from "@std/path";


interface DenoInfoResolved {
  specifier?: string;
}

interface DenoInfoDependency {
  code?: DenoInfoResolved;
  type?: DenoInfoResolved;
}

interface DenoInfoModule {
  specifier?: string;
  dependencies?: DenoInfoDependency[];
}

export interface DenoInfo {
  modules?: DenoInfoModule[];
  redirects?: Record<string, string>;
}


/**
 * keyed by repo-relative forward-slash path, the spelling git diff --name-only
 * uses
 */
export type ImportGraph = ReadonlyMap<string, ReadonlySet<string>>;

function repoPath(specifier: string, repoRoot: string): string | null {
  if (!specifier.startsWith("file:")) return null;
  const path = relative(repoRoot, fromFileUrl(specifier));
  if (path.startsWith("..")) return null;
  return path.split(SEPARATOR).join("/");
}

/**
 * follows type imports too: they can break compile, and over-reporting beats
 * missing a command. remote and npm modules are dropped; their changes arrive
 * via deno.json or deno.lock
 */
export function buildImportGraph(info: DenoInfo, repoRoot: string): ImportGraph {
  const redirects = info.redirects ?? {};
  const graph = new Map<string, Set<string>>();
  for (const module of info.modules ?? []) {
    const from = module.specifier && repoPath(module.specifier, repoRoot);
    if (!from) continue;
    const imports = graph.get(from) ?? new Set<string>();
    for (const dependency of module.dependencies ?? []) {
      for (const resolved of [dependency.code, dependency.type]) {
        const specifier = resolved?.specifier;
        if (!specifier) continue;
        const to = repoPath(redirects[specifier] ?? specifier, repoRoot);
        if (to) imports.add(to);
      }
    }
    graph.set(from, imports);
  }
  return graph;
}

export function closure(
  graph: ImportGraph,
  root: string,
  stopAt: (path: string) => boolean = () => false,
): Set<string> {
  const seen = new Set<string>([root]);
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const next of graph.get(current) ?? []) {
      if (seen.has(next) || stopAt(next)) continue;
      seen.add(next);
      pending.push(next);
    }
  }
  return seen;
}


export const ENTRY_POINT = "main.ts";

export const COMMAND_DIR = "src/cli/commands/";

const ALL_COMMANDS_FILES: ReadonlySet<string> = new Set([
  "deno.json",
  "deno.lock",
  ".tool-versions",
  "Dockerfile",
  "scripts/compile.ts",
]);

/**
 * embedded in the binary, so a change ships without any import naming it;
 * checked before the no-commands dirs. .claude/skills is deliberately absent: a
 * skill-only change selects no command
 */
const BUNDLED_DIRS: readonly string[] = ["packages/dashboard/"];

/**
 * only for files outside the module graph; a file here that the CLI imports is
 * looked up in the graph instead
 */
const NO_COMMANDS_DIRS: ReadonlySet<string> = new Set([
  ".agents",
  ".claude",
  ".github",
  "agent-constraints",
  "contributing",
  "design",
  "evals",
  "extensions",
  "integration",
  "packages",
  "scripts",
  "verification",
]);

const NO_COMMANDS_FILES: ReadonlySet<string> = new Set([
  ".gitattributes",
  ".gitignore",
  "COPYING",
  "COPYING-EXCEPTION",
  "COPYRIGHT",
  "LICENSE",
]);

export interface OutsideGraphEffect {
  effect: "all" | "none";
  rule: string;
}

/**
 * a file nothing here recognises selects every command: it more likely means
 * the table is behind than that the file has no effect, and the two mistakes
 * are not equally cheap
 */
export function classifyOutsideGraph(path: string): OutsideGraphEffect {
  if (ALL_COMMANDS_FILES.has(path)) {
    return { effect: "all", rule: "build-configuration" };
  }
  if (BUNDLED_DIRS.some((dir) => path.startsWith(dir))) {
    return { effect: "all", rule: "bundled-asset" };
  }
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  if (segments.length > 1 && NO_COMMANDS_DIRS.has(segments[0])) {
    return { effect: "none", rule: `directory:${segments[0]}` };
  }
  if (
    /_(test|bench)\.tsx?$/.test(name) || /_test_helpers\.tsx?$/.test(name) ||
    segments.includes("test_helpers")
  ) {
    return { effect: "none", rule: "test" };
  }
  if (/\.(md|png)$/.test(name)) return { effect: "none", rule: "prose" };
  if (segments.length === 1 && NO_COMMANDS_FILES.has(name)) {
    return { effect: "none", rule: "housekeeping" };
  }
  return { effect: "all", rule: "unclassified" };
}


export type CommandIndex = Readonly<Record<string, string>>;

const FILE_LIST_LIMIT = 50;

interface FileSample<T> {
  count: number;
  files: T[];
}

export interface AffectedCommands {
  granularity: "root";
  scope: "all" | "some" | "none";
  commands: string[];
  totalCommands: number;
  /**
   * reported beside the list rather than widening it, so a reader can decide
   * what to make of it
   */
  startupPath: FileSample<string>;
  forcedAll: FileSample<{ file: string; rule: string }>;
  derivation: {
    method: "static-imports";
    diffBase: string;
    edges: Array<"code" | "type">;
    changedFiles: number;
  };
}

function sample<T>(files: T[]): FileSample<T> {
  return { count: files.length, files: files.slice(0, FILE_LIST_LIMIT) };
}

/**
 * deleted source under src/ or the entry point could only have reached a
 * command by import; other deleted files are classified
 */
function wasModule(path: string): boolean {
  return path === ENTRY_POINT ||
    (path.startsWith("src/") && /\.(tsx?|jsx?|mjs)$/.test(path));
}

/**
 * a deleted module is skipped since its importers changed too; other deleted
 * files are classified like changed ones. deleting a src/ file nothing imported
 * is skipped as well
 */
export function computeAffectedCommands(input: {
  graph: ImportGraph;
  index: CommandIndex;
  changedFiles: readonly string[];
  deletedFiles?: readonly string[];
  diffBase: string;
}): AffectedCommands {
  const { graph, index, changedFiles, diffBase } = input;
  const deletedFiles = input.deletedFiles ?? [];
  const names = Object.keys(index).sort();

  const closures = new Map<string, Set<string>>();
  for (const name of names) closures.set(name, closure(graph, index[name]));
  const startup = closure(
    graph,
    ENTRY_POINT,
    (path) => path.startsWith(COMMAND_DIR),
  );

  const affected = new Set<string>();
  const startupFiles: string[] = [];
  const forcedAll: Array<{ file: string; rule: string }> = [];

  for (const file of [...new Set(changedFiles)].sort()) {
    if (graph.has(file)) {
      for (const name of names) {
        if (closures.get(name)!.has(file)) affected.add(name);
      }
      if (startup.has(file)) startupFiles.push(file);
      continue;
    }
    const outside = classifyOutsideGraph(file);
    if (outside.effect === "all") forcedAll.push({ file, rule: outside.rule });
  }

  for (const file of [...new Set(deletedFiles)].sort()) {
    if (wasModule(file)) continue;
    const outside = classifyOutsideGraph(file);
    if (outside.effect === "all") forcedAll.push({ file, rule: outside.rule });
  }

  const commands = forcedAll.length > 0
    ? names
    : names.filter((name) => affected.has(name));

  return {
    granularity: "root",
    scope: commands.length === 0
      ? "none"
      : commands.length === names.length
      ? "all"
      : "some",
    commands,
    totalCommands: names.length,
    startupPath: sample(startupFiles),
    forcedAll: sample(forcedAll),
    derivation: {
      method: "static-imports",
      diffBase,
      edges: ["code", "type"],
      changedFiles: new Set([...changedFiles, ...deletedFiles]).size,
    },
  };
}
