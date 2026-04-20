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
  createWorkflowEditDeps,
  workflowEdit,
  workflowSearch,
  type WorkflowSearchDeps,
} from "../../libswamp/mod.ts";
import { createWorkflowSearchRenderer } from "../../presentation/renderers/workflow_search.tsx";
import { createWorkflowEditRenderer } from "../../presentation/renderers/workflow_edit.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowEditCommand = new Command()
  .name("edit")
  .description("Edit a workflow file")
  .example("Edit a workflow", "swamp workflow edit deploy-pipeline")
  .example("Interactive search", "swamp workflow edit")
  .arguments("[workflow_id_or_name:workflow_name]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "edit",
    ]);
    cliCtx.logger
      .debug`Editing workflow: ${workflowIdOrName ?? "(interactive)"}`;

    const { repoContext, repoDir } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const libCtx = createLibSwampContext({ logger: cliCtx.logger });

    // Interactive search mode when no argument provided
    if (!workflowIdOrName) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Workflow ID or name is required in non-interactive mode",
        );
      }

      const searchDeps: WorkflowSearchDeps = {
        findAllWorkflows: () => repoContext.workflowRepo.findAll(),
      };

      const searchRenderer = createWorkflowSearchRenderer(cliCtx.outputMode);
      await consumeStream(
        workflowSearch(libCtx, searchDeps, { query: undefined }),
        searchRenderer.handlers(),
      );

      const selected = searchRenderer.selectedItem();
      if (!selected) {
        cliCtx.logger.debug`Search cancelled`;
        return;
      }

      cliCtx.logger
        .debug`Selected workflow: ${selected.name} (${selected.id})`;
      workflowIdOrName = selected.id;
    }

    const stdinContent = await readStdin();
    const deps = createWorkflowEditDeps(repoDir, repoContext.workflowRepo);

    const renderer = createWorkflowEditRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowEdit(libCtx, deps, {
        workflowIdOrName,
        stdinContent,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Workflow edit command completed");
  });
