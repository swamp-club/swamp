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

import { Command } from "@cliffy/command";
import { type AnyCommand, buildCliSchema } from "../cli_schema.ts";
import { VERSION } from "./version.ts";

/**
 * Walks down the command tree following the given path segments.
 * Returns the matched command or null if a segment doesn't match.
 */
function resolveSubcommand(
  root: AnyCommand,
  path: string[],
): AnyCommand | null {
  let current: AnyCommand = root;
  for (const segment of path) {
    const child = current.getCommands(true).find((c) =>
      c.getName() === segment
    );
    if (!child) return null;
    current = child;
  }
  return current;
}

/**
 * Creates the help command. Hidden from normal CLI help — intended for AI
 * agent consumption. Always outputs JSON.
 *
 * Usage:
 *   swamp help              — full CLI schema
 *   swamp help model        — schema for the "model" subtree
 *   swamp help model method — schema for "model method" subtree
 */
export function createHelpCommand(rootCommand: AnyCommand): AnyCommand {
  return new Command()
    .hidden()
    .description("Output full CLI schema for AI agent consumption")
    .arguments("[...command:string]")
    .action(function (_options: void, ...commandPath: string[]) {
      const target = commandPath.length > 0
        ? resolveSubcommand(rootCommand, commandPath)
        : rootCommand;

      if (!target) {
        console.error(
          `Unknown command: swamp ${commandPath.join(" ")}`,
        );
        Deno.exit(1);
      }

      const isSubtree = commandPath.length > 0;
      const schema = buildCliSchema(target, VERSION, {
        stripGlobalOptions: isSubtree,
      });
      console.log(JSON.stringify(schema, null, 2));
    });
}
