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
import { modelMethodHistoryGetCommand } from "./model_method_history_get.ts";
import { modelMethodHistorySearchCommand } from "./model_method_history_search.ts";
import { modelMethodHistoryLogsCommand } from "./model_method_history_logs.ts";

export const modelMethodHistoryCommand = new Command()
  .name("history")
  .description("Model method run history commands")
  .action(function () {
    this.showHelp();
  })
  .command("get", modelMethodHistoryGetCommand)
  .command("search", modelMethodHistorySearchCommand)
  .command("logs", modelMethodHistoryLogsCommand);
