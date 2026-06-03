// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import { join } from "@std/path";
import type { Workflow } from "../workflows/workflow.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type { WorkflowRepository } from "../workflows/repositories.ts";
import { ModelType } from "../models/model_type.ts";

const MAX_WORKFLOW_DEPTH = 10;

/** Result of resolving workflow dependencies. */
export interface ResolvedDependencies {
  /** Absolute paths to model .ts files needed. */
  modelFiles: string[];
  /** Absolute paths to workflow YAML files needed. */
  workflowFiles: string[];
  /** Model names that couldn't be resolved to source files. */
  unresolvedModels: string[];
  /** Built-in model types that don't need bundling. */
  skippedBuiltinModels: string[];
}

/** Dependencies required for resolving. */
export interface DependencyResolverContext {
  workflowRepo: WorkflowRepository;
  definitionRepo: DefinitionRepository;
  modelsDir: string;
}

/**
 * Resolves which models and sub-workflows a set of workflows references.
 *
 * Parses workflow jobs/steps for `model_method` tasks, looks up definitions
 * to get model types, and finds matching source files in `extensions/models/`
 * for `@`-namespaced types. Handles nested `workflow` step tasks recursively.
 *
 * @param workflowNames - Names of workflows to resolve
 * @param ctx - Repository context for lookups
 * @returns Resolved model files, workflow files, and unresolved/skipped info
 */
export async function resolveWorkflowDependencies(
  workflowNames: string[],
  ctx: DependencyResolverContext,
): Promise<ResolvedDependencies> {
  const modelFiles = new Set<string>();
  const workflowPaths = new Set<string>();
  const unresolvedModels = new Set<string>();
  const skippedBuiltinModels = new Set<string>();
  const visitedWorkflows = new Set<string>();

  async function visitWorkflow(
    workflowName: string,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_WORKFLOW_DEPTH) return;
    if (visitedWorkflows.has(workflowName)) return;
    visitedWorkflows.add(workflowName);

    const workflow = await ctx.workflowRepo.findByName(workflowName);
    if (!workflow) return;

    // Record the workflow file path
    const wfPath = ctx.workflowRepo.getPath(workflow.id);
    workflowPaths.add(wfPath);

    await processWorkflow(workflow, depth);
  }

  async function processWorkflow(
    workflow: Workflow,
    depth: number,
  ): Promise<void> {
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const task = step.task;

        if (task.isModelMethod()) {
          const data = task.data as {
            type: "model_method";
            modelIdOrName: string;
          };
          await resolveModel(data.modelIdOrName);
        } else if (task.isWorkflow()) {
          const data = task.data as {
            type: "workflow";
            workflowIdOrName: string;
          };
          await visitWorkflow(data.workflowIdOrName, depth + 1);
        }
      }
    }
  }

  async function resolveModel(modelIdOrName: string): Promise<void> {
    // Look up the definition to get its type
    const result = await ctx.definitionRepo.findByNameGlobal(modelIdOrName);
    if (!result) {
      unresolvedModels.add(modelIdOrName);
      return;
    }

    const typeNormalized = result.type.toNormalized();

    // Skip built-in models (non user-namespace)
    if (!ModelType.isUserNamespace(typeNormalized)) {
      skippedBuiltinModels.add(typeNormalized);
      return;
    }

    // Find the source file: modelsDir / type-path / model.ts
    const modelPath = join(ctx.modelsDir, typeNormalized, "model.ts");
    modelFiles.add(modelPath);
  }

  for (const name of workflowNames) {
    await visitWorkflow(name, 0);
  }

  return {
    modelFiles: [...modelFiles].sort(),
    workflowFiles: [...workflowPaths].sort(),
    unresolvedModels: [...unresolvedModels].sort(),
    skippedBuiltinModels: [...skippedBuiltinModels].sort(),
  };
}
