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
import {
  authLogin,
  consumeStream,
  createAuthLoginDeps,
  createLibSwampContext,
} from "../../libswamp/mod.ts";
import type { AuthLoginInput } from "../../libswamp/mod.ts";
import { createAuthLoginRenderer } from "../../presentation/renderers/auth_login.ts";
import { createContext, type GlobalOptions, isStdinTty } from "../context.ts";

const DEFAULT_SERVER_URL = "https://swamp.club";

/** Resolve server URL: env var > default */
function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SERVER_URL;
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authLoginCommand = new Command()
  .name("login")
  .description("Authenticate with a swamp-club server")
  .option(
    "--server <url:string>",
    "Server URL (env: SWAMP_CLUB_URL)",
  )
  .option("--username <username:string>", "Username or email")
  .option("--password <password:string>", "Password (omit to prompt)")
  .option("--no-browser", "Disable browser login, use username/password")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["auth", "login"]);
    cliCtx.logger.debug("Executing auth login command");

    const serverUrl: string = options.server ?? resolveServerUrl();

    // Decide which flow to use:
    // - stdin flow if --username/--password provided, --no-browser, or non-TTY
    // - browser flow otherwise
    const useStdinFlow = options.username || options.password ||
      options.browser === false || !isStdinTty();

    const showSpinner = cliCtx.outputMode !== "json" && !useStdinFlow;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createAuthLoginDeps();
    const input: AuthLoginInput = {
      serverUrl,
      useBrowserFlow: !useStdinFlow,
      username: options.username,
      password: options.password,
    };
    const renderer = createAuthLoginRenderer(cliCtx.outputMode, showSpinner);
    await consumeStream(authLogin(ctx, deps, input), renderer.handlers());

    cliCtx.logger.debug("Auth login command completed");
  });
