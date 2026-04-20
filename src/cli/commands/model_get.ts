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
  consumeStream,
  createLibSwampContext,
  createModelGetDeps,
  modelGet,
} from "../../libswamp/mod.ts";
import { createModelGetRenderer } from "../../presentation/renderers/model_get.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelGetCommand = new Command()
  .name("get")
  .description("Show details of a model definition")
  .example("Show model details", "swamp model get my-server")
  .example("JSON output", "swamp model get my-server --json")
  .arguments("<model_id_or_name:model_name>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const cliCtx = createContext(options as GlobalOptions, ["model", "get"]);
    cliCtx.logger.debug`Getting model: ${modelIdOrName}`;

    const { repoDir } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createModelGetDeps(repoDir);

    const renderer = createModelGetRenderer(cliCtx.outputMode);
    await consumeStream(
      modelGet(ctx, deps, modelIdOrName),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model get command completed");
  });
