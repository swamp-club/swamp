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
  createModelOutputLogsDeps,
  modelOutputLogs,
} from "../../libswamp/mod.ts";
import { createModelOutputLogsRenderer } from "../../presentation/renderers/model_output_logs.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelOutputLogsCommand = new Command()
  .name("logs")
  .description("Show log artifact content for a model output")
  .example("Show output logs", "swamp model output logs abc123")
  .example("Tail last 100 lines", "swamp model output logs abc123 --tail 100")
  .arguments("<output_id:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--tail <n:number>", "Show only last N lines")
  .action(async function (options: AnyOptions, outputIdArg: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "model",
      "output",
      "logs",
    ]);
    cliCtx.logger.debug`Getting logs for output: ${outputIdArg}`;

    const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createModelOutputLogsDeps(repoDir, datastoreResolver);

    const renderer = createModelOutputLogsRenderer(cliCtx.outputMode);
    await consumeStream(
      modelOutputLogs(ctx, deps, {
        outputIdArg,
        tail: options.tail as number | undefined,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model output logs command completed");
  });
