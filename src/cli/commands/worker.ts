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
import { workerTokenCreateCommand } from "./worker_token_create.ts";
import { workerTokenListCommand } from "./worker_token_list.ts";
import { workerTokenRevokeCommand } from "./worker_token_revoke.ts";
import { workerListCommand } from "./worker_list.ts";
import { workerConnectCommand } from "./worker_connect.ts";
import { workerQueueCommand } from "./worker_queue.ts";

export const workerTokenCommand = new Command()
  .name("token")
  .description("Manage worker enrollment tokens")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("create", workerTokenCreateCommand)
  .command("list", workerTokenListCommand)
  .command("revoke", workerTokenRevokeCommand);

export const workerCommand = new Command()
  .name("worker")
  .description("Manage remote execution workers and enrollment tokens")
  .error(unknownCommandErrorHandler)
  .action(groupCommandAction)
  .command("token", workerTokenCommand)
  .command("list", workerListCommand)
  .command("queue", workerQueueCommand)
  .command("connect", workerConnectCommand);
