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

import { z } from "zod";
import {
  type InputsSchema,
  RequiredInputsSchemaSchema,
} from "../definitions/definition.ts";
import {
  isWaitKey,
  SIGNAL_ACCEPT_EARLY_MAX_SECONDS,
  SIGNAL_WAIT_MAX_TIMEOUT_SECONDS,
  SUPPORTED_WAIT_SCHEMA_KEYWORDS,
  unenforcedSchemaKeywords,
  WAIT_KEY_FORM,
} from "./signal_wait.ts";
import {
  BEHAVIOR_STEP_TASK_FIELDS,
  BEHAVIOR_STEP_TASK_TYPE,
  MODEL_STEP_TASK_TYPE,
} from "../terminology/behavior_aliases.ts";

const EXPRESSION_PATTERN = /^\$\{\{\s*.+?\s*\}\}\s*$/s;

const recordOrExpression = z.union([
  z.record(z.string(), z.unknown()),
  z.string().regex(EXPRESSION_PATTERN),
]).optional();

export const AssertSeveritySchema = z.enum(["low", "medium", "high"]);
export type AssertSeverity = z.infer<typeof AssertSeveritySchema>;

export const ModelMethodTaskRawSchema = z.object({
  type: z.literal("model_method"),
  modelIdOrName: z.string().min(1).optional(),
  modelType: z.string().min(1).optional(),
  modelName: z.string().min(1).optional(),
  methodName: z.string().min(1),
  inputs: recordOrExpression,
  globalArgs: recordOrExpression,
});

/**
 * documentation only: parsing never produces it, since normalizeBehaviorTask
 * rewrites a behavior-spelled task to model_method first
 */
export const BehaviorTaskDocSchema = z.object({
  type: z.literal("behavior"),
  behavior: z.string().min(1).optional(),
  behaviorType: z.string().min(1).optional(),
  behaviorName: z.string().min(1).optional(),
  methodName: z.string().min(1),
  inputs: recordOrExpression,
  globalArgs: recordOrExpression,
});

const StepTaskRawSchema = z.discriminatedUnion("type", [
  ModelMethodTaskRawSchema,
  z.object({
    type: z.literal("workflow"),
    workflowIdOrName: z.string().min(1),
    inputs: recordOrExpression,
  }),
  z.object({
    type: z.literal("manual_approval"),
    prompt: z.string().min(1),
    timeout: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal("assert"),
    expr: z.string().min(1),
    message: z.string().min(1),
    severity: AssertSeveritySchema.default("high"),
  }),
  z.object({
    type: z.literal("wait_for_signal"),
    // a wait never stays open forever, so the timeout is required and bounded
    timeout: z.number().positive().max(SIGNAL_WAIT_MAX_TIMEOUT_SECONDS),
    schema: RequiredInputsSchemaSchema,
    // a name at most one open wait of the workflow holds at a time; a literal,
    // it takes no expression
    key: z.string().refine(
      isWaitKey,
      `A wait_for_signal key must be ${WAIT_KEY_FORM}. It takes no expression.`,
    ).optional(),
    // bounded because the signal is held with no run behind it
    acceptEarly: z.number().positive().max(SIGNAL_ACCEPT_EARLY_MAX_SECONDS)
      .optional(),
  }),
]);

const MODEL_SPECIFIC_KEYS: readonly string[] = Object.values(
  BEHAVIOR_STEP_TASK_FIELDS,
);

function presentKeys(
  d: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  return keys.filter((key) => key in d && d[key] !== undefined);
}

/**
 * a task mixing the two spellings is refused since the task schema strips
 * unknown keys and a stray field would be silently dropped; key order is kept
 * so the written file matches the model spelling
 */
export function normalizeBehaviorTask(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const d = raw as Record<string, unknown>;
  // a model_method task is left as is: its schema has always dropped undeclared
  // keys, so a stray behavior key in an existing file keeps parsing; only the
  // new spelling refuses a mix
  if (d.type !== BEHAVIOR_STEP_TASK_TYPE) return raw;
  const refusal = behaviorTaskRefusal(d);
  if (refusal !== undefined) {
    throw new Error(refusal);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(d)) {
    if (key === "type") out.type = MODEL_STEP_TASK_TYPE;
    else if (key in BEHAVIOR_STEP_TASK_FIELDS) {
      out[BEHAVIOR_STEP_TASK_FIELDS[key]] = value;
    } else if (!MODEL_SPECIFIC_KEYS.includes(key)) out[key] = value;
  }
  return out;
}

function behaviorTaskRefusal(d: Record<string, unknown>): string | undefined {
  const stray = presentKeys(d, MODEL_SPECIFIC_KEYS);
  if (stray.length > 0) {
    return `A behavior step task cannot use ${stray.join(", ")}. ` +
      `Use behavior, or behaviorType + behaviorName, with type: behavior; ` +
      `or modelIdOrName, or modelType + modelName, with type: model_method.`;
  }
  const hasExisting = !!d.behavior;
  const hasDirect = !!d.behaviorType;
  if (hasExisting && hasDirect) {
    return `Step task has both behavior and behaviorType. ` +
      `Use either behavior (existing definition) or behaviorType + behaviorName (direct type execution), not both.`;
  }
  if (!hasExisting && !hasDirect) {
    return `Step task requires either behavior or behaviorType + behaviorName.`;
  }
  if (hasDirect && !d.behaviorName) {
    return `behaviorType requires behaviorName to name the auto-created definition.`;
  }
  if ("globalArgs" in d && d.globalArgs && !hasDirect) {
    return `globalArgs is only valid with direct type execution (behaviorType + behaviorName). ` +
      `For existing definitions, set global arguments in the definition YAML instead.`;
  }
  return undefined;
}

/**
 * each message is one line because schema errors escape control characters and
 * a newline would print as an escape
 */
function stepTaskRefusal(input: unknown): string | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const raw = input as Record<string, unknown>;
    if (raw.type === BEHAVIOR_STEP_TASK_TYPE) {
      const refusal = behaviorTaskRefusal(raw);
      if (refusal !== undefined) return refusal;
    }
  }
  const data = normalizeBehaviorTask(input);
  if (data && typeof data === "object" && "type" in data) {
    const d = data as Record<string, unknown>;
    if (d.type === "shell") {
      return `Step task type "shell" is no longer supported. ` +
        `Use 'type: model_method' with 'modelIdOrName: command/shell', ` +
        `'methodName: run' and the command under 'inputs.command' instead.`;
    }
    if ("arguments" in d && !("inputs" in d)) {
      return `Unknown field "arguments" in step task. Did you mean "inputs"? ` +
        `Put the method's arguments under 'inputs'.`;
    }
    if (d.type === "wait_for_signal") {
      // an early signal is addressed by key, so there is nothing to hold it
      // under without one
      if (d.acceptEarly !== undefined && d.key === undefined) {
        return `A wait_for_signal step that sets acceptEarly must declare a key: ` +
          `a signal that arrives before the wait opens is held under the key.`;
      }
      const schema = d.schema;
      // the flat bare-map form of an inputs schema is ambiguous with the
      // schema's own keywords for a wait, so the nested form is required
      if (
        schema && typeof schema === "object" && !Array.isArray(schema) &&
        (schema as Record<string, unknown>).type !== "object" &&
        !("properties" in schema)
      ) {
        return `A wait_for_signal schema must declare "type: object" or "properties". ` +
          `List the payload's fields under "properties", e.g. ` +
          `schema: { type: object, properties: { verdict: { type: string } } }.`;
      }
      // a signal comes from outside the workflow, so a keyword no payload is
      // checked against is refused, not silently ignored
      const unenforced = unenforcedSchemaKeywords(schema);
      if (unenforced.length > 0) {
        return `A wait_for_signal schema may only use keywords a payload is checked against. ` +
          `Not checked: ${unenforced.join("; ")}. ` +
          `Supported keywords: ${SUPPORTED_WAIT_SCHEMA_KEYWORDS.join(", ")}.`;
      }
    }
    if (d.type === "model_method") {
      const hasExisting = "modelIdOrName" in d && d.modelIdOrName;
      const hasDirect = "modelType" in d && d.modelType;
      if (hasExisting && hasDirect) {
        return `Step task has both modelIdOrName and modelType. ` +
          `Use either modelIdOrName (existing definition) or modelType + modelName (direct type execution), not both.`;
      }
      if (!hasExisting && !hasDirect) {
        return `Step task requires either modelIdOrName or modelType + modelName.`;
      }
      if (hasDirect && !("modelName" in d && d.modelName)) {
        return `modelType requires modelName to name the auto-created definition.`;
      }
      if ("globalArgs" in d && d.globalArgs && !hasDirect) {
        return `globalArgs is only valid with direct type execution (modelType + modelName). ` +
          `For existing definitions, set global arguments in the definition YAML instead.`;
      }
    }
  }
  return undefined;
}

export const StepTaskSchema = z.preprocess((input, ctx) => {
  const refusal = stepTaskRefusal(input);
  if (refusal !== undefined) {
    ctx.addIssue({ code: "custom", message: refusal, input });
    return input;
  }
  return normalizeBehaviorTask(input);
}, StepTaskRawSchema);

export type StepTaskData = z.infer<typeof StepTaskRawSchema>;

export class StepTask {
  private constructor(readonly data: StepTaskData) {}

  static fromData(data: StepTaskData): StepTask {
    const validated = StepTaskSchema.parse(data);
    return new StepTask(validated);
  }

  static modelMethod(
    modelIdOrName: string,
    methodName: string,
    inputs?: Record<string, unknown>,
  ): StepTask {
    return new StepTask({
      type: "model_method",
      modelIdOrName,
      methodName,
      inputs,
    });
  }

  static model(
    modelIdOrName: string,
    methodName: string,
    inputs?: Record<string, unknown>,
  ): StepTask {
    return StepTask.modelMethod(modelIdOrName, methodName, inputs);
  }

  static directExecution(
    modelType: string,
    modelName: string,
    methodName: string,
    inputs?: Record<string, unknown>,
    globalArgs?: Record<string, unknown>,
  ): StepTask {
    return new StepTask({
      type: "model_method",
      modelType,
      modelName,
      methodName,
      inputs,
      globalArgs,
    });
  }

  static workflow(
    workflowIdOrName: string,
    inputs?: Record<string, unknown>,
  ): StepTask {
    return new StepTask({
      type: "workflow",
      workflowIdOrName,
      inputs,
    });
  }

  static manualApproval(
    prompt: string,
    timeout?: number,
  ): StepTask {
    return new StepTask({
      type: "manual_approval",
      prompt,
      timeout,
    });
  }

  static assert(
    expr: string,
    message: string,
    severity: AssertSeverity = "high",
  ): StepTask {
    return new StepTask({
      type: "assert",
      expr,
      message,
      severity,
    });
  }

  static waitForSignal(
    timeout: number,
    schema: InputsSchema,
    key?: string,
    acceptEarly?: number,
  ): StepTask {
    // parsed so the schema's keys are in the order a loaded task has them and
    // equals() compares the two alike
    return StepTask.fromData({
      type: "wait_for_signal",
      timeout,
      schema,
      ...(key !== undefined ? { key } : {}),
      ...(acceptEarly !== undefined ? { acceptEarly } : {}),
    });
  }

  isModelMethod(): boolean {
    return this.data.type === "model_method";
  }

  isDirectExecution(): boolean {
    return this.data.type === "model_method" && "modelType" in this.data &&
      !!this.data.modelType;
  }

  isWorkflow(): boolean {
    return this.data.type === "workflow";
  }

  isManualApproval(): boolean {
    return this.data.type === "manual_approval";
  }

  isAssert(): boolean {
    return this.data.type === "assert";
  }

  isWaitForSignal(): boolean {
    return this.data.type === "wait_for_signal";
  }

  toData(): StepTaskData {
    return structuredClone(this.data);
  }

  equals(other: StepTask): boolean {
    return JSON.stringify(this.data) === JSON.stringify(other.data);
  }
}
