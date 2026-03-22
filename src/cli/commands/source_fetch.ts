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
import { VERSION } from "./version.ts";
import {
  consumeStream,
  createLibSwampContext,
  createSourceFetchDeps,
  sourceFetch,
} from "../../libswamp/mod.ts";
import { createSourceFetchRenderer } from "../../presentation/renderers/source_fetch.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const sourceFetchCommand = new Command()
  .description("Download swamp source code from GitHub")
  .option(
    "--version <version:string>",
    "Version to fetch (tag or 'main')",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["source", "fetch"]);
    ctx.logger.debug("Executing source fetch command");

    const version = options.version ?? VERSION;

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const deps = createSourceFetchDeps();
    const renderer = createSourceFetchRenderer(ctx.outputMode);
    await consumeStream(
      sourceFetch(libCtx, deps, { version }),
      renderer.handlers(),
    );

    ctx.logger.debug("Source fetch command completed");
  });
