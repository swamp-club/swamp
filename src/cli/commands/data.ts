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
import { dataGetCommand } from "./data_get.ts";
import { dataListCommand } from "./data_list.ts";
import { dataSearchCommand } from "./data_search.ts";
import { dataVersionsCommand } from "./data_versions.ts";
import { dataGcCommand } from "./data_gc.ts";
import { dataRenameCommand } from "./data_rename.ts";
import { dataQueryCommand } from "./data_query.ts";

export const dataCommand = new Command()
  .name("data")
  .description("Manage model data")
  .action(function () {
    this.showHelp();
  })
  .command("get", dataGetCommand)
  .command("list", dataListCommand)
  .command("search", dataSearchCommand)
  .command("query", dataQueryCommand)
  .command("versions", dataVersionsCommand)
  .command("gc", dataGcCommand)
  .command("rename", dataRenameCommand);
