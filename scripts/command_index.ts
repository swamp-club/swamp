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
 * Maps each root CLI command to the file that defines it.
 *
 * The import graph knows files; UAT and people know command names. The name
 * is not in the file name — `first-rule` is defined in `invite_link.ts` — it
 * is whatever `registerCommands` registered the command object under. So this
 * asks the real command tree for the registered names and finds, for each
 * command object, the file under `src/cli/commands/` that exports it.
 *
 * `build_attestation.ts` runs this as a subprocess rather than importing it.
 * Evaluating the CLI's modules needs permissions the generator has no other
 * use for, and the generator decides what the attestation says: it should not
 * share a process with the code it is describing.
 *
 * Usage:
 *   deno run --unstable-bundle --allow-read --allow-env --allow-sys \
 *     --allow-ffi scripts/command_index.ts <command-file>...
 *
 * Each argument is a repo-relative command file. Only the files named are
 * imported, and the caller names the ones in the CLI's module graph, so
 * nothing is evaluated here that running the CLI does not evaluate. That
 * matters: `worker_exec_dispatch_entry.ts` sits in the same
 * directory, is a separate entry point, and reads stdin as soon as it loads.
 *
 * The index goes to stdout as JSON and nothing else does.
 *
 * The permission list is not a sandbox. `--allow-ffi` lets the CLI's modules
 * load native code, which can do anything the user can. What this runs is the
 * repository's own code at the commit being attested, the same code
 * verify-build has already run.
 */

import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { COMMAND_DIR, type CommandIndex } from "./affected_commands.ts";

/**
 * Root commands no file exports, and the file that defines each.
 *
 * `help` is built by a factory that takes the tree it documents, so there is
 * no object to export. Listed by hand so that the next root to go unexported
 * is an error to look at rather than a command silently left out.
 */
export const UNEXPORTED_ROOTS: CommandIndex = {
  help: "src/cli/commands/help.ts",
};

/** A command as the tree registers it. */
export interface RegisteredCommand {
  name: string;
  command: unknown;
}

/** The subset of a Cliffy command this reads. */
interface CommandNode {
  getName(): string;
  getCommands(hidden?: boolean): CommandNode[];
}

/** The tree's top-level commands, hidden ones included. */
export function rootCommands(tree: CommandNode): RegisteredCommand[] {
  return tree.getCommands(true).map((command) => ({
    name: command.getName(),
    command,
  }));
}

/**
 * Pairs each registered command with the file that exports its object.
 *
 * Matching is by identity, not by name: two names registered for one object
 * (`init` and `repo` are both defined in `repo_init.ts`) each resolve, and a
 * command renamed at registration still finds its file.
 *
 * Throws when a command resolves to no file or to more than one. Either would
 * otherwise leave a command out of the index, or attribute it by guesswork,
 * and the list built from this is read as complete.
 */
export function buildCommandIndex(
  roots: readonly RegisteredCommand[],
  exportsByFile: ReadonlyMap<string, readonly unknown[]>,
  unexported: CommandIndex = UNEXPORTED_ROOTS,
): CommandIndex {
  const index: Record<string, string> = {};
  const problems: string[] = [];
  for (const root of roots) {
    const files = [...exportsByFile.entries()]
      .filter(([, exported]) => exported.includes(root.command))
      .map(([file]) => file)
      .sort();
    if (files.length === 1) {
      index[root.name] = files[0];
    } else if (files.length > 1) {
      problems.push(`${root.name} is exported by ${files.join(" and ")}`);
    } else if (unexported[root.name]) {
      index[root.name] = unexported[root.name];
    } else {
      problems.push(`${root.name} is exported by no command file`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `cannot map every root command to a file: ${problems.join("; ")}`,
    );
  }
  return index;
}

/**
 * Builds the index for the real command tree.
 *
 * `files` are repo-relative paths of the command files to look in. Anything
 * that is not directly a file under `src/cli/commands/` is refused before it
 * is imported — the list arrives on a command line.
 */
export async function loadCommandIndex(
  repoRoot: string,
  files: readonly string[],
): Promise<CommandIndex> {
  for (const file of files) {
    const name = file.slice(COMMAND_DIR.length);
    if (!file.startsWith(COMMAND_DIR) || !/^[\w.-]+\.tsx?$/.test(name)) {
      throw new Error(`not a command file: ${file}`);
    }
  }

  // The tree first, then the files: a command file the tree registers is
  // already loaded by then, so importing it again evaluates nothing new.
  const { buildCommandTree } = await import("../src/cli/mod.ts");
  const roots = rootCommands(buildCommandTree());

  const exportsByFile = new Map<string, unknown[]>();
  for (const file of files) {
    const module = await import(toFileUrl(join(repoRoot, file)).href);
    exportsByFile.set(file, Object.values(module));
  }
  return buildCommandIndex(roots, exportsByFile);
}

if (import.meta.main) {
  const repoRoot = dirname(dirname(fromFileUrl(import.meta.url)));
  try {
    const index = await loadCommandIndex(repoRoot, Deno.args);
    console.log(JSON.stringify(index));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
  // Loading the CLI can leave timers and handles behind; the answer is
  // already written, so nothing here is worth waiting for.
  Deno.exit(0);
}
