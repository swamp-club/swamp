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
import { extensionTrustListCommand } from "./extension_trust_list.ts";
import { extensionTrustAddCommand } from "./extension_trust_add.ts";
import { extensionTrustRmCommand } from "./extension_trust_rm.ts";
import { extensionTrustAutoTrustCommand } from "./extension_trust_auto_trust.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const extensionTrustCommand = new Command()
  .name("trust")
  .description("Manage trusted collectives for extension auto-resolution")
  .error(unknownCommandErrorHandler)
  .action(function () {
    this.showHelp();
  })
  .command("list", extensionTrustListCommand)
  .command("add", extensionTrustAddCommand)
  .command("rm", extensionTrustRmCommand)
  .command("auto-trust", extensionTrustAutoTrustCommand);
