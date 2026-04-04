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

import type { JobData } from "../../domain/workflows/job.ts";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  extractExpressions,
  isTaskInputsPath,
  replaceExpressions,
} from "../../domain/expressions/expression_parser.ts";
import { containsRuntimeExpression } from "../../domain/expressions/expression_evaluation_service.ts";
import { hasStepOutputDependency } from "../../domain/expressions/dependency_extractor.ts";
import type { ExpressionContext } from "../../domain/expressions/model_resolver.ts";
import { ModelResolver } from "../../domain/expressions/model_resolver.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError } from "../errors.ts";

/** Evaluation result for a single workflow. */
export interface WorkflowEvaluateItemData {
  id: string;
  name: string;
  hadExpressions: boolean;
  forEachExpanded?: boolean;
  outputPath?: string;
  jobs?: JobData[];
}

/** Aggregate evaluation result for all workflows. */
export interface WorkflowEvaluateAllData {
  items: WorkflowEvaluateItemData[];
  total: number;
  evaluated: number;
}

export type WorkflowEvaluateEvent =
  | { kind: "evaluating" }
  | {
    kind: "completed";
    data: WorkflowEvaluateItemData | WorkflowEvaluateAllData;
  }
  | { kind: "error"; error: SwampError };

export interface WorkflowEvaluateInput {
  workflowIdOrName?: string;
  inputs: Record<string, unknown>;
}

/** Type guard to check if data is WorkflowEvaluateAllData. */
export function isWorkflowEvaluateAllData(
  data: WorkflowEvaluateItemData | WorkflowEvaluateAllData,
): data is WorkflowEvaluateAllData {
  return "items" in data;
}

/** Dependencies for the workflow evaluate operation. */
export interface WorkflowEvaluateDeps {
  findWorkflowById: (id: WorkflowId) => Promise<Workflow | null>;
  findWorkflowByName: (name: string) => Promise<Workflow | null>;
  findAllWorkflows: () => Promise<Workflow[]>;
  buildExpressionContext: () => Promise<ExpressionContext>;
  evaluateCel: (
    expression: string,
    context: Record<string, unknown>,
  ) => unknown;
  saveEvaluatedWorkflow: (workflow: Workflow) => Promise<void>;
  getEvaluatedPath: (id: WorkflowId) => string;
}

/** Wires real infrastructure into WorkflowEvaluateDeps. */
export function createWorkflowEvaluateDeps(
  repoDir: string,
  workflowRepo: WorkflowRepository,
  datastoreResolver?: DatastorePathResolver,
): WorkflowEvaluateDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
  );
  const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.workflowsEvaluated),
  );
  const modelResolver = new ModelResolver(definitionRepo, {
    repoDir,
    dataRepo,
  });
  const celEvaluator = new CelEvaluator();

  return {
    findWorkflowById: (id) => workflowRepo.findById(id),
    findWorkflowByName: (name) => workflowRepo.findByName(name),
    findAllWorkflows: () => workflowRepo.findAll(),
    buildExpressionContext: () => modelResolver.buildContext(),
    evaluateCel: (expression, context) =>
      celEvaluator.evaluate(expression, context),
    saveEvaluatedWorkflow: (workflow) => evaluatedWorkflowRepo.save(workflow),
    getEvaluatedPath: (id) => evaluatedWorkflowRepo.getPath(id),
  };
}

/**
 * Evaluates a single workflow, replacing CEL expressions with values.
 * Vault expressions are left as-is for runtime resolution.
 * forEach-related expressions (self.* and forEach.in) are left raw for
 * runtime expansion.
 */
async function evaluateWorkflowInternal(
  ctx: LibSwampContext,
  deps: WorkflowEvaluateDeps,
  workflow: Workflow,
  inputs: Record<string, unknown>,
): Promise<WorkflowEvaluateItemData> {
  const workflowData = workflow.toData();
  const expressions = extractExpressions(workflowData);

  if (expressions.length === 0 && Object.keys(inputs).length === 0) {
    // No expressions and no inputs - still save for consistency
    await deps.saveEvaluatedWorkflow(workflow);
    return {
      id: workflow.id,
      name: workflow.name,
      hadExpressions: false,
      outputPath: deps.getEvaluatedPath(workflow.id),
    };
  }

  // Build expression context with inputs
  const context = await deps.buildExpressionContext();
  context.inputs = inputs;

  // Collect forEach.in expressions to skip during evaluation
  const forEachInExpressions = new Set<string>();
  for (const job of workflow.jobs) {
    for (const step of job.steps) {
      if (step.forEach) {
        const match = step.forEach.in.match(/\$\{\{\s*(.+?)\s*\}\}/);
        if (match) {
          forEachInExpressions.add(step.forEach.in);
        }
      }
    }
  }

  // Evaluate CEL-only expressions; skip vault, self.*, and forEach.in expressions
  const evaluatedValues = new Map<string, unknown>();
  for (const expr of expressions) {
    if (containsRuntimeExpression(expr.celExpression)) {
      continue;
    }
    // Skip self.* expressions — they reference forEach variables resolved at runtime
    if (expr.celExpression.match(/\bself\./)) {
      continue;
    }
    // Skip forEach.in expressions — they must remain as strings for forEach expansion
    if (forEachInExpressions.has(expr.raw)) {
      continue;
    }
    // Skip task.inputs expressions that depend on step outputs (resource, file, execution, data, file.contents).
    // These are evaluated at step execution time when upstream step outputs are available.
    if (
      isTaskInputsPath(expr.path) &&
      hasStepOutputDependency(expr.celExpression)
    ) {
      continue;
    }

    try {
      const value = deps.evaluateCel(expr.celExpression, context);
      evaluatedValues.set(expr.raw, value);
    } catch (error) {
      // Skip expressions that fail to evaluate (might depend on runtime context)
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn(
        `Warning: Could not evaluate expression "${expr.raw}": ${message}`,
      );
    }
  }

  // Replace only CEL-only expressions with evaluated values
  const evaluatedData = replaceExpressions(workflowData, evaluatedValues);

  // Create new Workflow from evaluated data
  const evaluatedWorkflow = Workflow.fromData(evaluatedData as WorkflowData);

  // Expand forEach steps
  const expandedWorkflowData = evaluatedWorkflow.toData();
  for (const jobData of expandedWorkflowData.jobs) {
    const expandedSteps: typeof jobData.steps = [];

    for (const stepData of jobData.steps) {
      if (!stepData.forEach) {
        expandedSteps.push(stepData);
        continue;
      }

      // Evaluate the forEach.in expression
      const inMatch = stepData.forEach.in.match(/\$\{\{\s*(.+?)\s*\}\}/);
      if (!inMatch) {
        expandedSteps.push(stepData);
        continue;
      }

      const items = deps.evaluateCel(inMatch[1], context);
      const itemName = stepData.forEach.item;
      const nameHasExpression = /\$\{\{.+?\}\}/.test(stepData.name);

      if (Array.isArray(items)) {
        for (const item of items) {
          const stepContext = {
            ...context,
            self: { ...context.self, [itemName]: item },
          };

          // Resolve step name
          let expandedName = stepData.name;
          const nameMatch = stepData.name.match(/\$\{\{\s*(.+?)\s*\}\}/);
          if (nameMatch) {
            const value = deps.evaluateCel(nameMatch[1], stepContext);
            expandedName = stepData.name.replace(nameMatch[0], String(value));
          } else if (!nameHasExpression) {
            expandedName = `${stepData.name}-${String(item)}`;
          }

          const expandedTask = resolveForEachTaskExpressions(
            stepData.task,
            stepContext,
            deps,
          );

          expandedSteps.push({
            ...stepData,
            name: expandedName,
            task: expandedTask,
            forEach: undefined,
          });
        }
      } else if (items && typeof items === "object") {
        for (const [key, value] of Object.entries(items)) {
          const objItem = { key, value };
          const stepContext = {
            ...context,
            self: { ...context.self, [itemName]: objItem },
          };

          // Resolve step name
          let expandedName = stepData.name;
          const nameMatch = stepData.name.match(/\$\{\{\s*(.+?)\s*\}\}/);
          if (nameMatch) {
            const evalValue = deps.evaluateCel(nameMatch[1], stepContext);
            expandedName = stepData.name.replace(
              nameMatch[0],
              String(evalValue),
            );
          } else if (!nameHasExpression) {
            expandedName = `${stepData.name}-${key}`;
          }

          const expandedTask = resolveForEachTaskExpressions(
            stepData.task,
            stepContext,
            deps,
          );

          expandedSteps.push({
            ...stepData,
            name: expandedName,
            task: expandedTask,
            forEach: undefined,
          });
        }
      } else {
        // Not iterable — keep original step
        expandedSteps.push(stepData);
      }
    }

    jobData.steps = expandedSteps;
  }

  const forEachExpanded = expandedWorkflowData.jobs.some(
    (j) =>
      j.steps.length !==
        workflowData.jobs.find((wj) => wj.name === j.name)?.steps.length,
  );

  // Save the expanded workflow (forEach resolved, expressions evaluated)
  // so --last-evaluated can run without inputs or further expansion
  const workflowToSave = forEachExpanded
    ? Workflow.fromData(expandedWorkflowData as WorkflowData)
    : evaluatedWorkflow;
  await deps.saveEvaluatedWorkflow(workflowToSave);

  return {
    id: workflow.id,
    name: workflow.name,
    hadExpressions: evaluatedValues.size > 0 || forEachExpanded,
    forEachExpanded,
    outputPath: deps.getEvaluatedPath(workflow.id),
    jobs: expandedWorkflowData.jobs,
  };
}

/**
 * Resolves forEach self.* expressions in a task's inputs and args.
 * Vault expressions are left raw for runtime resolution.
 */
function resolveForEachTaskExpressions(
  // deno-lint-ignore no-explicit-any
  taskData: any,
  // deno-lint-ignore no-explicit-any
  stepContext: any,
  deps: Pick<WorkflowEvaluateDeps, "evaluateCel">,
  // deno-lint-ignore no-explicit-any
): any {
  const expandedTask = JSON.parse(JSON.stringify(taskData));

  // Resolve expressions in task inputs (model and workflow tasks)
  if (expandedTask.inputs) {
    for (const [key, val] of Object.entries(expandedTask.inputs)) {
      if (typeof val === "string") {
        const exprMatch = (val as string).match(/\$\{\{\s*(.+?)\s*\}\}/);
        if (exprMatch && !containsRuntimeExpression(exprMatch[1])) {
          try {
            expandedTask.inputs[key] = deps.evaluateCel(
              exprMatch[1],
              stepContext,
            );
          } catch {
            // Leave as-is if evaluation fails
          }
        }
      }
    }
  }

  // Resolve expressions in shell args
  if (expandedTask.args && Array.isArray(expandedTask.args)) {
    expandedTask.args = expandedTask.args.map((arg: unknown) => {
      if (typeof arg !== "string") return arg;
      return (arg as string).replace(
        /\$\{\{\s*(.+?)\s*\}\}/g,
        (_match: string, expr: string) => {
          if (containsRuntimeExpression(expr)) return _match;
          try {
            return String(deps.evaluateCel(expr, stepContext));
          } catch {
            return _match;
          }
        },
      );
    });
  }

  return expandedTask;
}

/** Evaluates all workflow definitions. */
async function* evaluateAll(
  ctx: LibSwampContext,
  deps: WorkflowEvaluateDeps,
  inputs: Record<string, unknown>,
): AsyncIterable<WorkflowEvaluateEvent> {
  const allWorkflows = await deps.findAllWorkflows();
  const items: WorkflowEvaluateItemData[] = [];

  for (const workflow of allWorkflows) {
    const result = await evaluateWorkflowInternal(
      ctx,
      deps,
      workflow,
      inputs,
    );
    items.push(result);
  }

  yield {
    kind: "completed",
    data: {
      items,
      total: allWorkflows.length,
      evaluated: items.filter((i) => i.hadExpressions).length,
    },
  };
}

/** Evaluates a single workflow definition. */
async function* evaluateSingle(
  ctx: LibSwampContext,
  deps: WorkflowEvaluateDeps,
  workflowIdOrName: string,
  inputs: Record<string, unknown>,
): AsyncIterable<WorkflowEvaluateEvent> {
  const workflow = await deps.findWorkflowByName(workflowIdOrName) ??
    await deps.findWorkflowById(createWorkflowId(workflowIdOrName));

  if (!workflow) {
    yield { kind: "error", error: notFound("Workflow", workflowIdOrName) };
    return;
  }

  const item = await evaluateWorkflowInternal(ctx, deps, workflow, inputs);

  yield { kind: "completed", data: item };
}

/** Evaluates workflow definitions, replacing CEL expressions with values. */
export async function* workflowEvaluate(
  ctx: LibSwampContext,
  deps: WorkflowEvaluateDeps,
  input: WorkflowEvaluateInput,
): AsyncIterable<WorkflowEvaluateEvent> {
  yield { kind: "evaluating" };

  if (!input.workflowIdOrName) {
    yield* evaluateAll(ctx, deps, input.inputs);
  } else {
    yield* evaluateSingle(ctx, deps, input.workflowIdOrName, input.inputs);
  }
}
