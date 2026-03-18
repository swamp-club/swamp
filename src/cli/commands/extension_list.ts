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
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  consumeStream,
  createExtensionListDeps,
  createLibSwampContext,
  extensionList,
} from "../../libswamp/mod.ts";
import { createExtensionListRenderer } from "../../presentation/renderers/extension_list.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionListCommand = new Command()
  .name("list")
  .alias("ls")
  .description("List upstream installed extensions")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "list",
    ]);
    cliCtx.logger.debug`Starting extension list`;

    const repoDir = options.repoDir ?? ".";
    await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createExtensionListDeps(repoDir);

    const verbose = cliCtx.verbosity === "verbose";
    const renderer = createExtensionListRenderer(cliCtx.outputMode, verbose);
    await consumeStream(extensionList(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Extension list command completed");
  });
