import { Command } from "@cliffy/command";
import { z } from "zod";
import { WorkflowSchema } from "../../domain/workflows/workflow.ts";
import { JobDependencySchema, JobSchema } from "../../domain/workflows/job.ts";
import {
  StepDependencySchema,
  StepSchema,
} from "../../domain/workflows/step.ts";
import { StepTaskSchema } from "../../domain/workflows/step_task.ts";
import { TriggerConditionSchema } from "../../domain/workflows/trigger_condition.ts";
import { renderWorkflowSchema } from "../../presentation/output/workflow_schema_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Converts a Zod schema to JSON Schema format.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): object {
  return z.toJSONSchema(schema);
}

export const workflowSchemaGetCommand = new Command()
  .description("Get the schema for workflow files")
  .action(function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "workflow",
      "schema",
      "get",
    ]);

    const data = {
      workflow: zodToJsonSchema(WorkflowSchema),
      job: zodToJsonSchema(JobSchema),
      jobDependency: zodToJsonSchema(JobDependencySchema),
      step: zodToJsonSchema(StepSchema),
      stepDependency: zodToJsonSchema(StepDependencySchema),
      stepTask: zodToJsonSchema(StepTaskSchema),
      triggerCondition: zodToJsonSchema(TriggerConditionSchema),
    };

    renderWorkflowSchema(data, ctx.outputMode);
    ctx.logger.debug("Workflow schema get command completed");
  });

export const workflowSchemaCommand = new Command()
  .name("schema")
  .description("Workflow schema commands")
  .action(function () {
    this.showHelp();
  })
  .command("get", workflowSchemaGetCommand);
