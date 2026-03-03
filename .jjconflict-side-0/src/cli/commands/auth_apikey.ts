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
import { authApikeyListCommand } from "./auth_apikey_list.ts";
import { authApikeyCreateCommand } from "./auth_apikey_create.ts";
import { authApikeyRevokeCommand } from "./auth_apikey_revoke.ts";
import { authApikeyDeleteCommand } from "./auth_apikey_delete.ts";

export const authApikeyCommand = new Command()
  .name("apikey")
  .description("Manage API keys")
  .action(function () {
    this.showHelp();
  })
  .command("list", authApikeyListCommand)
  .command("create", authApikeyCreateCommand)
  .command("revoke", authApikeyRevokeCommand)
  .command("delete", authApikeyDeleteCommand);
