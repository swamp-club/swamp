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
import { vaultTypeSearchCommand } from "./vault_type_search.ts";
import { vaultCreateCommand } from "./vault_create.ts";
import { vaultSearchCommand } from "./vault_search.ts";
import { vaultGetCommand } from "./vault_get.ts";
import { vaultEditCommand } from "./vault_edit.ts";
import { vaultPutCommand } from "./vault_put.ts";
import { vaultListKeysCommand } from "./vault_list_keys.ts";

/**
 * Parent command for vault type operations.
 */
export const vaultTypeCommand = new Command()
  .name("type")
  .description("Inspect vault types")
  .action(function () {
    this.showHelp();
  })
  .command("search", vaultTypeSearchCommand);

/**
 * Parent command for vault operations.
 */
export const vaultCommand = new Command()
  .name("vault")
  .description("Manage vault configurations")
  .action(function () {
    this.showHelp();
  })
  .command("type", vaultTypeCommand)
  .command("create", vaultCreateCommand)
  .command("search", vaultSearchCommand)
  .command("get", vaultGetCommand)
  .command("edit", vaultEditCommand)
  .command("put", vaultPutCommand)
  .command("list-keys", vaultListKeysCommand);
