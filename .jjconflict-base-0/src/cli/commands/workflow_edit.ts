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
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  renderWorkflowEdit,
  type WorkflowEditData,
} from "../../presentation/output/workflow_edit_output.ts";
import {
  renderWorkflowSearch,
  type WorkflowSearchData,
  type WorkflowSearchItem,
} from "../../presentation/output/workflow_search_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { UserError } from "../../domain/errors.ts";
import { readStdin } from "../../infrastructure/io/stdin_reader.ts";

/**
 * UUID v4 regex pattern for detecting if an argument is a UUID.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Checks if a string looks like a UUID.
 */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

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

/**
 * Resolves the symlink at workflows/{name}/workflow.yaml to find the actual
 * file path. Returns null if the symlink doesn't exist.
 */
export async function resolveWorkflowSymlink(
  repoDir: string,
  name: string,
): Promise<string | null> {
  const symlinkPath = join(repoDir, "workflows", name, "workflow.yaml");
  try {
    const realPath = await Deno.realPath(symlinkPath);
    return realPath;
  } catch {
    return null;
  }
}

export const workflowEditCommand = new Command()
  .name("edit")
  .description("Edit a workflow file")
  .arguments("[workflow_id_or_name:workflow_name]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, workflowIdOrName?: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "edit"]);
    ctx.logger.debug`Editing workflow: ${workflowIdOrName ?? "(interactive)"}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const repoDir = options.repoDir ?? ".";
    const repo = repoContext.workflowRepo;
    const editorService = new EditorService();

    // Look up the workflow
    let workflow: Workflow | null = null;
    let filePath: string | null = null;

    if (!workflowIdOrName) {
      // No argument provided - check if interactive mode
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Workflow ID or name is required in non-interactive mode",
        );
      }

      // Show search UI to select a workflow (resilient findAll skips broken files)
      const allWorkflows = await repo.findAll();

      if (allWorkflows.length === 0) {
        throw new UserError("No workflows found in repository");
      }

      const searchItems = allWorkflows.map(toSearchItem);
      const searchData: WorkflowSearchData = {
        query: "",
        results: searchItems,
      };

      const selected = await renderWorkflowSearch(searchData, ctx.outputMode);

      if (!selected) {
        ctx.logger.debug`Search cancelled`;
        return;
      }

      ctx.logger.debug`Selected workflow: ${selected.name} (${selected.id})`;

      // Find the full workflow data
      const id: WorkflowId = createWorkflowId(selected.id);
      workflow = await repo.findById(id);
      if (!workflow) {
        throw new UserError(`Workflow not found: ${selected.id}`);
      }
      filePath = repo.getPath(workflow.id);
    } else if (isUuid(workflowIdOrName)) {
      ctx.logger.debug`Looking up by ID: ${workflowIdOrName}`;
      try {
        const id: WorkflowId = createWorkflowId(workflowIdOrName);
        workflow = await repo.findById(id);
      } catch (error) {
        ctx.logger
          .debug`Workflow lookup by ID failed, will try symlink fallback: ${error}`;
      }

      if (workflow) {
        filePath = repo.getPath(workflow.id);
      } else {
        // ID-based lookup doesn't have a symlink fallback (symlinks are by name)
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }
    } else {
      ctx.logger.debug`Looking up by name: ${workflowIdOrName}`;
      try {
        workflow = await repo.findByName(workflowIdOrName);
      } catch (error) {
        ctx.logger
          .debug`Workflow lookup by name failed, will try symlink fallback: ${error}`;
      }

      if (workflow) {
        filePath = repo.getPath(workflow.id);
      } else {
        // Try symlink fallback for name-based lookup
        const resolvedPath = await resolveWorkflowSymlink(
          repoDir,
          workflowIdOrName,
        );
        if (resolvedPath) {
          ctx.logger
            .debug`Using symlink fallback for broken workflow: ${resolvedPath}`;
          filePath = resolvedPath;
        } else {
          throw new UserError(`Workflow not found: ${workflowIdOrName}`);
        }
      }
    }

    ctx.logger.debug`Using file path: ${filePath}`;

    // Check for stdin content (non-interactive update mode)
    const stdinContent = await readStdin();

    if (stdinContent !== null) {
      ctx.logger.debug`Reading workflow content from stdin`;

      if (!workflow) {
        throw new UserError(
          "Cannot update workflow from stdin: the workflow's YAML is broken and must be fixed in an editor first",
        );
      }

      try {
        // Parse YAML content from stdin
        const yamlData = parseYaml(stdinContent) as WorkflowData;

        // Preserve the original ID to ensure we update the same workflow
        yamlData.id = workflow.id;

        // Validate and create domain object
        const updatedWorkflow = Workflow.fromData(yamlData);

        // Save via repository (emits events for indexing)
        await repo.save(updatedWorkflow);

        const data: WorkflowEditData = {
          path: filePath,
          status: "updated",
          name: updatedWorkflow.name,
          id: updatedWorkflow.id,
        };

        renderWorkflowEdit(data, ctx.outputMode);
        ctx.logger.debug("Workflow updated from stdin");
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError(
          `Invalid workflow YAML from stdin: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return;
    }

    ctx.logger.debug`Opening file: ${filePath}`;

    // Open the editor (auto-detects whether to wait based on editor type)
    const result = await editorService.openFile(filePath);

    const data: WorkflowEditData = {
      path: filePath,
      editor: result.editor,
      status: "opened",
      name: workflow?.name ?? workflowIdOrName ?? "unknown",
      id: workflow?.id ?? "unknown",
    };

    renderWorkflowEdit(data, ctx.outputMode);
    ctx.logger.debug("Workflow edit command completed");
  });
