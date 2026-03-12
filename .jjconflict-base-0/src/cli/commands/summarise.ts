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
import { requireInitializedRepo } from "../repo_context.ts";
import { SummaryService } from "../../domain/summary/summary_service.ts";
import { parseDuration } from "./data_search.ts";
import {
  renderNoActivity,
  renderSummary,
} from "../../presentation/output/summarise_output.ts";

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
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--since <duration:string>", "Time window (e.g. 1h, 1d, 7d, 1w)", {
    default: "7d",
  })
  .action(async function (options) {
    const ctx = createContext(options as GlobalOptions, ["summarise"]);
    ctx.logger.debug`Generating activity summary`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    const durationMs = parseDuration(options.since);
    const cutoffDate = new Date(Date.now() - durationMs);

    const service = new SummaryService(
      repoContext.outputRepo,
      repoContext.workflowRunRepo,
      repoContext.unifiedDataRepo,
      repoContext.definitionRepo,
      repoContext.workflowRepo,
    );

    const summary = await service.summarise(cutoffDate);

    const hasActivity = summary.methodExecutions.length > 0 ||
      summary.workflows.length > 0 ||
      summary.data.totalItems > 0;

    if (!hasActivity) {
      renderNoActivity(options.since, ctx.outputMode);
      return;
    }

    renderSummary(summary, options.since, ctx.outputMode, ctx.verbosity);
    ctx.logger.debug`Summarise command completed`;
  });
