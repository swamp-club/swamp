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
import { consumeStream } from "../../libswamp/mod.ts";
import { workflowHistoryGet } from "../../libswamp/workflows/history_get.ts";
import type { WorkflowHistoryGetDeps } from "../../libswamp/workflows/history_get.ts";
import { createWorkflowHistoryGetRenderer } from "../../presentation/renderers/workflow_history_get.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowHistoryGetCommand = new Command()
  .name("get")
  .description("Show the latest run for a workflow")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "history",
      "get",
    ]);
    cliCtx.logger.debug`Getting latest run for workflow: ${workflowIdOrName}`;

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });
    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    const deps: WorkflowHistoryGetDeps = {
      findWorkflow: async (idOrName) =>
        await workflowRepo.findByName(idOrName) ??
          await workflowRepo.findById(createWorkflowId(idOrName)),
      findLatestRun: (workflowId) => runRepo.findLatestByWorkflowId(workflowId),
      getRunPath: (workflowId, runId) =>
        runRepo.getPath(workflowId, createWorkflowRunId(runId)),
    };

    const renderer = createWorkflowHistoryGetRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowHistoryGet(deps, workflowIdOrName),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Workflow history get command completed");
  });
