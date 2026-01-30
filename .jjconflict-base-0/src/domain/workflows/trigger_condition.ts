import { z } from "zod";

/**
 * Base schema for trigger conditions (used for lazy evaluation).
 */
const baseTriggerConditionSchema: z.ZodType<TriggerConditionData> = z.lazy(
  () =>
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("always") }),
      z.object({ type: z.literal("succeeded"), ref: z.string().min(1) }),
      z.object({ type: z.literal("failed"), ref: z.string().min(1) }),
      z.object({ type: z.literal("completed"), ref: z.string().min(1) }),
      z.object({ type: z.literal("skipped"), ref: z.string().min(1) }),
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
 * - succeeded(ref): Triggers if referenced step/job succeeded
 * - failed(ref): Triggers if referenced step/job failed
 * - completed(ref): Triggers if referenced step/job completed (success or failure)
 * - skipped(ref): Triggers if referenced step/job was skipped
 * - and(...): Boolean AND of multiple conditions
 * - or(...): Boolean OR of multiple conditions
 * - not(...): Boolean NOT of a condition
 */
export const TriggerConditionSchema = baseTriggerConditionSchema;

/**
 * Type representing trigger condition data.
 */
export type TriggerConditionData =
  | { type: "always" }
  | { type: "succeeded"; ref: string }
  | { type: "failed"; ref: string }
  | { type: "completed"; ref: string }
  | { type: "skipped"; ref: string }
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
  static succeeded(ref: string): TriggerCondition {
    return new TriggerCondition({ type: "succeeded", ref });
  }

  /**
   * Creates a "failed" trigger condition.
   */
  static failed(ref: string): TriggerCondition {
    return new TriggerCondition({ type: "failed", ref });
  }

  /**
   * Creates a "completed" trigger condition.
   */
  static completed(ref: string): TriggerCondition {
    return new TriggerCondition({ type: "completed", ref });
  }

  /**
   * Creates a "skipped" trigger condition.
   */
  static skipped(ref: string): TriggerCondition {
    return new TriggerCondition({ type: "skipped", ref });
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
   * @returns true if the condition is satisfied, false otherwise
   */
  evaluate(ctx: TriggerEvaluationContext): boolean {
    return this.evaluateData(this.data, ctx);
  }

  private evaluateData(
    data: TriggerConditionData,
    ctx: TriggerEvaluationContext,
  ): boolean {
    switch (data.type) {
      case "always":
        return true;

      case "succeeded": {
        const status = ctx.getStatus(data.ref);
        return status === "succeeded";
      }

      case "failed": {
        const status = ctx.getStatus(data.ref);
        return status === "failed";
      }

      case "completed": {
        const status = ctx.getStatus(data.ref);
        return status === "succeeded" || status === "failed";
      }

      case "skipped": {
        const status = ctx.getStatus(data.ref);
        return status === "skipped";
      }

      case "and":
        return data.conditions.every((c) => this.evaluateData(c, ctx));

      case "or":
        return data.conditions.some((c) => this.evaluateData(c, ctx));

      case "not":
        return !this.evaluateData(data.condition, ctx);
    }
  }

  /**
   * Extracts all referenced step/job names from this condition.
   */
  getRefs(): string[] {
    return this.getRefsFromData(this.data);
  }

  private getRefsFromData(data: TriggerConditionData): string[] {
    switch (data.type) {
      case "always":
        return [];

      case "succeeded":
      case "failed":
      case "completed":
      case "skipped":
        return [data.ref];

      case "and":
      case "or":
        return data.conditions.flatMap((c) => this.getRefsFromData(c));

      case "not":
        return this.getRefsFromData(data.condition);
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
