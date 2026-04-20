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
  createWorkflowHistoryGetDeps,
  workflowHistoryGet,
} from "../../libswamp/mod.ts";
import { createWorkflowHistoryGetRenderer } from "../../presentation/renderers/workflow_history_get.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowHistoryGetCommand = new Command()
  .name("get")
  .description("Show the latest run for a workflow")
  .example("Show latest run", "swamp workflow history get deploy-pipeline")
  .arguments("<workflow_id_or_name:workflow_name>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "history",
      "get",
    ]);
    cliCtx.logger.debug`Getting latest run for workflow: ${workflowIdOrName}`;

    const { repoDir, datastoreResolver } = await requireInitializedRepoReadOnly(
      {
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      },
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowHistoryGetDeps(repoDir, datastoreResolver);

    const renderer = createWorkflowHistoryGetRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowHistoryGet(ctx, deps, workflowIdOrName),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Workflow history get command completed");
  });
