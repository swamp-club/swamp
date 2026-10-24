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

/** The `model_method` step task, as stored. */
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
 * The behavior spelling of the `model_method` step task (swamp-club#3334),
 * for documentation only: `swamp workflow schema` lists it beside the
 * `model_method` variant. Parsing never produces it —
 * {@link normalizeBehaviorTask} rewrites a behavior-spelled task to
 * `model_method` before the task schema sees it.
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

/**
 * Raw schema for step tasks (without backward compat preprocessing).
 *
 * A task can be either:
 * - A model method invocation (`type: "model_method"`)
 * - A nested workflow invocation (`type: "workflow"`)
 * - A manual approval gate (`type: "manual_approval"`)
 * - A CEL predicate assertion (`type: "assert"`)
 * - A wait for a JSON signal (`type: "wait_for_signal"`)
 */
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
    // Seconds the wait stays open. Required and bounded: a wait never stays
    // open forever.
    timeout: z.number().positive().max(SIGNAL_WAIT_MAX_TIMEOUT_SECONDS),
    // The payload schema, in the same form as workflow `inputs`.
    schema: RequiredInputsSchemaSchema,
    // A name at most one open wait of the workflow holds at a time
    // (swamp-club#3209). A literal: it takes no expression.
    key: z.string().refine(
      isWaitKey,
      `A wait_for_signal key must be ${WAIT_KEY_FORM}. It takes no expression.`,
    ).optional(),
    // Seconds a signal by key may arrive before the wait opens
    // (swamp-club#3212). Bounded: the signal is held with no run behind it.
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
 * Rewrites a behavior-spelled step task to its stored `model_method` form
 * (swamp-club#3334): `type: behavior` becomes `type: model_method`, and
 * `behavior`, `behaviorType` and `behaviorName` become `modelIdOrName`,
 * `modelType` and `modelName`. Key order is kept, so the parsed task, and the
 * file swamp writes back, are the same as for the model spelling.
 *
 * A task that mixes the two spellings is refused: the task schema strips
 * unknown keys, so a stray field would otherwise be silently dropped. The
 * reference checks are run here in the behavior spelling so their errors use
 * the words the author wrote. Any other value is returned unchanged.
 */
export function normalizeBehaviorTask(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const d = raw as Record<string, unknown>;
  // A model_method task is left exactly as before: its object schema has
  // always dropped keys it does not declare, so a stray behavior key in an
  // existing file keeps parsing (no regression). Only the new spelling
  // refuses a mix.
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

/** Why a `type: behavior` task is refused, or undefined when it is not. */
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
 * Why a step task is refused, or undefined when it is not. Each message is
 * one line: schema errors escape control characters, so a newline would
 * print as an escape (swamp-club#3832).
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
      // An early signal is addressed by key, so there is nothing to hold it
      // under without one.
      if (d.acceptEarly !== undefined && d.key === undefined) {
        return `A wait_for_signal step that sets acceptEarly must declare a key: ` +
          `a signal that arrives before the wait opens is held under the key.`;
      }
      const schema = d.schema;
      // An inputs schema may be written flat, as a bare map of properties.
      // For a wait that form is ambiguous with the schema's own keywords, so
      // the nested form is required.
      if (
        schema && typeof schema === "object" && !Array.isArray(schema) &&
        (schema as Record<string, unknown>).type !== "object" &&
        !("properties" in schema)
      ) {
        return `A wait_for_signal schema must declare "type: object" or "properties". ` +
          `List the payload's fields under "properties", e.g. ` +
          `schema: { type: object, properties: { verdict: { type: string } } }.`;
      }
      // A signal comes from outside the workflow, so a schema keyword that
      // no payload is checked against is refused, not silently ignored.
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

/**
 * Zod schema for step tasks with backward compatibility preprocessing.
 *
 * - The behavior spelling is rewritten to `model_method` first
 *   ({@link normalizeBehaviorTask}), so every consumer sees one form
 * - A refused task (e.g. `type: "shell"`) is reported as a schema issue with
 *   an actionable message
 */
export const StepTaskSchema = z.preprocess((input, ctx) => {
  const refusal = stepTaskRefusal(input);
  if (refusal !== undefined) {
    ctx.addIssue({ code: "custom", message: refusal, input });
    return input;
  }
  return normalizeBehaviorTask(input);
}, StepTaskRawSchema);

/**
 * Type representing step task data.
 */
export type StepTaskData = z.infer<typeof StepTaskRawSchema>;

/**
 * StepTask is a value object representing the work to be performed by a step.
 *
 * Immutable with equality based on value.
 */
export class StepTask {
  private constructor(readonly data: StepTaskData) {}

  /**
   * Creates a StepTask from raw data.
   */
  static fromData(data: StepTaskData): StepTask {
    const validated = StepTaskSchema.parse(data);
    return new StepTask(validated);
  }

  /**
   * Creates a model method task.
   */
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

  /**
   * Alias for modelMethod() - shorter convenience factory.
   */
  static model(
    modelIdOrName: string,
    methodName: string,
    inputs?: Record<string, unknown>,
  ): StepTask {
    return StepTask.modelMethod(modelIdOrName, methodName, inputs);
  }

  /**
   * Creates a direct type execution task.
   */
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

  /**
   * Creates a workflow invocation task.
   */
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

  /**
   * Creates a manual approval task.
   */
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

  /**
   * Creates an assert task.
   */
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

  /**
   * Creates a wait for signal task.
   */
  static waitForSignal(
    timeout: number,
    schema: InputsSchema,
    key?: string,
    acceptEarly?: number,
  ): StepTask {
    // Parsed, so the schema's keys are in the order a loaded task has them
    // and equals() compares the two alike.
    return StepTask.fromData({
      type: "wait_for_signal",
      timeout,
      schema,
      ...(key !== undefined ? { key } : {}),
      ...(acceptEarly !== undefined ? { acceptEarly } : {}),
    });
  }

  /**
   * Returns true if this is a model method task.
   */
  isModelMethod(): boolean {
    return this.data.type === "model_method";
  }

  /**
   * Returns true if this is a direct type execution task (modelType + modelName).
   */
  isDirectExecution(): boolean {
    return this.data.type === "model_method" && "modelType" in this.data &&
      !!this.data.modelType;
  }

  /**
   * Returns true if this is a workflow invocation task.
   */
  isWorkflow(): boolean {
    return this.data.type === "workflow";
  }

  /**
   * Returns true if this is a manual approval task.
   */
  isManualApproval(): boolean {
    return this.data.type === "manual_approval";
  }

  /**
   * Returns true if this is an assert task.
   */
  isAssert(): boolean {
    return this.data.type === "assert";
  }

  /**
   * Returns true if this is a wait for signal task.
   */
  isWaitForSignal(): boolean {
    return this.data.type === "wait_for_signal";
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): StepTaskData {
    return structuredClone(this.data);
  }

  /**
   * Value equality comparison.
   */
  equals(other: StepTask): boolean {
    return JSON.stringify(this.data) === JSON.stringify(other.data);
  }
}
