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

import { Command } from "@cliffy/command";
import type { AnyCommand } from "../cli_schema.ts";
import { loadGroupRoutes } from "../command_routes.ts";
import { groupCommandAction } from "../group_action.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import type { CommandSyntax } from "./command_syntax.ts";
import { BEHAVIOR_ROUTES } from "./model_routes.ts";

export const BEHAVIOR_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior",
  surface: "behavior",
};

/** rest, the argv after the group word, narrows the group to one subcommand */
export async function createBehaviorCommand(
  rest: readonly string[] = [],
): Promise<AnyCommand> {
  const group: AnyCommand = new Command()
    .name("behavior")
    .alias("behaviour")
    .description("Manage and run behaviors (preferred over 'model')")
    .error(unknownCommandErrorHandler)
    .action(groupCommandAction);
  const loaded = await loadGroupRoutes("behavior", BEHAVIOR_ROUTES, rest);
  for (const { name, command } of loaded) group.command(name, command);
  return group;
}
