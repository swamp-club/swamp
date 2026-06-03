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
import { authLoginCommand } from "./auth_login.ts";
import { authLogoutCommand } from "./auth_logout.ts";
import { authWhoamiCommand } from "./auth_whoami.ts";

export const authCommand = new Command()
  .name("auth")
  .description("Manage swamp-club authentication")
  .action(groupCommandAction)
  .command("login", authLoginCommand)
  .command("logout", authLogoutCommand)
  .command("whoami", authWhoamiCommand);
