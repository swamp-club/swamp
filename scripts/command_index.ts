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
 * run as a subprocess, not imported: it evaluates CLI modules needing
 * permissions (including --allow-ffi, no sandbox) the generator should not
 * share a process with. only the named files are imported
 */

import { dirname, fromFileUrl, join, toFileUrl } from "@std/path";
import { COMMAND_DIR, type CommandIndex } from "./affected_commands.ts";

/**
 * help comes from a factory, so there is no object to export; listed by hand so
 * the next unexported root is an error, not a silent omission
 */
export const UNEXPORTED_ROOTS: CommandIndex = {
  help: "src/cli/commands/help.ts",
};

export interface RegisteredCommand {
  name: string;
  command: unknown;
}

interface CommandNode {
  getName(): string;
  getCommands(hidden?: boolean): CommandNode[];
}

export function rootCommands(tree: CommandNode): RegisteredCommand[] {
  return tree.getCommands(true).map((command) => ({
    name: command.getName(),
    command,
  }));
}

/**
 * matches by object identity, so two names for one object each resolve; throws
 * when a command resolves to no file or several, since the list is read as
 * complete
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
 * refuses anything that is not directly a file under src/cli/commands/ before
 * importing, since the list arrives on a command line
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
