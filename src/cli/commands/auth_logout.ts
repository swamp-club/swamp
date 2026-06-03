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
import {
  authLogout,
  consumeStream,
  createAuthLogoutDeps,
  createLibSwampContext,
} from "../../libswamp/mod.ts";
import { createAuthLogoutRenderer } from "../../presentation/renderers/auth_logout.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const authLogoutCommand = new Command()
  .name("logout")
  .description("Remove stored authentication credentials")
  .example("Remove stored credentials", "swamp auth logout")
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, ["auth", "logout"]);
    cliCtx.logger.debug("Executing auth logout command");

    if (Deno.env.get("SWAMP_API_KEY")) {
      throw new UserError(
        "Authenticated via SWAMP_API_KEY environment variable. " +
          "Unset it to log out.",
      );
    }

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createAuthLogoutDeps();
    const renderer = createAuthLogoutRenderer(cliCtx.outputMode);
    await consumeStream(authLogout(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Auth logout command completed");
  });
