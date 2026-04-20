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
import {
  vaultTypeSearchAction,
  vaultTypeSearchCommand,
} from "./vault_type_search.ts";
import { vaultCreateCommand } from "./vault_create.ts";
import { vaultSearchAction, vaultSearchCommand } from "./vault_search.ts";
import { vaultGetCommand } from "./vault_get.ts";
import { vaultDescribeCommand } from "./vault_describe.ts";
import { vaultEditCommand } from "./vault_edit.ts";
import { vaultPutCommand } from "./vault_put.ts";
import { vaultListKeysCommand } from "./vault_list_keys.ts";
import { vaultMigrateCommand } from "./vault_migrate.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

/**
 * Parent command for vault type operations.
 */
export const vaultTypeCommand = new Command()
  .name("type")
  .description("Inspect vault types")
  .action(function () {
    this.showHelp();
  })
  .command("search", vaultTypeSearchCommand)
  .command(
    "list",
    new Command()
      .description("Alias for vault type search")
      .hidden()
      .arguments("[query:string]")
      .action(vaultTypeSearchAction),
  );

/**
 * Parent command for vault operations.
 */
export const vaultCommand = new Command()
  .name("vault")
  .description("Manage vault configurations")
  .error(unknownCommandErrorHandler)
  .action(function () {
    this.showHelp();
  })
  .command("type", vaultTypeCommand)
  .command("create", vaultCreateCommand)
  .command("search", vaultSearchCommand)
  .command("get", vaultGetCommand)
  .command("describe", vaultDescribeCommand)
  .command("edit", vaultEditCommand)
  .command("put", vaultPutCommand)
  .command("migrate", vaultMigrateCommand)
  .command("list-keys", vaultListKeysCommand)
  .command(
    "list",
    new Command()
      .description("Alias for vault search")
      .hidden()
      .arguments("[query:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .action(vaultSearchAction),
  );
