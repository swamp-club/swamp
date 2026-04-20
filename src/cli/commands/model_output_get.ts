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
  createModelOutputGetDeps,
  modelOutputGet,
} from "../../libswamp/mod.ts";
import { createModelOutputGetRenderer } from "../../presentation/renderers/model_output_get.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelOutputGetCommand = new Command()
  .name("get")
  .description("Show details of a model output")
  .example("Show output details by ID", "swamp model output get abc123")
  .example("Show latest output for a model", "swamp model output get my-server")
  .arguments("<output_id_or_model_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions, outputIdOrModelName: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "get",
    ]);
    cliCtx.logger.debug`Getting output: ${outputIdOrModelName}`;

    const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = await createModelOutputGetDeps(repoDir, datastoreResolver);

    const renderer = createModelOutputGetRenderer(cliCtx.outputMode);
    await consumeStream(
      modelOutputGet(ctx, deps, outputIdOrModelName),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model output get command completed");
  });
