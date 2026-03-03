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
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authWhoamiCommand = new Command()
  .name("whoami")
  .description("Show current authenticated identity")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["auth", "whoami"]);
    ctx.logger.debug("Executing auth whoami command");

    const repo = new AuthRepository();
    const credentials = await repo.load();

    if (!credentials) {
      throw new UserError(
        "Not authenticated. Run 'swamp auth login' to sign in.",
      );
    }

    const serverUrl = Deno.env.get("SWAMP_CLUB_URL") ?? credentials.serverUrl;
    const client = new SwampClubClient(serverUrl);
    const whoami = await client.whoami(credentials.apiKey);

    if (!whoami.authenticated) {
      throw new UserError(
        "Stored API key is no longer valid. Run 'swamp auth login' to re-authenticate.",
      );
    }

    if (ctx.outputMode === "json") {
      console.log(JSON.stringify(
        {
          authenticated: true,
          serverUrl: credentials.serverUrl,
          id: whoami.id,
          username: whoami.username,
          email: whoami.email,
          name: whoami.name,
        },
        null,
        2,
      ));
    } else {
      console.log(
        `${whoami.username} (${whoami.email}) on ${credentials.serverUrl}`,
      );
    }

    ctx.logger.debug("Auth whoami command completed");
  });
