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
  createTrustAddDeps,
  trustAdd,
} from "../../libswamp/mod.ts";
import { createTrustModifyRenderer } from "../../presentation/renderers/trust_modify.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const extensionTrustAddCommand = new Command()
  .name("add")
  .description("Add a collective to the trusted list")
  .example("Trust a collective", "swamp extension trust add stack72")
  .arguments("<collective:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, collective: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "extension",
      "trust",
      "add",
    ]);
    cliCtx.logger.debug`Adding trusted collective: ${collective}`;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createTrustAddDeps(resolveRepoDir(options.repoDir));

    const renderer = createTrustModifyRenderer(cliCtx.outputMode);
    await consumeStream(trustAdd(ctx, deps, collective), renderer.handlers());

    cliCtx.logger.debug("Extension trust add command completed");
  });
