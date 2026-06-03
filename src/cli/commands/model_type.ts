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
import { typeDescribeCommand } from "./type_describe.ts";
import { typeSearchAction, typeSearchCommand } from "./type_search.ts";

/**
 * Parent command for model type operations.
 */
export const modelTypeCommand = new Command()
  .name("type")
  .description("Inspect model types")
  .action(groupCommandAction)
  .command("describe", typeDescribeCommand)
  .command("search", typeSearchCommand)
  .command(
    "list",
    new Command()
      .description("Alias for type search")
      .hidden()
      .arguments("[query:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR; not required for type search)",
      )
      .action(typeSearchAction),
  );
