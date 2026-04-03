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
import { extensionPushCommand } from "./extension_push.ts";
import { extensionPullCommand } from "./extension_pull.ts";
import { extensionInstallCommand } from "./extension_install.ts";
import { extensionFmtCommand } from "./extension_fmt.ts";
import { extensionRemoveCommand } from "./extension_rm.ts";
import { extensionListCommand } from "./extension_list.ts";
import { extensionSearchCommand } from "./extension_search.ts";
import { extensionUpdateCommand } from "./extension_update.ts";
import { extensionVersionCommand } from "./extension_version.ts";
import { extensionYankCommand } from "./extension_yank.ts";
import { extensionTrustCommand } from "./extension_trust.ts";
import { extensionSourceCommand } from "./extension_source.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";

export const extensionCommand = new Command()
  .name("extension")
  .description("Manage swamp extensions")
  .error(unknownCommandErrorHandler)
  .action(function () {
    this.showHelp();
  })
  .command("push", extensionPushCommand)
  .command("fmt", extensionFmtCommand)
  .command("pull", extensionPullCommand)
  .command("install", extensionInstallCommand)
  .command("rm", extensionRemoveCommand)
  .command("list", extensionListCommand)
  .command("search", extensionSearchCommand)
  .command("update", extensionUpdateCommand)
  .command("version", extensionVersionCommand)
  .command("yank", extensionYankCommand)
  .command("trust", extensionTrustCommand)
  .command("source", extensionSourceCommand);
