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
import {
  consumeStream,
  createAuthDeps,
  createLibSwampContext,
  whoami,
} from "../../libswamp/mod.ts";
import { createAuthWhoamiRenderer } from "../../presentation/renderers/auth_whoami.ts";

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

    const renderer = createAuthWhoamiRenderer(cliCtx.outputMode);
    await consumeStream(whoami(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Auth whoami command completed");
  });
