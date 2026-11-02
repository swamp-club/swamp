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

export const TriggerConditionSchema = baseTriggerConditionSchema;

export type TriggerConditionData =
  | { type: "always" }
  | { type: "succeeded" }
  | { type: "failed" }
  | { type: "completed" }
  | { type: "skipped" }
  | { type: "and"; conditions: TriggerConditionData[] }
  | { type: "or"; conditions: TriggerConditionData[] }
  | { type: "not"; condition: TriggerConditionData };

export type RunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "waiting"
  | "waiting_signal"
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown";

export function isUnfinishedStatus(status: unknown): boolean {
  return status === "pending" || status === "running" ||
    status === "waiting_approval" || status === "waiting" ||
    status === "waiting_signal";
}

export interface TriggerEvaluationContext {
  getStatus(ref: string): RunStatus | undefined;
}

export class TriggerCondition {
  private constructor(readonly data: TriggerConditionData) {}

  static fromData(data: TriggerConditionData): TriggerCondition {
    const validated = TriggerConditionSchema.parse(data);
    return new TriggerCondition(validated);
  }

  static always(): TriggerCondition {
    return new TriggerCondition({ type: "always" });
  }

  static succeeded(): TriggerCondition {
    return new TriggerCondition({ type: "succeeded" });
  }

  static failed(): TriggerCondition {
    return new TriggerCondition({ type: "failed" });
  }

  static completed(): TriggerCondition {
    return new TriggerCondition({ type: "completed" });
  }

  static skipped(): TriggerCondition {
    return new TriggerCondition({ type: "skipped" });
  }

  static and(conditions: TriggerCondition[]): TriggerCondition {
    return new TriggerCondition({
      type: "and",
      conditions: conditions.map((c) => c.data),
    });
  }

  static or(conditions: TriggerCondition[]): TriggerCondition {
    return new TriggerCondition({
      type: "or",
      conditions: conditions.map((c) => c.data),
    });
  }

  static not(condition: TriggerCondition): TriggerCondition {
    return new TriggerCondition({
      type: "not",
      condition: condition.data,
    });
  }

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

  toData(): TriggerConditionData {
    return structuredClone(this.data);
  }

  equals(other: TriggerCondition): boolean {
    return JSON.stringify(this.data) === JSON.stringify(other.data);
  }
}
