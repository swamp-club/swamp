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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  consumeStream,
  createLibSwampContext,
  createSourceListDeps,
  sourceList,
} from "../../libswamp/mod.ts";
import { createSourceListRenderer } from "../../presentation/renderers/extension_source_list.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionSourceListCommand = new Command()
  .name("list")
  .description("List configured extension sources")
  .example("List all sources", "swamp extension source list")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "source",
      "list",
    ]);

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createSourceListDeps(resolveRepoDir(options.repoDir));

    const renderer = createSourceListRenderer(cliCtx.outputMode);
    await consumeStream(sourceList(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Extension source list command completed");
  });
