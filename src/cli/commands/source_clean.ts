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
  consumeStream,
  createLibSwampContext,
  createSourceCleanDeps,
  sourceClean,
} from "../../libswamp/mod.ts";
import { createSourceCleanRenderer } from "../../presentation/renderers/source_clean.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const sourceCleanCommand = new Command()
  .description("Remove downloaded swamp source")
  .example("Remove downloaded source", "swamp source clean")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["source", "clean"]);
    ctx.logger.debug("Executing source clean command");

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const deps = createSourceCleanDeps();
    const renderer = createSourceCleanRenderer(ctx.outputMode);
    await consumeStream(sourceClean(libCtx, deps), renderer.handlers());

    ctx.logger.debug("Source clean command completed");
  });
