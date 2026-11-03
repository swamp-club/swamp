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
import {
  authOAuthClientRegister,
  type AuthOAuthClientRegisterData,
  type AuthOAuthClientRegisterEvent,
  createAuthOAuthClientRegisterDeps,
} from "../../libswamp/auth/oauth_client_register.ts";
import { consumeStream, withDefaults } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { renderAuthOAuthClientRegister } from "../../presentation/output/auth_oauth_client_output.ts";
import { CLUB_API_KEY_FILE_FLAG } from "../../infrastructure/persistence/api_key_source.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const REGISTER_TIMEOUT_MS = 60_000;

export const authOAuthClientRegisterCommand = new Command()
  .name("register")
  .description(
    "Register an OAuth client for swamp serve and print its id and secret once, " +
      "so recreated serve instances can reuse it with --oauth-client-id instead of " +
      "registering a new client on every start. Needs a collective API token with " +
      "the oauth:manage scope (SWAMP_API_KEY, SWAMP_API_KEY_FILE or --club-api-key-file).",
  )
  .option(
    "--name <name:string>",
    "Client name, as --oauth-client-name gives it in swamp serve",
    { required: true },
  )
  .option(
    `${CLUB_API_KEY_FILE_FLAG} <path:string>`,
    "Path to a file containing the collective API key (oauth:manage scope); " +
      "overrides SWAMP_API_KEY_FILE and SWAMP_API_KEY",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth authorization server URL, as passed to swamp serve (default: https://swamp-club.com)",
  )
  .example(
    "Register a client and keep the output as a Kubernetes Secret",
    "SWAMP_API_KEY_FILE=/run/secrets/swamp-key swamp auth oauth-client register --name prod-api-server --json",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "auth",
      "oauth-client",
      "register",
    ]);
    const ctx = createLibSwampContext({ logger: cliCtx.logger }).withTimeout(
      REGISTER_TIMEOUT_MS,
    );

    let data: AuthOAuthClientRegisterData | undefined;
    await consumeStream(
      authOAuthClientRegister(ctx, createAuthOAuthClientRegisterDeps(), {
        name: options.name as string,
        provider: options.oauthProvider as string | undefined,
      }),
      withDefaults<AuthOAuthClientRegisterEvent>({
        registering: (event) => {
          if (cliCtx.outputMode === "log") {
            writeOutput(
              `Registering OAuth client "${event.clientName}" with ${event.provider}...`,
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
      renderAuthOAuthClientRegister(data, cliCtx.outputMode);
    }
  });
