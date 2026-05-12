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
import { reportSearchAction, reportSearchCommand } from "./report_search.ts";
import { reportGetCommand } from "./report_get.ts";
import { reportDescribeCommand } from "./report_describe.ts";
import {
  reportTypeSearchAction,
  reportTypeSearchCommand,
} from "./report_type_search.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const reportTypeCommand = new Command()
  .name("type")
  .description("Inspect report types")
  .action(function () {
    this.showHelp();
  })
  .command("search", reportTypeSearchCommand)
  .command(
    "list",
    new Command()
      .description("Alias for report type search")
      .hidden()
      .arguments("[query:string]")
      .action(reportTypeSearchAction),
  );

export const reportCommand = new Command()
  .name("report")
  .description("Browse and view stored report results")
  .error(unknownCommandErrorHandler)
  .action(function () {
    this.showHelp();
  })
  .command("type", reportTypeCommand)
  .command("search", reportSearchCommand)
  .command("get", reportGetCommand)
  .command("describe", reportDescribeCommand)
  .command(
    "list",
    new Command()
      .description("Alias for report search")
      .hidden()
      .arguments("[query:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .action(reportSearchAction),
  );
