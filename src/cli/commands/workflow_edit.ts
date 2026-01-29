import { Command } from "@cliffy/command";
import {
  renderWorkflowEdit,
  type WorkflowEditData,
} from "../../presentation/output/workflow_edit_output.tsx";
import {
  renderWorkflowSearch,
  type WorkflowSearchData,
  type WorkflowSearchItem,
} from "../../presentation/output/workflow_search_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import { UserError } from "../../domain/errors.ts";

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

export const workflowEditCommand = new Command()
  .name("edit")
  .description("Edit a workflow file")
  .arguments("[workflow_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, workflowIdOrName?: string) {
    const ctx = createContext(options as GlobalOptions, "workflow-edit");
    ctx.logger.debug`Editing workflow: ${workflowIdOrName ?? "(interactive)"}`;

    const repoDir = options.repoDir ?? ".";
    const repo = new YamlWorkflowRepository(repoDir);
    const editorService = new EditorService();

    // Look up the workflow
    let workflow: Workflow | null = null;

    if (!workflowIdOrName) {
      // No argument provided - check if interactive mode
      if (ctx.outputMode === "json") {
        throw new UserError(
          "Workflow ID or name is required in non-interactive mode",
        );
      }

      // Show search UI to select a workflow
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
    } else if (isUuid(workflowIdOrName)) {
      ctx.logger.debug`Looking up by ID: ${workflowIdOrName}`;
      const id: WorkflowId = createWorkflowId(workflowIdOrName);
      workflow = await repo.findById(id);
      if (!workflow) {
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }
    } else {
      ctx.logger.debug`Looking up by name: ${workflowIdOrName}`;
      workflow = await repo.findByName(workflowIdOrName);
      if (!workflow) {
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }
    }

    ctx.logger.debug`Found workflow: id=${workflow.id}, name=${workflow.name}`;

    // Get the file path
    const filePath = repo.getPath(workflow.id);

    ctx.logger.debug`Opening file: ${filePath}`;

    // Open the editor (auto-detects whether to wait based on editor type)
    const result = await editorService.openFile(filePath);

    const data: WorkflowEditData = {
      path: filePath,
      editor: result.editor,
      status: "opened",
      name: workflow.name,
      id: workflow.id,
    };

    renderWorkflowEdit(data, ctx.outputMode);
    ctx.logger.debug("Workflow edit command completed");
  });
