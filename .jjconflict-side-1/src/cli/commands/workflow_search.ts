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
  renderWorkflowSearch,
  type WorkflowSearchData,
  type WorkflowSearchItem,
} from "../../presentation/output/workflow_search_output.tsx";
import {
  renderWorkflowGet,
  type WorkflowGetData,
} from "../../presentation/output/workflow_get_output.ts";
import { renderWorkflowActionSelect } from "../../presentation/output/workflow_action_select_output.tsx";
import { renderInputFileSelect } from "../../presentation/output/input_file_select_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import type { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { WorkflowExecutionService } from "../../domain/workflows/execution_service.ts";
import { createLogProgressCallback } from "../../presentation/output/log_progress_callback.ts";
import { parseInputs } from "../input_parser.ts";
import { InputValidationService } from "../../domain/inputs/mod.ts";
import type { InputsSchema } from "../../domain/definitions/definition.ts";

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
 * Filters workflows by a query string (case-insensitive match on name, id, or description).
 */
function filterWorkflows(
  workflows: WorkflowSearchItem[],
  query: string,
): WorkflowSearchItem[] {
  if (!query) {
    return workflows;
  }
  const lowerQuery = query.toLowerCase();
  return workflows.filter(
    (w) =>
      w.name.toLowerCase().includes(lowerQuery) ||
      w.id.toLowerCase().includes(lowerQuery) ||
      (w.description?.toLowerCase().includes(lowerQuery) ?? false),
  );
}

/**
 * Displays the workflow get output for a selected workflow.
 */
async function displayWorkflowGet(
  item: WorkflowSearchItem,
  repo: YamlWorkflowRepository,
  options: AnyOptions,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["workflow", "search"]);
  const workflow = await repo.findByName(item.name);

  if (!workflow) {
    throw new UserError(`Workflow not found: ${item.name}`);
  }

  const data: WorkflowGetData = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    version: workflow.version,
    jobs: workflow.jobs.map((job) => ({
      name: job.name,
      description: job.description,
      steps: job.steps.map((step) => ({
        name: step.name,
        description: step.description,
        task: step.task.toData(),
      })),
    })),
    path: repo.getPath(workflow.id),
  };

  renderWorkflowGet(data, ctx.outputMode);
}

/**
 * Gets the required input names from a workflow's input schema.
 */
function getRequiredInputs(schema: InputsSchema | undefined): string[] {
  if (!schema) return [];

  const properties = schema.properties ?? schema;
  const required = schema.required ?? [];

  // Find required inputs that don't have defaults
  const missingRequired: string[] = [];
  for (const key of required) {
    const propSchema = properties[key];
    if (
      propSchema &&
      typeof propSchema === "object" &&
      propSchema !== null &&
      !("default" in propSchema)
    ) {
      missingRequired.push(key);
    }
  }

  return missingRequired;
}

/**
 * Checks if all required inputs have defaults.
 */
function hasAllDefaults(schema: InputsSchema | undefined): boolean {
  if (!schema) return true;

  const properties = schema.properties ?? schema;
  const required = schema.required ?? [];

  for (const key of required) {
    const propSchema = properties[key];
    if (
      propSchema &&
      typeof propSchema === "object" &&
      propSchema !== null &&
      !("default" in propSchema)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Executes a workflow after search selection.
 */
async function executeWorkflowFromSearch(
  item: WorkflowSearchItem,
  repo: YamlWorkflowRepository,
  runRepo: YamlWorkflowRunRepository,
  repoDir: string,
  options: AnyOptions,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["workflow", "search"]);
  const workflow = await repo.findByName(item.name);

  if (!workflow) {
    throw new UserError(`Workflow not found: ${item.name}`);
  }

  // Get required inputs info
  const requiredInputs = getRequiredInputs(workflow.inputs);
  const allHaveDefaults = hasAllDefaults(workflow.inputs);

  // Show input file selection if workflow has inputs
  let inputFilePath: string | undefined;

  if (workflow.inputs && Object.keys(workflow.inputs).length > 0) {
    const selection = await renderInputFileSelect(
      {
        workflowName: workflow.name,
        requiredInputs,
        hasDefaults: allHaveDefaults,
        searchDir: repoDir,
      },
      ctx.outputMode,
    );

    if (!selection) {
      // User cancelled
      ctx.logger.debug`Input file selection cancelled`;
      return;
    }

    if (selection.type === "file" && selection.path) {
      inputFilePath = selection.path;
    }
  }

  // Parse inputs from selected file
  const { inputs } = await parseInputs({
    inputFile: inputFilePath,
  });

  // Validate inputs
  if (workflow.inputs) {
    const validationService = new InputValidationService();
    const inputsWithDefaults = validationService.applyDefaults(
      inputs,
      workflow.inputs,
    );
    const validationResult = validationService.validate(
      inputsWithDefaults,
      workflow.inputs,
    );
    if (!validationResult.valid) {
      const errorMessages = validationResult.errors
        .map((e) => `  ${e.message}`)
        .join("\n");
      throw new UserError(`Input validation failed:\n${errorMessages}`);
    }
    // Use inputs with defaults applied
    Object.assign(inputs, inputsWithDefaults);
  }

  // Execute workflow
  const executionService = new WorkflowExecutionService(
    repo,
    runRepo,
    repoDir,
  );

  const progress = createLogProgressCallback(workflow.name);
  const run = await executionService.execute(workflow.name, progress, {
    enableStepLogging: true,
    inputs,
  });

  ctx.logger.debug`Workflow run completed: status=${run.status}`;

  if (run.status === "failed") {
    Deno.exit(1);
  }
}

export const workflowSearchCommand = new Command()
  .name("search")
  .description("Search for workflows")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, ["workflow", "search"]);
    ctx.logger.debug`Searching workflows with query: ${query ?? "(none)"}`;

    const { repoDir, repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const repo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    const allWorkflows = await repo.findAll();
    const searchItems = allWorkflows.map(toSearchItem);

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredWorkflows = filterWorkflows(searchItems, query ?? "");

      // If query matches exactly one workflow, show full details (same as interactive selection)
      if (query && filteredWorkflows.length === 1) {
        await displayWorkflowGet(filteredWorkflows[0], repo, options);
      } else {
        const data: WorkflowSearchData = {
          query: query ?? "",
          results: filteredWorkflows,
        };
        await renderWorkflowSearch(data, ctx.outputMode);
      }
    } else {
      // Interactive: show fuzzy search UI
      const data: WorkflowSearchData = {
        query: query ?? "",
        results: searchItems,
      };

      const selected = await renderWorkflowSearch(data, ctx.outputMode);

      if (selected) {
        ctx.logger.debug`Selected workflow: ${selected.name}`;

        // Get the full workflow to check for inputs
        const workflow = await repo.findByName(selected.name);
        const hasInputs = !!(workflow?.inputs &&
          Object.keys(workflow.inputs).length > 0);

        // Show action selection
        const action = await renderWorkflowActionSelect(
          {
            workflowName: selected.name,
            workflowDescription: selected.description,
            hasInputs,
          },
          ctx.outputMode,
        );

        if (!action) {
          ctx.logger.debug`Action selection cancelled`;
          return;
        }

        if (action === "view") {
          // Display the workflow details
          await displayWorkflowGet(selected, repo, options);
        } else if (action === "run") {
          // Execute the workflow
          await executeWorkflowFromSearch(
            selected,
            repo,
            runRepo,
            repoDir,
            options,
          );
        }
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Workflow search command completed");
  });
