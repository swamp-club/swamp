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
import { workflowHistoryGetCommand } from "./workflow_history_get.ts";
import {
  workflowHistorySearchAction,
  workflowHistorySearchCommand,
} from "./workflow_history_search.ts";
import { workflowHistoryLogsCommand } from "./workflow_history_logs.ts";

export const workflowHistoryCommand = new Command()
  .name("history")
  .description("Workflow run history commands")
  .action(function () {
    this.showHelp();
  })
  .command("get", workflowHistoryGetCommand)
  .command("search", workflowHistorySearchCommand)
  .command("logs", workflowHistoryLogsCommand)
  .command(
    "list",
    new Command()
      .description("Alias for workflow history search")
      .hidden()
      .arguments("[query:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .action(workflowHistorySearchAction),
  );
