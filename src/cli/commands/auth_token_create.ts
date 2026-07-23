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
import { isCollectiveToken, requireAuthenticated } from "../auth_context.ts";
import { loadIdentity } from "../load_identity.ts";
import {
  authTokenCreate,
  type AuthTokenCreateData,
  type AuthTokenCreateEvent,
  consumeStream,
  createAuthTokenCreateDeps,
  createLibSwampContext,
  withDefaults,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { renderAuthTokenCreate } from "../../presentation/output/auth_token_output.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authTokenCreateCommand = new Command()
  .name("create")
  .description("Create a scoped API token for a collective")
  .option(
    "--collective <collective:string>",
    "Collective slug to create the token for",
    { required: true },
  )
  .option(
    "--scopes <scopes:string>",
    "Comma-separated scopes to grant (e.g. extensions:push,serve:*)",
    { required: true },
  )
  .option(
    "--name <name:string>",
    "Token label (default: cli-<hostname>-<timestamp>)",
  )
  .example(
    "Create a token with extension push scope",
    "swamp auth token create --collective myorg --scopes extensions:push",
  )
  .example(
    "Create a named token with multiple scopes",
    'swamp auth token create --collective myorg --scopes "extensions:push,serve:*" --name ci-deploy',
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "auth",
      "token",
      "create",
    ]);

    requireAuthenticated(
      "Collective tokens are a team feature",
      "collective:write",
    );

    const scopes = (options.scopes as string)
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    if (scopes.length === 0) {
      throw new UserError("At least one scope is required (--scopes).");
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const identity = await loadIdentity();
    const deps = createAuthTokenCreateDeps({
      serverUrlOverride: Deno.env.get("SWAMP_CLUB_URL"),
      identity,
      isCollectiveToken,
    });

    let data: AuthTokenCreateData | undefined;

    await consumeStream(
      authTokenCreate(ctx, deps, {
        collective: options.collective as string,
        scopes,
        name: options.name as string | undefined,
      }),
      withDefaults<AuthTokenCreateEvent>({
        creating: (event) => {
          if (cliCtx.outputMode === "log") {
            writeOutput(
              `Creating token "${event.name}" for collective "${event.collective}"...`,
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
      renderAuthTokenCreate(data, cliCtx.outputMode);
    }
  });
