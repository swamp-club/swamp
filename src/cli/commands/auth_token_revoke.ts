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
import { createContext, type GlobalOptions } from "../context.ts";
import { isAuthenticated, isCollectiveToken } from "../auth_context.ts";
import { loadIdentity } from "../load_identity.ts";
import {
  authTokenRevoke,
  type AuthTokenRevokeData,
  type AuthTokenRevokeEvent,
  consumeStream,
  createAuthTokenRevokeDeps,
  createLibSwampContext,
  withDefaults,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { renderAuthTokenRevoke } from "../../presentation/output/auth_token_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authTokenRevokeCommand = new Command()
  .name("revoke")
  .description("Revoke an API token for a collective")
  .option(
    "--collective <collective:string>",
    "Collective slug the token belongs to",
    { required: true },
  )
  .arguments("<token-id:string>")
  .example(
    "Revoke a token by ID",
    "swamp auth token revoke tok-abc123 --collective myorg",
  )
  .example(
    "Revoke a token with JSON output",
    "swamp auth token revoke tok-abc123 --collective myorg --json",
  )
  .action(async function (options: AnyOptions, tokenId: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "auth",
      "token",
      "revoke",
    ]);

    if (!isAuthenticated()) {
      throw new UserError(
        "Revoking collective tokens requires a personal swamp-club.com account.\n\n" +
          "Sign in with:\n\n" +
          "  swamp auth login\n",
        "auth_required",
      );
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const identity = await loadIdentity();
    const deps = createAuthTokenRevokeDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
      identity,
      isCollectiveToken,
    });

    let data: AuthTokenRevokeData | undefined;

    await consumeStream(
      authTokenRevoke(ctx, deps, {
        collective: options.collective as string,
        tokenId,
      }),
      withDefaults<AuthTokenRevokeEvent>({
        revoking: (event) => {
          if (cliCtx.outputMode === "log") {
            writeOutput(
              `Revoking token "${event.tokenId}" from collective "${event.collective}"...`,
            );
          }
        },
        completed: (event) => {
          data = event.data;
        },
        error: (event) => {
          throw new UserError(event.error.message);
        },
      }),
    );

    if (data) {
      renderAuthTokenRevoke(data, cliCtx.outputMode);
    }
  });
