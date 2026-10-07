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

/**
 * Works out which CLI commands a change can affect, from static imports.
 *
 * A root command (`vault`, `serve`, …) is affected when the module closure of
 * the file that defines it contains a changed file. A root's file imports its
 * subcommands, so its closure contains theirs: the list is per command family,
 * not per subcommand.
 *
 * Everything here is pure. The module graph, the command index and the changed
 * files are handed in by `build_attestation.ts`, which is what runs `deno
 * info` and git; this file only decides what they mean.
 *
 * The answer is derived from static imports and says so in the record. It
 * cannot see extension loading, registries, bundled assets or an import whose
 * path is computed at runtime, so an empty list is not proof of no effect.
 */

import { fromFileUrl, relative, SEPARATOR } from "@std/path";

// -- deno info --json shapes (only the fields this reads) --------------------

interface DenoInfoResolved {
  specifier?: string;
}

interface DenoInfoDependency {
  /** Present when the module is reached by a runtime import. */
  code?: DenoInfoResolved;
  /** Present when the module is reached by `import type`. */
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

// -- Graph ------------------------------------------------------------------

/**
 * Local modules and what each imports, keyed by path relative to the repo
 * root with forward slashes — the spelling `git diff --name-only` uses, so a
 * changed file can be looked up without translation.
 */
export type ImportGraph = ReadonlyMap<string, ReadonlySet<string>>;

/** A `file:` specifier as a repo-relative path, or null when outside the repo. */
function repoPath(specifier: string, repoRoot: string): string | null {
  if (!specifier.startsWith("file:")) return null;
  const path = relative(repoRoot, fromFileUrl(specifier));
  if (path.startsWith("..")) return null;
  return path.split(SEPARATOR).join("/");
}

/**
 * The local import graph out of `deno info --json`.
 *
 * Both edge kinds are followed. A module reached only through `import type`
 * cannot change what a command does at runtime, but it can change whether the
 * command compiles, and counting it errs towards reporting a command rather
 * than missing one. Remote and npm modules are dropped: a change to those
 * arrives as a change to `deno.json` or `deno.lock`, which has its own rule.
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

/**
 * Every module reachable from `root`, itself included.
 *
 * `stopAt` names modules the walk does not enter — used to find what startup
 * reaches on its own, without following it into the commands.
 */
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

// -- Changes outside the graph ----------------------------------------------

/** The program's entry point; what `deno info` is run against. */
export const ENTRY_POINT = "main.ts";

/** Where command files live. Startup is what the entry reaches outside it. */
export const COMMAND_DIR = "src/cli/commands/";

/**
 * Files that are in no command's closure and shape every command anyway: the
 * import map, the lockfile, the two places the runtime version is pinned, and
 * the script that compiles the binary and sets the permissions it runs with.
 */
const ALL_COMMANDS_FILES: ReadonlySet<string> = new Set([
  "deno.json",
  "deno.lock",
  ".tool-versions",
  "Dockerfile",
  "scripts/compile.ts",
]);

/**
 * Directories `scripts/compile.ts` embeds in the binary with `--include`, so
 * a change under them ships to users without any import naming it. Checked
 * before the no-commands directories, which would otherwise claim them.
 *
 * `.claude/skills` is embedded too and is deliberately absent: a skill-only
 * change was decided to select no command (swamp-club#3145), though `init`
 * and `repo` install the bundled skills.
 */
const BUNDLED_DIRS: readonly string[] = ["packages/dashboard/"];

/**
 * Top-level directories a change to which selects no command: prose, agent
 * configuration, verification and CI machinery, tests, and packages and
 * extensions published separately from the CLI.
 *
 * Only for files outside the module graph. A file under one of these that
 * the CLI imports is a module, and is looked up in the graph instead.
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

/** Root files that are licence text or repository housekeeping. */
const NO_COMMANDS_FILES: ReadonlySet<string> = new Set([
  ".gitattributes",
  ".gitignore",
  "COPYING",
  "COPYING-EXCEPTION",
  "COPYRIGHT",
  "LICENSE",
]);

/** What a changed file outside the module graph means for the command list. */
export interface OutsideGraphEffect {
  effect: "all" | "none";
  /** Which rule decided it, for the record. */
  rule: string;
}

/**
 * Classifies a changed file that is not a module in the graph.
 *
 * The last rule is the important one. A file nothing here recognises is
 * reported as affecting every command rather than none: an unknown file is
 * far likelier to be something this table has not caught up with than
 * something with no effect, and the two mistakes are not equally cheap.
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
    /_test\.tsx?$/.test(name) || /_test_helpers\.tsx?$/.test(name) ||
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

// -- The record --------------------------------------------------------------

/** Root command name to the repo-relative file that defines it. */
export type CommandIndex = Readonly<Record<string, string>>;

/** How many file names a list in the record carries before it is cut off. */
const FILE_LIST_LIMIT = 50;

/** A file list that states its full size and carries only the first few. */
interface FileSample<T> {
  count: number;
  files: T[];
}

export interface AffectedCommands {
  /** `root`: top-level command names, each standing for its subcommands. */
  granularity: "root";
  scope: "all" | "some" | "none";
  /** Affected command names, sorted. */
  commands: string[];
  totalCommands: number;
  /**
   * Changed files that every command runs at startup — reachable from the
   * entry point without going through a command file. Reported beside the
   * list rather than widening it, so a reader can decide what to make of it.
   */
  startupPath: FileSample<string>;
  /** Changed files that selected every command outright, and by which rule. */
  forcedAll: FileSample<{ file: string; rule: string }>;
  derivation: {
    /** Says what an empty list does and does not mean. */
    method: "static-imports";
    /** The commit the change was diffed against. */
    diffBase: string;
    edges: Array<"code" | "type">;
    changedFiles: number;
  };
}

function sample<T>(files: T[]): FileSample<T> {
  return { count: files.length, files: files.slice(0, FILE_LIST_LIMIT) };
}

/**
 * Whether a deleted file could only have reached a command through imports:
 * source under `src/`, or the entry point. Source elsewhere — the compile
 * script, say — is not a CLI module, and its deletion is classified.
 */
function wasModule(path: string): boolean {
  return path === ENTRY_POINT ||
    (path.startsWith("src/") && /\.(tsx?|jsx?|mjs)$/.test(path));
}

/**
 * The commands a set of changed files can affect.
 *
 * Each changed file is either a module in the graph, where it selects the
 * commands whose closure contains it, or it is not, where
 * `classifyOutsideGraph` decides between every command and none.
 *
 * `deletedFiles` are files the change removed, which are in no graph built
 * from the tree after it. A deleted module is skipped: whatever imported it
 * had to change too, and is selected in its own right. Any other deleted file
 * is classified like a changed one — removing `deno.lock` or an embedded
 * asset reaches commands without an import to show for it. The cost of
 * telling the two apart by path is that deleting a `src/` file nothing
 * imported, such as a separate entry point, is skipped as well.
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
