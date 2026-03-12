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
import { UserError } from "../../domain/errors.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  type AuthWhoamiEvent,
  createAuthDeps,
  whoami,
} from "../../libswamp/auth/whoami.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authWhoamiCommand = new Command()
  .name("whoami")
  .description("Show current authenticated identity")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["auth", "whoami"]);
    cliCtx.logger.debug("Executing auth whoami command");

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createAuthDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
    });

    await consumeStream<AuthWhoamiEvent>(whoami(ctx, deps), {
      loading_credentials: () => {
        cliCtx.logger.debug("Loading stored credentials");
      },
      contacting_server: (e) => {
        cliCtx.logger.debug(`Contacting ${e.serverUrl}`);
      },
      completed: (e) => {
        if (cliCtx.outputMode === "json") {
          console.log(JSON.stringify(
            {
              authenticated: true,
              serverUrl: e.identity.serverUrl,
              id: e.identity.id,
              username: e.identity.username,
              email: e.identity.email,
              name: e.identity.name,
              ...(e.identity.collectives
                ? { collectives: e.identity.collectives }
                : {}),
            },
            null,
            2,
          ));
        } else {
          console.log(
            `${e.identity.username} (${e.identity.email}) on ${e.identity.serverUrl}`,
          );
          if (e.identity.collectives && e.identity.collectives.length > 0) {
            console.log(
              `Collectives: ${e.identity.collectives.join(", ")}`,
            );
          }
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    });

    cliCtx.logger.debug("Auth whoami command completed");
  });
