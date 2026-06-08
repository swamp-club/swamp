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
import { groupCommandAction } from "../group_action.ts";
import { creekDescribeCommand } from "./creek_describe.ts";
import { creekCallCommand } from "./creek_call.ts";
import {
  creekTypeSearchAction,
  creekTypeSearchCommand,
} from "./creek_type_search.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const creekTypeCommand = new Command()
  .name("type")
  .description("Inspect creek types")
  .action(groupCommandAction)
  .command("search", creekTypeSearchCommand)
  .command(
    "list",
    new Command()
      .description("Alias for creek type search")
      .hidden()
      .arguments("[query:string]")
      .action(creekTypeSearchAction),
  );

export const creekCommand = new Command()
  .description(
    "Inspect and invoke creeks (external-system extensions used by " +
      "cross-queries like `swamp data query 'creek(...)'`)",
  )
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("type", creekTypeCommand)
  .command("describe", creekDescribeCommand)
  .command("call", creekCallCommand);
