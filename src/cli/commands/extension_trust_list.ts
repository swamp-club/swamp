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
  createTrustListDeps,
  trustList,
} from "../../libswamp/mod.ts";
import { createTrustListRenderer } from "../../presentation/renderers/trust_list.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionTrustListCommand = new Command()
  .name("list")
  .description("List trusted collectives for extension auto-resolution")
  .example("List trusted collectives", "swamp extension trust list")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "trust",
      "list",
    ]);
    cliCtx.logger.debug("Executing extension trust list command");

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createTrustListDeps(resolveRepoDir(options.repoDir));

    const renderer = createTrustListRenderer(cliCtx.outputMode);
    await consumeStream(trustList(ctx, deps), renderer.handlers());

    cliCtx.logger.debug("Extension trust list command completed");
  });
