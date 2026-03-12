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
  renderWorkflowEvaluate,
  renderWorkflowEvaluateSingle,
  type WorkflowEvaluateData,
  type WorkflowEvaluateItemData,
} from "../../presentation/output/workflow_evaluate_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { parseInputs } from "../input_parser.ts";
import { InputValidationService } from "../../domain/inputs/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { containsRuntimeExpression } from "../../domain/expressions/expression_evaluation_service.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  extractExpressions,
  isTaskInputsPath,
  replaceExpressions,
} from "../../domain/expressions/expression_parser.ts";
import { hasStepOutputDependency } from "../../domain/expressions/dependency_extractor.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import { ModelResolver } from "../../domain/expressions/model_resolver.ts";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowEvaluateCommand = new Command()
  .name("evaluate")
  .description("Evaluate expressions in workflow definitions")
  .arguments("[workflow_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--all", "Evaluate all workflow definitions")
  .option("--input <value:string>", "Input values (key=value or JSON)", {
    collect: true,
  })
  .option("--input-file <file:string>", "Input values from YAML file")
  .action(
    async function (options: AnyOptions, workflowIdOrName?: string) {
      const ctx = createContext(options as GlobalOptions, [
        "workflow",
        "evaluate",
      ]);
      const { repoDir, repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });
      const workflowRepo = repoContext.workflowRepo;
      const definitionRepo = repoContext.definitionRepo;
      const dataRepo = repoContext.unifiedDataRepo;

      // Parse input values
      const { inputs } = await parseInputs({
        input: options.input as string[] | undefined,
        inputFile: options.inputFile as string | undefined,
      });

      const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
        repoDir,
      );
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
      });
      const celEvaluator = new CelEvaluator();

      // If --all flag or no argument, evaluate all workflows
      if (options.all || !workflowIdOrName) {
        ctx.logger.debug`Evaluating all workflow definitions`;

        const allWorkflows = await workflowRepo.findAll();
        const items: WorkflowEvaluateItemData[] = [];

        for (const workflow of allWorkflows) {
          const result = await evaluateWorkflow(
            workflow,
            inputs,
            modelResolver,
            celEvaluator,
            evaluatedWorkflowRepo,
          );
          items.push(result);
        }

        const data: WorkflowEvaluateData = {
          items,
          total: allWorkflows.length,
          evaluated: items.filter((i) => i.hadExpressions).length,
        };

        renderWorkflowEvaluate(data, ctx.outputMode);
        ctx.logger.debug`Evaluation completed`;
        return;
      }

      // Single workflow evaluation
      ctx.logger.debug`Evaluating workflow: ${workflowIdOrName}`;

      // Look up the workflow
      ctx.logger.debug`Looking up workflow: ${workflowIdOrName}`;
      const workflow = await workflowRepo.findByName(workflowIdOrName) ??
        await workflowRepo.findById(createWorkflowId(workflowIdOrName));

      if (!workflow) {
        throw new UserError(`Workflow not found: ${workflowIdOrName}`);
      }

      // Validate inputs against workflow schema if provided
      if (workflow.inputs && Object.keys(inputs).length > 0) {
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

      const item = await evaluateWorkflow(
        workflow,
        inputs,
        modelResolver,
        celEvaluator,
        evaluatedWorkflowRepo,
      );

      renderWorkflowEvaluateSingle(item, ctx.outputMode);
      ctx.logger.debug`Evaluation completed`;
    },
  );

/**
 * Evaluates a single workflow, replacing CEL expressions with values.
 * Vault expressions are left as-is for runtime resolution.
 * forEach-related expressions (self.* and forEach.in) are left raw for
 * runtime expansion.
 */
async function evaluateWorkflow(
  workflow: Workflow,
  inputs: Record<string, unknown>,
  modelResolver: ModelResolver,
  celEvaluator: CelEvaluator,
  evaluatedWorkflowRepo: YamlEvaluatedWorkflowRepository,
): Promise<WorkflowEvaluateItemData> {
  const workflowData = workflow.toData();
  const expressions = extractExpressions(workflowData);

  if (expressions.length === 0 && Object.keys(inputs).length === 0) {
    // No expressions and no inputs - still save for consistency
    await evaluatedWorkflowRepo.save(workflow);
    return {
      id: workflow.id,
      name: workflow.name,
      hadExpressions: false,
      outputPath: evaluatedWorkflowRepo.getPath(workflow.id),
    };
  }

  // Build expression context with inputs
  const context = await modelResolver.buildContext();
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
      const value = celEvaluator.evaluate(expr.celExpression, context);
      evaluatedValues.set(expr.raw, value);
    } catch (error) {
      // Skip expressions that fail to evaluate (might depend on runtime context)
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
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

      const items = celEvaluator.evaluate(inMatch[1], context);
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
            const value = celEvaluator.evaluate(nameMatch[1], stepContext);
            expandedName = stepData.name.replace(nameMatch[0], String(value));
          } else if (!nameHasExpression) {
            expandedName = `${stepData.name}-${String(item)}`;
          }

          const expandedTask = resolveForEachTaskExpressions(
            stepData.task,
            stepContext,
            celEvaluator,
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
            const evalValue = celEvaluator.evaluate(nameMatch[1], stepContext);
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
            celEvaluator,
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
  await evaluatedWorkflowRepo.save(workflowToSave);

  return {
    id: workflow.id,
    name: workflow.name,
    hadExpressions: evaluatedValues.size > 0 || forEachExpanded,
    forEachExpanded,
    outputPath: evaluatedWorkflowRepo.getPath(workflow.id),
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
  celEvaluator: CelEvaluator,
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
            expandedTask.inputs[key] = celEvaluator.evaluate(
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
            return String(celEvaluator.evaluate(expr, stepContext));
          } catch {
            return _match;
          }
        },
      );
    });
  }

  return expandedTask;
}
