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
import { authLoginCommand } from "./auth_login.ts";
import { authSignupCommand } from "./auth_signup.ts";
import { authLogoutCommand } from "./auth_logout.ts";
import { authWhoamiCommand } from "./auth_whoami.ts";

export const authCommand = new Command()
  .name("auth")
  .description("Authenticate with swamp.club")
  .action(function () {
    this.showHelp();
  })
  .command("login", authLoginCommand)
  .command("signup", authSignupCommand)
  .command("logout", authLogoutCommand)
  .command("whoami", authWhoamiCommand);
