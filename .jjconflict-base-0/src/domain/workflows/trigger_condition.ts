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
 * Base schema for trigger conditions (used for lazy evaluation).
 */
const baseTriggerConditionSchema: z.ZodType<TriggerConditionData> = z.lazy(
  () =>
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("always") }),
      z.object({ type: z.literal("succeeded") }),
      z.object({ type: z.literal("failed") }),
      z.object({ type: z.literal("completed") }),
      z.object({ type: z.literal("skipped") }),
      z.object({
        type: z.literal("and"),
        conditions: z.array(baseTriggerConditionSchema).min(2),
      }),
      z.object({
        type: z.literal("or"),
        conditions: z.array(baseTriggerConditionSchema).min(2),
      }),
      z.object({
        type: z.literal("not"),
        condition: baseTriggerConditionSchema,
      }),
    ]),
);

/**
 * Zod schema for trigger conditions.
 *
 * Supports:
 * - always: Always triggers
 * - succeeded: Triggers if the dependency succeeded
 * - failed: Triggers if the dependency failed
 * - completed: Triggers if the dependency completed (success or failure)
 * - skipped: Triggers if the dependency was skipped
 * - and(...): Boolean AND of multiple conditions
 * - or(...): Boolean OR of multiple conditions
 * - not(...): Boolean NOT of a condition
 *
 * The ref (which step/job to check) is provided by the parent dependency
 * object, not by the condition itself.
 */
export const TriggerConditionSchema = baseTriggerConditionSchema;

/**
 * Type representing trigger condition data.
 */
export type TriggerConditionData =
  | { type: "always" }
  | { type: "succeeded" }
  | { type: "failed" }
  | { type: "completed" }
  | { type: "skipped" }
  | { type: "and"; conditions: TriggerConditionData[] }
  | { type: "or"; conditions: TriggerConditionData[] }
  | { type: "not"; condition: TriggerConditionData };

/**
 * Status of a step or job run.
 */
export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

/**
 * Context for evaluating trigger conditions.
 */
export interface TriggerEvaluationContext {
  /**
   * Gets the status of a referenced step or job.
   */
  getStatus(ref: string): RunStatus | undefined;
}

/**
 * TriggerCondition is a value object representing a boolean expression
 * that determines when a job or step should execute.
 *
 * Immutable with equality based on value.
 */
export class TriggerCondition {
  private constructor(readonly data: TriggerConditionData) {}

  /**
   * Creates a TriggerCondition from raw data.
   */
  static fromData(data: TriggerConditionData): TriggerCondition {
    const validated = TriggerConditionSchema.parse(data);
    return new TriggerCondition(validated);
  }

  /**
   * Creates an "always" trigger condition.
   */
  static always(): TriggerCondition {
    return new TriggerCondition({ type: "always" });
  }

  /**
   * Creates a "succeeded" trigger condition.
   */
  static succeeded(): TriggerCondition {
    return new TriggerCondition({ type: "succeeded" });
  }

  /**
   * Creates a "failed" trigger condition.
   */
  static failed(): TriggerCondition {
    return new TriggerCondition({ type: "failed" });
  }

  /**
   * Creates a "completed" trigger condition.
   */
  static completed(): TriggerCondition {
    return new TriggerCondition({ type: "completed" });
  }

  /**
   * Creates a "skipped" trigger condition.
   */
  static skipped(): TriggerCondition {
    return new TriggerCondition({ type: "skipped" });
  }

  /**
   * Creates an "and" trigger condition.
   */
  static and(conditions: TriggerCondition[]): TriggerCondition {
    return new TriggerCondition({
      type: "and",
      conditions: conditions.map((c) => c.data),
    });
  }

  /**
   * Creates an "or" trigger condition.
   */
  static or(conditions: TriggerCondition[]): TriggerCondition {
    return new TriggerCondition({
      type: "or",
      conditions: conditions.map((c) => c.data),
    });
  }

  /**
   * Creates a "not" trigger condition.
   */
  static not(condition: TriggerCondition): TriggerCondition {
    return new TriggerCondition({
      type: "not",
      condition: condition.data,
    });
  }

  /**
   * Evaluates this trigger condition against the given context.
   *
   * @param ctx - The evaluation context that provides step/job statuses
   * @param ref - The step or job name whose status to check
   * @returns true if the condition is satisfied, false otherwise
   */
  evaluate(ctx: TriggerEvaluationContext, ref: string): boolean {
    return this.evaluateData(this.data, ctx, ref);
  }

  private evaluateData(
    data: TriggerConditionData,
    ctx: TriggerEvaluationContext,
    ref: string,
  ): boolean {
    switch (data.type) {
      case "always":
        return true;

      case "succeeded": {
        const status = ctx.getStatus(ref);
        return status === "succeeded";
      }

      case "failed": {
        const status = ctx.getStatus(ref);
        return status === "failed";
      }

      case "completed": {
        const status = ctx.getStatus(ref);
        return status === "succeeded" || status === "failed";
      }

      case "skipped": {
        const status = ctx.getStatus(ref);
        return status === "skipped";
      }

      case "and":
        return data.conditions.every((c) => this.evaluateData(c, ctx, ref));

      case "or":
        return data.conditions.some((c) => this.evaluateData(c, ctx, ref));

      case "not":
        return !this.evaluateData(data.condition, ctx, ref);
    }
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): TriggerConditionData {
    return structuredClone(this.data);
  }

  /**
   * Value equality comparison.
   */
  equals(other: TriggerCondition): boolean {
    return JSON.stringify(this.data) === JSON.stringify(other.data);
  }
}
