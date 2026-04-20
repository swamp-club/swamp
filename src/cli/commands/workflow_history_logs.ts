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
  createWorkflowHistoryLogsDeps,
  workflowHistoryLogs,
} from "../../libswamp/mod.ts";
import { createWorkflowHistoryLogsRenderer } from "../../presentation/renderers/workflow_history_logs.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowHistoryLogsCommand = new Command()
  .name("logs")
  .description("Show logs for a workflow run")
  .example("Show run logs", "swamp workflow history logs deploy-pipeline")
  .example("Tail last 50 lines", "swamp workflow history logs abc123 --tail 50")
  .arguments("<run_id_or_workflow:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--tail <lines:number>", "Show only the last N lines")
  .action(async function (
    options: AnyOptions,
    runIdOrWorkflow: string,
  ) {
    const cliCtx = createContext(
      options as GlobalOptions,
      ["workflow", "history", "logs"],
    );
    cliCtx.logger.debug`Getting logs for workflow run: ${runIdOrWorkflow}`;

    const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowHistoryLogsDeps(repoDir, datastoreResolver);

    const renderer = createWorkflowHistoryLogsRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowHistoryLogs(ctx, deps, {
        runIdOrWorkflow,
        tail: options.tail as number | undefined,
        repoDir,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Workflow history logs command completed");
  });
