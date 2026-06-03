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
import { modelMethodHistoryGetCommand } from "./model_method_history_get.ts";
import {
  modelMethodHistorySearchAction,
  modelMethodHistorySearchCommand,
} from "./model_method_history_search.ts";
import { modelMethodHistoryLogsCommand } from "./model_method_history_logs.ts";

export const modelMethodHistoryCommand = new Command()
  .name("history")
  .description("Model method run history commands")
  .action(groupCommandAction)
  .command("get", modelMethodHistoryGetCommand)
  .command("search", modelMethodHistorySearchCommand)
  .command("logs", modelMethodHistoryLogsCommand)
  .command(
    "list",
    new Command()
      .description("Alias for model method history search")
      .hidden()
      .arguments("[query:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .action(modelMethodHistorySearchAction),
  );
