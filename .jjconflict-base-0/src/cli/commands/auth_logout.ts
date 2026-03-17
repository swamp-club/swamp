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
import { createContext, type GlobalOptions } from "../context.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authLogoutCommand = new Command()
  .name("logout")
  .description("Remove stored authentication credentials")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["auth", "logout"]);
    ctx.logger.debug("Executing auth logout command");

    const repo = new AuthRepository();
    const credentials = await repo.load();

    if (!credentials) {
      if (ctx.outputMode === "json") {
        console.log(
          JSON.stringify({ loggedOut: false, reason: "not authenticated" }),
        );
      } else {
        console.log("Not currently authenticated.");
      }
      return;
    }

    await repo.delete();

    if (ctx.outputMode === "json") {
      console.log(JSON.stringify(
        {
          loggedOut: true,
          username: credentials.username,
          serverUrl: credentials.serverUrl,
        },
        null,
        2,
      ));
    } else {
      console.log(
        `Logged out ${credentials.username} from ${credentials.serverUrl}`,
      );
    }

    ctx.logger.debug("Auth logout command completed");
  });
