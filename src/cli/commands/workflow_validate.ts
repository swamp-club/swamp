import { Command } from "@cliffy/command";
import {
  renderWorkflowValidate,
  renderWorkflowValidateAll,
  type ValidationItemData,
  type WorkflowValidateData,
} from "../../presentation/output/workflow_validate_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import {
  DefaultWorkflowValidationService,
  type WorkflowValidationResult,
} from "../../domain/workflows/validation_service.ts";

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

/**
 * Converts WorkflowValidationResult array to ValidationItemData array for presentation.
 */
function toValidationItemData(
  results: WorkflowValidationResult[],
): ValidationItemData[] {
  return results.map((r) => ({
    name: r.name,
    passed: r.passed,
    error: r.error,
  }));
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const workflowValidateCommand = new Command()
  .name("validate")
  .description("Validate a workflow against its schema")
  .arguments("[workflow_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, workflowIdOrName?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "workflow",
      "validate",
    ]);
    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const repo = repoContext.workflowRepo;
    const validationService = new DefaultWorkflowValidationService();

    // If no argument provided, validate all workflows
    if (!workflowIdOrName) {
      ctx.logger.debug`Validating all workflows`;
      const allWorkflows = await repo.findAll();

      if (allWorkflows.length === 0) {
        throw new Error("No workflows found");
      }

      const results: WorkflowValidateData[] = [];
      for (const workflow of allWorkflows) {
        const validationResults = validationService.validate(workflow);
        const validations = toValidationItemData(validationResults);
        const allPassed = validationResults.every((r) => r.passed);

        results.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          validations,
          passed: allPassed,
        });
      }

      renderWorkflowValidateAll(results, ctx.outputMode);

      const anyFailed = results.some((r) => !r.passed);
      ctx.logger.debug`Validation completed, anyFailed=${anyFailed}`;

      if (anyFailed) {
        Deno.exit(1);
      }
      return;
    }

    // Single workflow validation
    ctx.logger.debug`Validating workflow: ${workflowIdOrName}`;

    // Look up the workflow
    let workflow: Workflow | null = null;

    if (isUuid(workflowIdOrName)) {
      ctx.logger.debug`Looking up by ID: ${workflowIdOrName}`;
      const id: WorkflowId = createWorkflowId(workflowIdOrName);
      workflow = await repo.findById(id);
    } else {
      ctx.logger.debug`Looking up by name: ${workflowIdOrName}`;
      workflow = await repo.findByName(workflowIdOrName);
    }

    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowIdOrName}`);
    }

    ctx.logger.debug`Found workflow: id=${workflow.id}, name=${workflow.name}`;

    // Run validations
    const results = validationService.validate(workflow);
    const validations = toValidationItemData(results);
    const allPassed = results.every((r) => r.passed);

    const data: WorkflowValidateData = {
      workflowId: workflow.id,
      workflowName: workflow.name,
      validations,
      passed: allPassed,
    };

    renderWorkflowValidate(data, ctx.outputMode);
    ctx.logger.debug`Validation completed, passed=${allPassed}`;

    // Exit with code 1 if any validation failed
    if (!allPassed) {
      Deno.exit(1);
    }
  });
