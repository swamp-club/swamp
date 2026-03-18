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
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import { readLogFile } from "../../presentation/output/log_file_reader.ts";
import { toRelativePath } from "../../infrastructure/persistence/paths.ts";
import {
  consumeStream,
  createLibSwampContext,
  workflowHistoryLogs,
} from "../../libswamp/mod.ts";
import { createWorkflowHistoryLogsRenderer } from "../../presentation/renderers/workflow_history_logs.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowHistoryLogsCommand = new Command()
  .name("logs")
  .description("Show logs for a workflow run")
  .arguments("<run_id_or_workflow:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
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

    const { repoDir, repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });
    const runRepo = repoContext.workflowRunRepo;
    const workflowRepo = repoContext.workflowRepo;

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      isPartialId,
      matchRunByPartialId: async (idPrefix: string) => {
        const allRuns = await runRepo.findAllGlobal();
        const result = matchByPartialId(
          allRuns.map((r) => ({ id: r.run.id, item: r.run })),
          idPrefix,
        );
        if (result.status === "found") {
          return { status: "found" as const, match: result.match };
        }
        if (result.status === "ambiguous") {
          return {
            status: "ambiguous" as const,
            matches: result.matches.map((m) => ({ id: m.id })),
          };
        }
        return { status: "not_found" as const };
      },
      findWorkflow: async (nameOrId: string) =>
        await workflowRepo.findByName(nameOrId) ??
          await workflowRepo.findById(createWorkflowId(nameOrId)),
      findLatestRun: (workflowId: string) =>
        runRepo.findLatestByWorkflowId(
          createWorkflowId(workflowId),
        ),
      readLogFile,
      toRelativePath,
    };

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
