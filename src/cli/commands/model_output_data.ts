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
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  consumeStream,
  createLibSwampContext,
  createModelOutputDataDeps,
  modelOutputData,
} from "../../libswamp/mod.ts";
import { createModelOutputDataRenderer } from "../../presentation/renderers/model_output_data.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelOutputDataCommand = new Command()
  .name("data")
  .description("Show data artifact content for a model output")
  .example("Show output data", "swamp model output data abc123")
  .example(
    "Show specific field",
    "swamp model output data abc123 --field status",
  )
  .example(
    "Show specific version",
    "swamp model output data abc123 --version 2",
  )
  .arguments("<output_id:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--field <name:string>", "Show only a specific field from the data")
  .option(
    "--version <version:number>",
    "Specific data version (defaults to artifact version)",
  )
  .option(
    "--name <name:string>",
    "Data name to retrieve (if output has multiple artifacts)",
  )
  .action(async function (options: AnyOptions, outputIdArg: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "data",
    ]);
    cliCtx.logger.debug`Getting data for output: ${outputIdArg}`;

    const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createModelOutputDataDeps(repoDir, datastoreResolver);

    const renderer = createModelOutputDataRenderer(cliCtx.outputMode);
    await consumeStream(
      modelOutputData(ctx, deps, {
        outputIdArg,
        name: options.name as string | undefined,
        field: options.field as string | undefined,
        version: options.version as number | undefined,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model output data command completed");
  });
