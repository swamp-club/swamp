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
import { extensionSourceListCommand } from "./extension_source_list.ts";
import { extensionSourceAddCommand } from "./extension_source_add.ts";
import { extensionSourceRmCommand } from "./extension_source_rm.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const extensionSourceCommand = new Command()
  .name("source")
  .description("Manage local extension sources")
  .error(unknownCommandErrorHandler)
  .action(function () {
    this.showHelp();
  })
  .command("list", extensionSourceListCommand)
  .command("add", extensionSourceAddCommand)
  .command("rm", extensionSourceRmCommand);
