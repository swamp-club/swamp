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
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import { UserError } from "../../domain/errors.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";
import {
  readLogFile,
  renderLogFile,
} from "../../presentation/output/log_file_reader.ts";

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
    const ctx = createContext(
      options as GlobalOptions,
      ["workflow", "history", "logs"],
    );
    ctx.logger.debug`Getting logs for workflow run: ${runIdOrWorkflow}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const runRepo = repoContext.workflowRunRepo;
    const workflowRepo = repoContext.workflowRepo;

    let run: WorkflowRun | undefined;

    // Try partial ID matching first if input looks like an ID
    if (isPartialId(runIdOrWorkflow)) {
      const allRuns = await runRepo.findAllGlobal();
      const result = matchByPartialId(
        allRuns.map((r) => ({ id: r.run.id, item: r })),
        runIdOrWorkflow,
      );

      if (result.status === "found") {
        run = result.match.run;
      } else if (result.status === "ambiguous") {
        throw new UserError(
          `Ambiguous ID prefix "${runIdOrWorkflow}" matches:\n` +
            result.matches.map((m) => `  ${m.id}`).join("\n"),
        );
      }
      // not_found: fall through to workflow name lookup
    }

    // If not found as run ID, try as workflow name and get latest run
    if (!run) {
      const workflow = await workflowRepo.findByName(runIdOrWorkflow) ??
        await workflowRepo.findById(createWorkflowId(runIdOrWorkflow));

      if (!workflow) {
        throw new UserError(
          `No workflow run or workflow found: ${runIdOrWorkflow}`,
        );
      }

      const latestRun = await runRepo.findLatestByWorkflowId(workflow.id);
      if (!latestRun) {
        throw new UserError(
          `No runs found for workflow: ${workflow.name}`,
        );
      }

      run = latestRun;
      ctx.logger
        .debug`Using latest run for workflow ${workflow.name}: ${run.id}`;
    }

    // Read log file
    if (!run.logFile) {
      if (ctx.outputMode === "json") {
        console.log(JSON.stringify(
          {
            runId: run.id,
            workflowName: run.workflowName,
            error: "No log file recorded for this run (pre-logFile run)",
          },
          null,
          2,
        ));
      } else {
        console.log(
          `No log file recorded for run ${run.id.slice(0, 8)}. ` +
            `This run predates log file tracking.`,
        );
      }
      return;
    }

    const tail = options.tail as number | undefined;
    const logData = await readLogFile(run.logFile, { tail });

    if (logData.lines.length === 0) {
      if (ctx.outputMode === "json") {
        console.log(JSON.stringify(
          {
            runId: run.id,
            workflowName: run.workflowName,
            path: run.logFile,
            lines: [],
            lineCount: 0,
          },
          null,
          2,
        ));
      } else {
        console.log(`Log file not found or empty: ${run.logFile}`);
      }
      return;
    }

    renderLogFile(logData, ctx.outputMode);

    ctx.logger.debug("Workflow history logs command completed");
  });
