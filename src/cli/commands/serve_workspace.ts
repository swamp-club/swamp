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
import { SERVE_WORKSPACE_ROUTES } from "./serve_routes.ts";

export async function createServeWorkspaceCommand(
  rest: readonly string[] = [],
): Promise<AnyCommand> {
  const group: AnyCommand = new Command()
    .name("workspace")
    .hidden()
    .description(
      "Create, list, inspect, suspend, resume and remove the workspaces a swamp serve host runs, through requests to its root",
    )
    .error(unknownCommandErrorHandler)
    .action(groupCommandAction);
  const loaded = await loadGroupRoutes(
    "serve workspace",
    SERVE_WORKSPACE_ROUTES,
    rest,
  );
  for (const { name, command } of loaded) group.command(name, command);
  return group;
}
