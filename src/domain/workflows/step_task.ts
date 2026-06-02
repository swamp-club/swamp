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

import { z } from "zod";

/**
 * Raw schema for step tasks (without backward compat preprocessing).
 *
 * A task can be either:
 * - A model method invocation (`type: "model_method"`)
 * - A nested workflow invocation (`type: "workflow"`)
 */
const StepTaskRawSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("model_method"),
    modelIdOrName: z.string().min(1).optional(),
    modelType: z.string().min(1).optional(),
    modelName: z.string().min(1).optional(),
    methodName: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()).optional(),
    globalArgs: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("workflow"),
    workflowIdOrName: z.string().min(1),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("manual_approval"),
    prompt: z.string().min(1),
    timeout: z.number().positive().optional(),
  }),
]);

/**
 * Zod schema for step tasks with backward compatibility preprocessing.
 *
 * - `type: "shell"` throws an actionable error
 */
export const StepTaskSchema = z.preprocess((data) => {
  if (data && typeof data === "object" && "type" in data) {
    const d = data as Record<string, unknown>;
    if (d.type === "shell") {
      throw new Error(
        `Step task type "shell" is no longer supported. ` +
          `Use 'type: model_method' with the 'command/shell' model instead.\n\n` +
          `Example:\n` +
          `  task:\n` +
          `    type: model_method\n` +
          `    modelIdOrName: command/shell\n` +
          `    methodName: run\n` +
          `    inputs:\n` +
          `      command: "your-command-here"`,
      );
    }
    if ("arguments" in d && !("inputs" in d)) {
      throw new Error(
        `Unknown field "arguments" in step task. Did you mean "inputs"?\n\n` +
          `Example:\n` +
          `  task:\n` +
          `    type: model_method\n` +
          `    modelIdOrName: my-model\n` +
          `    methodName: run\n` +
          `    inputs:\n` +
          `      param: value`,
      );
    }
    if (d.type === "model_method") {
      const hasExisting = "modelIdOrName" in d && d.modelIdOrName;
      const hasDirect = "modelType" in d && d.modelType;
      if (hasExisting && hasDirect) {
        throw new Error(
          `Step task has both modelIdOrName and modelType. ` +
            `Use either modelIdOrName (existing definition) or modelType + modelName (direct type execution), not both.`,
        );
      }
      if (!hasExisting && !hasDirect) {
        throw new Error(
          `Step task requires either modelIdOrName or modelType + modelName.`,
        );
      }
      if (hasDirect && !("modelName" in d && d.modelName)) {
        throw new Error(
          `modelType requires modelName to name the auto-created definition.`,
        );
      }
      if ("globalArgs" in d && d.globalArgs && !hasDirect) {
        throw new Error(
          `globalArgs is only valid with direct type execution (modelType + modelName). ` +
            `For existing definitions, set global arguments in the definition YAML instead.`,
        );
      }
    }
  }
  return data;
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
