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
  createTelemetryStatsDeps,
  telemetryStats,
} from "../../libswamp/mod.ts";
import { createTelemetryStatsRenderer } from "../../presentation/renderers/telemetry_stats.ts";
import { VERSION } from "./version.ts";

export const telemetryStatsCommand = new Command()
  .name("stats")
  .description("View telemetry usage statistics")
  .example("View usage statistics", "swamp telemetry stats")
  .example("Last 7 days", "swamp telemetry stats --days 7")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--days <days:number>", "Number of days to analyze", { default: 2 })
  .action(async function (options) {
    const cliCtx = createContext(options as GlobalOptions, [
      "telemetry",
      "stats",
    ]);
    cliCtx.logger.debug`Fetching telemetry stats`;

    const { repoDir } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createTelemetryStatsDeps(repoDir, VERSION);
    const renderer = createTelemetryStatsRenderer(cliCtx.outputMode);

    await consumeStream(
      telemetryStats(ctx, deps, { days: options.days }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Telemetry stats command completed");
  });

export const telemetryCommand = new Command()
  .name("telemetry")
  .description("Manage CLI telemetry")
  .action(function () {
    this.showHelp();
  })
  .command("stats", telemetryStatsCommand);
