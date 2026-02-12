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

import type { Job } from "./job.ts";
import type { GraphNode } from "./topological_sort_service.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { findDefinitionByIdOrName } from "../models/model_lookup.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";
import {
  extractFileContentsDependencies,
  extractResourceDependencies,
} from "../expressions/dependency_extractor.ts";

/**
 * Builds step graph nodes including implicit dependencies from CEL expressions.
 *
 * If a step's model definition has `${{ model.X.resource.attributes.Y }}`, then
 * that step implicitly depends on the step that creates model X's resource.
 * Similarly for `file.contents('model', ...)` references.
 *
 * Also scans task.inputs for implicit dependencies.
 *
 * @param job - The job containing steps to analyze
 * @param definitionRepo - Repository for looking up model definitions
 * @returns The graph nodes and a mapping of step names to their implicit dependencies
 */
export async function buildStepNodesWithImplicitDeps(
  job: Job,
  definitionRepo: YamlDefinitionRepository,
): Promise<{ nodes: GraphNode[]; implicitDeps: Map<string, string[]> }> {
  // Build a map from model name/id to step name
  const modelToStep = new Map<string, string>();
  for (const step of job.steps) {
    if (step.task.isModelMethod()) {
      const task = step.task.data as { modelIdOrName: string };
      modelToStep.set(task.modelIdOrName, step.name);
    }
  }

  const nodes: GraphNode[] = [];
  const implicitDepsMap = new Map<string, string[]>();

  for (const step of job.steps) {
    const explicitDeps = step.getDependencyNames();
    const implicitDeps: string[] = [];

    // Check for implicit dependencies from expressions
    if (step.task.isModelMethod()) {
      const task = step.task.data as { modelIdOrName: string };

      // Look up the model definition to check for expressions
      const lookupResult = await findDefinitionByIdOrName(
        definitionRepo,
        task.modelIdOrName,
      );
      if (lookupResult) {
        const definitionData = lookupResult.definition.toData();
        const expressions = extractExpressions(definitionData);

        // Extract resource dependencies from expressions
        for (const expr of expressions) {
          const resourceRefs = extractResourceDependencies(
            expr.celExpression,
          );
          for (const modelRef of resourceRefs) {
            const dependsOnStep = modelToStep.get(modelRef);
            if (dependsOnStep && dependsOnStep !== step.name) {
              if (
                !explicitDeps.includes(dependsOnStep) &&
                !implicitDeps.includes(dependsOnStep)
              ) {
                implicitDeps.push(dependsOnStep);
              }
            }
          }

          // Extract file.contents() dependencies from expressions
          const fileContentsRefs = extractFileContentsDependencies(
            expr.celExpression,
          );
          for (const modelRef of fileContentsRefs) {
            const dependsOnStep = modelToStep.get(modelRef);
            if (dependsOnStep && dependsOnStep !== step.name) {
              if (
                !explicitDeps.includes(dependsOnStep) &&
                !implicitDeps.includes(dependsOnStep)
              ) {
                implicitDeps.push(dependsOnStep);
              }
            }
          }
        }
      }
    }

    // Also scan task.inputs for implicit dependencies
    const taskInputs = step.task.data.inputs;
    if (taskInputs) {
      const inputExpressions = extractExpressions(taskInputs);
      for (const expr of inputExpressions) {
        const resourceRefs = extractResourceDependencies(
          expr.celExpression,
        );
        for (const modelRef of resourceRefs) {
          const dependsOnStep = modelToStep.get(modelRef);
          if (dependsOnStep && dependsOnStep !== step.name) {
            if (
              !explicitDeps.includes(dependsOnStep) &&
              !implicitDeps.includes(dependsOnStep)
            ) {
              implicitDeps.push(dependsOnStep);
            }
          }
        }

        const fileContentsRefs = extractFileContentsDependencies(
          expr.celExpression,
        );
        for (const modelRef of fileContentsRefs) {
          const dependsOnStep = modelToStep.get(modelRef);
          if (dependsOnStep && dependsOnStep !== step.name) {
            if (
              !explicitDeps.includes(dependsOnStep) &&
              !implicitDeps.includes(dependsOnStep)
            ) {
              implicitDeps.push(dependsOnStep);
            }
          }
        }
      }
    }

    // Store implicit deps for this step
    if (implicitDeps.length > 0) {
      implicitDepsMap.set(step.name, implicitDeps);
    }

    nodes.push({
      name: step.name,
      weight: step.weight,
      dependencies: [...explicitDeps, ...implicitDeps],
    });
  }

  return { nodes, implicitDeps: implicitDepsMap };
}
