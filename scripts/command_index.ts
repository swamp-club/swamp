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
 * the files on the command line are the command files of the deno info graph;
 * every root's file must be among them, so a route whose import() deno info did
 * not record fails here instead of silently dropping out of affectedCommands
 */

import { COMMAND_DIR, type CommandIndex } from "./affected_commands.ts";
import { ROOT_ROUTES } from "../src/cli/root_routes.ts";

/** registered over every tree rather than routed, so the table has no row for it */
export const UNROUTED_ROOTS: CommandIndex = {
  help: "src/cli/commands/help.ts",
};

export interface RootFile {
  name: string;
  module: string;
}

/** aliases are left out: the index is keyed by registered name */
export function buildCommandIndex(
  roots: readonly RootFile[],
  graphFiles: readonly string[],
  unrouted: CommandIndex = UNROUTED_ROOTS,
): CommandIndex {
  const index: Record<string, string> = {};
  const problems: string[] = [];
  const known = new Set(graphFiles);
  const all = [
    ...roots,
    ...Object.entries(unrouted).map(([name, module]) => ({ name, module })),
  ];
  for (const { name, module } of all) {
    if (Object.hasOwn(index, name)) {
      problems.push(`${name} is listed twice`);
    } else if (!known.has(module)) {
      problems.push(`${name} names ${module}, which is not in the module graph`);
    } else {
      index[name] = module;
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `cannot map every root command to a file: ${problems.join("; ")}`,
    );
  }
  return index;
}

/** the list arrives on a command line, so anything not directly under src/cli/commands/ is refused */
export function loadCommandIndex(files: readonly string[]): CommandIndex {
  for (const file of files) {
    const name = file.slice(COMMAND_DIR.length);
    if (!file.startsWith(COMMAND_DIR) || !/^[\w.-]+\.tsx?$/.test(name)) {
      throw new Error(`not a command file: ${file}`);
    }
  }
  return buildCommandIndex(ROOT_ROUTES, files);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(loadCommandIndex(Deno.args)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
