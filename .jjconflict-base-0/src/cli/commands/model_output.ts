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
import { modelOutputGetCommand } from "./model_output_get.ts";
import { modelOutputSearchCommand } from "./model_output_search.ts";
import { modelOutputLogsCommand } from "./model_output_logs.ts";
import { modelOutputDataCommand } from "./model_output_data.ts";

export const modelOutputCommand = new Command()
  .name("output")
  .description("Manage model outputs")
  .action(function () {
    this.showHelp();
  })
  .command("get", modelOutputGetCommand)
  .command("search", modelOutputSearchCommand)
  .command("logs", modelOutputLogsCommand)
  .command("data", modelOutputDataCommand);
