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
import { parseDuration } from "../../libswamp/mod.ts";
import {
  consumeStream,
  createLibSwampContext,
  createSummariseDeps,
  summarise,
} from "../../libswamp/mod.ts";
import { createSummariseRenderer } from "../../presentation/renderers/summarise.ts";

/**
 * `swamp summarise`
 *
 * Shows a high-level overview of repo activity over a time window.
 */
export const summariseCommand = new Command()
  .name("summarise")
  .alias("summarize")
  .description(
    "Show a high-level overview of repo activity (method executions, workflows, data)",
  )
  .example("Show recent activity", "swamp summarise")
  .example("Activity from the last day", "swamp summarise --since 1d")
  .example("Activity from the last hour", "swamp summarise --since 1h")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--since <duration:string>", "Time window (e.g. 1h, 1d, 7d, 1w)", {
    default: "7d",
  })
  .action(async function (options) {
    const ctx = createContext(options as GlobalOptions, ["summarise"]);
    ctx.logger.debug`Generating activity summary`;

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

    const durationMs = parseDuration(options.since);
    const cutoffDate = new Date(Date.now() - durationMs);

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const deps = createSummariseDeps({
      outputRepo: repoContext.outputRepo,
      workflowRunRepo: repoContext.workflowRunRepo,
      dataRepo: repoContext.unifiedDataRepo,
      definitionRepo: repoContext.definitionRepo,
      workflowRepo: repoContext.workflowRepo,
    });
    const renderer = createSummariseRenderer(ctx.outputMode, ctx.verbosity);
    await consumeStream(
      summarise(libCtx, deps, {
        since: cutoffDate,
        sinceLabel: options.since,
      }),
      renderer.handlers(),
    );

    ctx.logger.debug`Summarise command completed`;
  });
