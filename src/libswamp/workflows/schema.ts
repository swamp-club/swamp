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
import {
  BehaviorTaskDocSchema,
  StepTaskSchema,
} from "../../domain/workflows/step_task.ts";
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

function isTaskVariant(node: unknown, tag: string): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const props = (node as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return false;
  const type = (props as Record<string, unknown>).type;
  return !!type && typeof type === "object" &&
    (type as { const?: unknown }).const === tag;
}

/** The behavior step-task variant as a JSON Schema node. */
function behaviorTaskVariant(): Record<string, unknown> {
  const { $schema: _ignored, ...variant } = zodToJsonSchema(
    BehaviorTaskDocSchema,
  ) as Record<string, unknown>;
  return variant;
}

/**
 * A copy of `node` with the behavior step-task variant placed after every
 * `model_method` variant of a `oneOf`/`anyOf` list. JSON Schema generation
 * drops the task schema's preprocess, which is what accepts the behavior
 * spelling (swamp-club#3334), so the variant is added here.
 */
function withBehaviorTaskVariant(
  node: unknown,
  variant: Record<string, unknown>,
): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => withBehaviorTaskVariant(n, variant));
  }
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
      out[key] = value.flatMap((v) =>
        isTaskVariant(v, "model_method")
          ? [withBehaviorTaskVariant(v, variant), structuredClone(variant)]
          : [withBehaviorTaskVariant(v, variant)]
      );
    } else {
      out[key] = withBehaviorTaskVariant(value, variant);
    }
  }
  return out;
}

/** The JSON Schema of a workflow schema that holds step tasks. */
function taskHoldingSchema(
  schema: Parameters<typeof zodToJsonSchema>[0],
  variant: Record<string, unknown>,
): object {
  return withBehaviorTaskVariant(zodToJsonSchema(schema), variant) as object;
}

/** Yields the JSON Schema representation of all workflow schemas. */
export async function* workflowSchema(
  _ctx: LibSwampContext,
): AsyncIterable<WorkflowSchemaEvent> {
  yield* withGeneratorSpan(
    "swamp.workflow.schema",
    {},
    (async function* () {
      const behavior = behaviorTaskVariant();
      yield {
        kind: "completed",
        data: {
          workflow: taskHoldingSchema(WorkflowSchema, behavior),
          job: taskHoldingSchema(JobSchema, behavior),
          jobDependency: zodToJsonSchema(JobDependencySchema),
          step: taskHoldingSchema(StepSchema, behavior),
          stepDependency: zodToJsonSchema(StepDependencySchema),
          stepTask: taskHoldingSchema(StepTaskSchema, behavior),
          triggerCondition: zodToJsonSchema(TriggerConditionSchema),
        },
      };
    })(),
  );
}
