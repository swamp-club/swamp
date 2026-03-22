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
} from "../../libswamp/mod.ts";
import {
  renderWorkflowSearch,
  type WorkflowSearchData,
  type WorkflowSearchItem,
} from "../../presentation/output/workflow_search_output.tsx";
import { createWorkflowEditRenderer } from "../../presentation/renderers/workflow_edit.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import { UserError } from "../../domain/errors.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a Workflow to WorkflowSearchItem.
 */
function toSearchItem(workflow: Workflow): WorkflowSearchItem {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    jobCount: workflow.jobs.length,
  };
}

export const workflowEditCommand = new Command()
  .name("edit")
  .description("Edit a workflow file")
  .arguments("[workflow_id_or_name:workflow_name]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "workflow",
      "edit",
    ]);
    cliCtx.logger
      .debug`Editing workflow: ${workflowIdOrName ?? "(interactive)"}`;

    const { repoContext, repoDir } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });

    // Interactive search mode when no argument provided
    if (!workflowIdOrName) {
      if (cliCtx.outputMode === "json") {
        throw new UserError(
          "Workflow ID or name is required in non-interactive mode",
        );
      }

      const repo = repoContext.workflowRepo;
      const allWorkflows = await repo.findAll();

      if (allWorkflows.length === 0) {
        throw new UserError("No workflows found in repository");
      }

      const searchItems = allWorkflows.map(toSearchItem);
      const searchData: WorkflowSearchData = {
        query: "",
        results: searchItems,
      };

      const selected = await renderWorkflowSearch(
        searchData,
        cliCtx.outputMode,
      );

      if (!selected) {
        cliCtx.logger.debug`Search cancelled`;
        return;
      }

      cliCtx.logger
        .debug`Selected workflow: ${selected.name} (${selected.id})`;
      workflowIdOrName = selected.id;
    }

    const stdinContent = await readStdin();

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createWorkflowEditDeps(repoDir);

    const renderer = createWorkflowEditRenderer(cliCtx.outputMode);
    await consumeStream(
      workflowEdit(ctx, deps, {
        workflowIdOrName,
        stdinContent,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Workflow edit command completed");
  });
