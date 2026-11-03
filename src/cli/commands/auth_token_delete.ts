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
import { promptConfirmation } from "../prompt_helpers.ts";
import { loadIdentity } from "../load_identity.ts";
import {
  authTokenDelete,
  type AuthTokenDeleteData,
  type AuthTokenDeleteEvent,
  createAuthTokenDeleteDeps,
} from "../../libswamp/auth/token_delete.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import {
  renderAuthTokenDelete,
  renderAuthTokenDeleteCancelled,
} from "../../presentation/output/auth_token_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authTokenDeleteCommand = new Command()
  .name("delete")
  .description(
    "Permanently delete a collective API token (personal login only; use `swamp auth token revoke` to disable one and keep its record)",
  )
  .option(
    "--collective <collective:string>",
    "Collective slug the token belongs to",
    { required: true },
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .option("-f, --force", "Skip confirmation prompt (alias for --yes)")
  .arguments("<token-id:string>")
  .example(
    "Delete a token by ID",
    "swamp auth token delete tok-abc123 --collective myorg",
  )
  .example(
    "Delete a token without a prompt",
    "swamp auth token delete tok-abc123 --collective myorg --yes",
  )
  .action(async function (options: AnyOptions, tokenId: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "auth",
      "token",
      "delete",
    ]);

    if (!isAuthenticated()) {
      throw new UserError(
        "Deleting collective tokens requires a personal swamp-club.com account.\n\n" +
          "Sign in with:\n\n" +
          "  swamp auth login\n",
        "auth_required",
      );
    }

    if (cliCtx.outputMode === "log" && !options.yes && !options.force) {
      const confirmed = await promptConfirmation(
        `Delete token '${tokenId}' from collective '${options.collective}'? This cannot be undone.`,
      );
      if (!confirmed) {
        renderAuthTokenDeleteCancelled(cliCtx.outputMode);
        return;
      }
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const identity = await loadIdentity();
    const deps = createAuthTokenDeleteDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
      identity,
      isCollectiveToken,
    });

    let data: AuthTokenDeleteData | undefined;

    await consumeStream(
      authTokenDelete(ctx, deps, {
        collective: options.collective as string,
        tokenId,
      }),
      withDefaults<AuthTokenDeleteEvent>({
        deleting: (event) => {
          if (cliCtx.outputMode === "log") {
            writeOutput(
              `Deleting token "${event.tokenId}" from collective "${event.collective}"...`,
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
      renderAuthTokenDelete(data, cliCtx.outputMode);
    }
  });
