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
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import { serveMemberGetCommand } from "./serve_member_get.ts";
import { serveMemberListCommand } from "./serve_member_list.ts";
import { serveMemberRemoveCommand } from "./serve_member_remove.ts";
import { serveMemberTokenCreateCommand } from "./serve_member_token_create.ts";
import { serveMemberTokenListCommand } from "./serve_member_token_list.ts";
import { serveMemberTokenRevokeCommand } from "./serve_member_token_revoke.ts";

export const serveMemberTokenCommand = new Command()
  .name("token")
  .description(
    "Manage the single-use tokens a member serve joins this hub with",
  )
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("create", serveMemberTokenCreateCommand)
  .command("list", serveMemberTokenListCommand)
  .command("revoke", serveMemberTokenRevokeCommand);

export const serveMemberCommand = new Command()
  .name("member")
  .description("Manage the serves federated with this hub")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("list", serveMemberListCommand)
  .command("get", serveMemberGetCommand)
  .command("remove", serveMemberRemoveCommand)
  .command("token", serveMemberTokenCommand);
