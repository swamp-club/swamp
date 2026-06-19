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
import { accessGrantCommand } from "./access_grant.ts";
import { accessGroupCommand } from "./access_group.ts";
import { accessCheckCommand } from "./access_check.ts";
import { accessReloadCommand } from "./access_reload.ts";
import { accessTokenMintCommand } from "./access_token_mint.ts";
import { accessTokenListCommand } from "./access_token_list.ts";
import { accessTokenRevokeCommand } from "./access_token_revoke.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const accessTokenCommand = new Command()
  .name("token")
  .description("Manage server tokens for user authentication")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("mint", accessTokenMintCommand)
  .command("list", accessTokenListCommand)
  .command("revoke", accessTokenRevokeCommand);

export const accessCommand = new Command()
  .name("access")
  .description("Manage authorization grants, groups, and access checks")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("token", accessTokenCommand)
  .command("grant", accessGrantCommand)
  .command("group", accessGroupCommand)
  .command("check", accessCheckCommand)
  .command("reload", accessReloadCommand);
