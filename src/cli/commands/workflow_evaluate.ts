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
import { containsVaultExpression } from "../../domain/expressions/expression_evaluation_service.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  extractExpressions,
  replaceExpressions,
} from "../../domain/expressions/expression_parser.ts";
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
  .option("--input <json:string>", "Input values as JSON")
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
        input: options.input as string | undefined,
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
        throw new Error(`Workflow not found: ${workflowIdOrName}`);
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
          throw new Error(`Input validation failed:\n${errorMessages}`);
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

  // Evaluate CEL-only expressions; skip vault-containing expressions
  const evaluatedValues = new Map<string, unknown>();
  for (const expr of expressions) {
    if (containsVaultExpression(expr.celExpression)) {
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

  // Save evaluated workflow
  await evaluatedWorkflowRepo.save(evaluatedWorkflow);

  return {
    id: workflow.id,
    name: workflow.name,
    hadExpressions: evaluatedValues.size > 0,
    outputPath: evaluatedWorkflowRepo.getPath(workflow.id),
    jobs: evaluatedWorkflow.toData().jobs,
  };
}
