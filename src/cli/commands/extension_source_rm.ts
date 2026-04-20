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
  createSourceRemoveDeps,
  sourceRemove,
} from "../../libswamp/mod.ts";
import { createSourceModifyRenderer } from "../../presentation/renderers/extension_source_modify.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionSourceRmCommand = new Command()
  .name("rm")
  .description("Remove a local extension source")
  .example(
    "Remove a source",
    'swamp extension source rm "~/code/swamp-extensions/model/aws/*"',
  )
  .arguments("<path:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, path: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "source",
      "rm",
    ]);
    cliCtx.logger.debug`Removing extension source: ${path}`;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createSourceRemoveDeps(resolveRepoDir(options.repoDir));

    const renderer = createSourceModifyRenderer(cliCtx.outputMode);
    await consumeStream(
      sourceRemove(ctx, deps, path),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Extension source rm command completed");
  });
