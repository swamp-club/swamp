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
import { recordDefiningModule } from "./command_syntax.ts";
import { MODEL_METHOD_ROUTES } from "./model_routes.ts";

/** rest, the argv after the method word, narrows the group to one subcommand */
export async function createModelMethodCommand(
  rest: readonly string[] = [],
): Promise<AnyCommand> {
  const group: AnyCommand = new Command()
    .name("method")
    .description("Execute model methods")
    .error(unknownCommandErrorHandler)
    .action(groupCommandAction);
  const loaded = await loadGroupRoutes(
    "model method",
    MODEL_METHOD_ROUTES,
    rest,
  );
  for (const { name, command } of loaded) group.command(name, command);
  return recordDefiningModule(group, import.meta.url);
}
