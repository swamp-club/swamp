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
import {
  loadGroupRoutes,
  selectSubcommandWithRest,
} from "../command_routes.ts";
import { SERVE_DESCRIPTION } from "./serve_options.ts";
import { resolveServeRoutes } from "./serve_routes.ts";

/**
 * rest, the argv after the group word, narrows the group to one subcommand;
 * only bare serve, its own help and its own flags import serve.ts
 */
export async function createServeCommand(
  rest: readonly string[] = [],
): Promise<AnyCommand> {
  const routes = resolveServeRoutes((name) => Deno.env.get(name));
  // serve declares no global options or error handler, so a shell loses nothing a subcommand sees
  const group: AnyCommand = selectSubcommandWithRest(routes, rest)
    ? new Command().name("serve").description(SERVE_DESCRIPTION)
    : (await import("./serve.ts")).serveCommand;
  const loaded = await loadGroupRoutes("serve", routes, rest);
  // serve.ts registers these too; re-registering re-parents a shared instance a shell took
  for (const { name, command } of loaded) {
    group.command(name, command, { override: true });
  }
  return group;
}
