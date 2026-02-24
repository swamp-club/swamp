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
