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
  createSourcePathDeps,
  sourcePath,
} from "../../libswamp/mod.ts";
import { createSourcePathRenderer } from "../../presentation/renderers/source_path.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const sourcePathCommand = new Command()
  .description("Show swamp source location and version")
  .example("Show source location", "swamp source path")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["source", "path"]);
    ctx.logger.debug("Executing source path command");

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const deps = createSourcePathDeps();
    const renderer = createSourcePathRenderer(ctx.outputMode);
    await consumeStream(sourcePath(libCtx, deps), renderer.handlers());

    ctx.logger.debug("Source path command completed");
  });
