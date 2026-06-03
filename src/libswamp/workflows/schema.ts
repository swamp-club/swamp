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

import { WorkflowSchema } from "../../domain/workflows/workflow.ts";
import { JobDependencySchema, JobSchema } from "../../domain/workflows/job.ts";
import {
  StepDependencySchema,
  StepSchema,
} from "../../domain/workflows/step.ts";
import { StepTaskSchema } from "../../domain/workflows/step_task.ts";
import { TriggerConditionSchema } from "../../domain/workflows/trigger_condition.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { zodToJsonSchema } from "../types/schema_helpers.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Schema data for all workflow-related Zod schemas. */
export interface WorkflowSchemaData {
  workflow: object;
  job: object;
  jobDependency: object;
  step: object;
  stepDependency: object;
  stepTask: object;
  triggerCondition: object;
}

export type WorkflowSchemaEvent =
  | { kind: "completed"; data: WorkflowSchemaData }
  | { kind: "error"; error: SwampError };

/** Yields the JSON Schema representation of all workflow schemas. */
export async function* workflowSchema(
  _ctx: LibSwampContext,
): AsyncIterable<WorkflowSchemaEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.schema",
    {},
    (async function* () {
      yield {
        kind: "completed",
        data: {
          workflow: zodToJsonSchema(WorkflowSchema),
          job: zodToJsonSchema(JobSchema),
          jobDependency: zodToJsonSchema(JobDependencySchema),
          step: zodToJsonSchema(StepSchema),
          stepDependency: zodToJsonSchema(StepDependencySchema),
          stepTask: zodToJsonSchema(StepTaskSchema),
          triggerCondition: zodToJsonSchema(TriggerConditionSchema),
        },
      };
    })(),
  );
}
