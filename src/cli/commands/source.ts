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
import { sourceFetchCommand } from "./source_fetch.ts";
import { sourcePathCommand } from "./source_path.ts";
import { sourceCleanCommand } from "./source_clean.ts";

export const sourceCommand = new Command()
  .name("source")
  .description("Manage swamp source code for troubleshooting")
  .action(groupCommandAction)
  .command("fetch", sourceFetchCommand)
  .command("path", sourcePathCommand)
  .command("clean", sourceCleanCommand);
