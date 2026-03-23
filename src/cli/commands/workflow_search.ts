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
  type WorkflowGetData,
  workflowSearch,
  type WorkflowSearchDeps,
  type WorkflowSearchItem,
} from "../../libswamp/mod.ts";
import { createWorkflowSearchRenderer } from "../../presentation/renderers/workflow_search.tsx";
import { renderWorkflowGet } from "../../presentation/renderers/workflow_get.ts";
import { renderWorkflowActionSelect } from "../../presentation/output/workflow_action_select_output.tsx";
import { renderInputFileSelect } from "../../presentation/output/input_file_select_output.tsx";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
} from "../context.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
} from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { WorkflowExecutionService } from "../../domain/workflows/execution_service.ts";
import { parseInputs } from "../input_parser.ts";
import { InputValidationService } from "../../domain/inputs/mod.ts";
import type { InputsSchema } from "../../domain/definitions/definition.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Displays the workflow get output for a selected workflow.
 */
async function displayWorkflowGet(
  item: WorkflowSearchItem,
  repo: WorkflowRepository,
  options: AnyOptions,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["workflow", "search"]);
  const effectiveMode = interactiveOutputMode(ctx);
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

  renderWorkflowGet(data, effectiveMode);
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
  repo: WorkflowRepository,
  runRepo: YamlWorkflowRunRepository,
  repoDir: string,
  options: AnyOptions,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, ["workflow", "search"]);
  const effectiveMode = interactiveOutputMode(ctx);
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
      effectiveMode,
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

  const run = await executionService.execute(workflow.name, {
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
    const effectiveMode = interactiveOutputMode(ctx);
    const libCtx = createLibSwampContext();
    ctx.logger.debug`Searching workflows with query: ${query ?? "(none)"}`;

    // Interactive mode can trigger workflow execution (a write operation),
    // so it needs the full lock. JSON mode is always read-only.
    const initRepo = effectiveMode === "log"
      ? requireInitializedRepo
      : requireInitializedRepoReadOnly;
    const { repoDir, repoContext } = await initRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: effectiveMode,
    });
    const repo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    const deps: WorkflowSearchDeps = {
      findAllWorkflows: () => repo.findAll(),
    };

    const renderer = createWorkflowSearchRenderer(effectiveMode);
    await consumeStream(
      workflowSearch(libCtx, deps, { query }),
      renderer.handlers(),
    );

    const selected = renderer.selectedItem();

    if (selected) {
      ctx.logger.debug`Selected workflow: ${selected.name}`;

      if (effectiveMode === "json") {
        // JSON mode: auto-selected single match, display details
        await displayWorkflowGet(selected, repo, options);
      } else {
        // Interactive mode: show action selection
        const workflow = await repo.findByName(selected.name);
        const hasInputs = !!(workflow?.inputs &&
          Object.keys(workflow.inputs).length > 0);

        const action = await renderWorkflowActionSelect(
          {
            workflowName: selected.name,
            workflowDescription: selected.description,
            hasInputs,
          },
          effectiveMode,
        );

        if (!action) {
          ctx.logger.debug`Action selection cancelled`;
          return;
        }

        if (action === "view") {
          await displayWorkflowGet(selected, repo, options);
        } else if (action === "run") {
          await executeWorkflowFromSearch(
            selected,
            repo,
            runRepo,
            repoDir,
            options,
          );
        }
      }
    } else {
      ctx.logger.debug`Search cancelled`;
    }

    ctx.logger.debug("Workflow search command completed");
  });
