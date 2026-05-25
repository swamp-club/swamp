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

import type { Command } from "@cliffy/command";
import { getOutputModeFromArgs } from "./context.ts";

/**
 * Action handler for group commands (commands that only have subcommands).
 * In JSON mode, emits a JSON error object instead of dumping help text to stdout.
 * Must be used as a regular function (not arrow) so Cliffy can bind `this`.
 */
// deno-lint-ignore no-explicit-any
export function groupCommandAction(this: Command<any>): void {
  if (getOutputModeFromArgs(Deno.args) === "json") {
    const commands = this.getCommands(false).map((cmd) => cmd.getName());
    // deno-lint-ignore no-console
    console.log(JSON.stringify(
      {
        error: "No subcommand specified",
        availableCommands: commands,
      },
      null,
      2,
    ));
    Deno.exit(1);
  }
  this.showHelp();
}
