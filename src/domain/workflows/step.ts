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
  TriggerCondition,
  type TriggerConditionData,
  TriggerConditionSchema,
} from "./trigger_condition.ts";
import { StepTask, StepTaskSchema } from "./step_task.ts";
import { DataOutputOverrideSchema } from "../models/data_output_override.ts";
import type { DataOutputOverride } from "../models/data_output_override.ts";
import { addRemovedDriverFieldIssues } from "../removed_driver_fields.ts";
import { rejectUnknownKeys } from "./unknown_keys.ts";
import { nodeName } from "./node_name.ts";
import {
  type PlacementFields,
  PlacementFieldsSchema,
  type ResolvedPlacement,
  resolvePlacement,
} from "./placement.ts";

export const StepDependencySchema = z.object({
  step: z.string().min(1),
  condition: TriggerConditionSchema,
});

export const ForEachSchema = z.object({
  item: z.string().min(1),
  in: z.string().min(1),
});

export type StepDependencyData = z.infer<typeof StepDependencySchema>;

export type ForEachData = z.infer<typeof ForEachSchema>;

const StepDependencyFieldSchema = z.array(StepDependencySchema).default([]);

export const StepObjectSchema = z.object({
  name: nodeName("Step"),
  description: z.string().optional(),
  task: StepTaskSchema,
  forEach: ForEachSchema.optional(),
  dependsOn: StepDependencyFieldSchema,
  weight: z.number().default(0),
  concurrency: z.number().int().nonnegative().optional(),
  dataOutputOverrides: z.array(DataOutputOverrideSchema).optional(),
  allowFailure: z.boolean().default(false),
  ...PlacementFieldsSchema.shape,
  guard: z.string().optional(),
  writes: z.boolean().optional(),
});

/**
 * one line, because schema errors escape control characters and a newline would
 * print as an escape
 */
function rejectStringStepDependsOn(
  data: unknown,
  ctx: z.RefinementCtx,
): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const raw = data as Record<string, unknown>;
    const deps = raw.dependsOn;
    if (Array.isArray(deps)) {
      const name = typeof raw.name === "string" ? raw.name : "<unnamed step>";
      deps.forEach((entry, index) => {
        if (typeof entry !== "string") return;
        ctx.addIssue({
          code: "custom",
          message: `Step "${name}": dependsOn entries must be objects, not ` +
            `strings. Replace "- ${entry}" with "- step: ${entry}" plus ` +
            `"condition: { type: succeeded }".`,
          path: ["dependsOn", index],
          input: data,
        });
      });
    }
  }
  return data;
}

/**
 * rejects unknown keys because Zod's silent stripping would discard a typo'd
 * placement key and run the step locally
 */
export const StepSchema = z.preprocess(
  addRemovedDriverFieldIssues,
  z.preprocess(
    rejectUnknownKeys("step", Object.keys(StepObjectSchema.shape)),
    z.preprocess(rejectStringStepDependsOn, StepObjectSchema),
  ),
);

export type StepData = z.infer<typeof StepObjectSchema>;

export type StepInput = z.input<typeof StepObjectSchema>;

export interface StepDependency {
  step: string;
  condition: TriggerCondition;
}

export interface ForEach {
  item: string;
  in: string;
}

export interface CreateStepProps {
  name: string;
  description?: string;
  task: StepTask;
  forEach?: ForEach;
  dependsOn?: StepDependency[];
  weight?: number;
  concurrency?: number;
  dataOutputOverrides?: DataOutputOverride[];
  allowFailure?: boolean;
  target?: string;
  labels?: Record<string, string>;
  platform?: string;
  queueTimeout?: number;
  guard?: string;
  writes?: boolean;
}

export class Step {
  private constructor(
    readonly name: string,
    readonly description: string | undefined,
    private _task: StepTask,
    readonly forEach: ForEach | undefined,
    private _dependsOn: StepDependency[],
    readonly weight: number,
    readonly concurrency: number | undefined,
    private _dataOutputOverrides: DataOutputOverride[],
    readonly allowFailure: boolean,
    readonly target: string | undefined,
    readonly labels: Record<string, string> | undefined,
    readonly platform: string | undefined,
    readonly queueTimeout: number | undefined,
    readonly guard: string | undefined,
    readonly writes: boolean | undefined,
  ) {}

  static create(props: CreateStepProps): Step {
    const data = StepSchema.parse({
      name: props.name,
      description: props.description,
      task: props.task.toData(),
      forEach: props.forEach,
      dependsOn: (props.dependsOn ?? []).map((d) => ({
        step: d.step,
        condition: d.condition.toData(),
      })),
      weight: props.weight ?? 0,
      concurrency: props.concurrency,
      dataOutputOverrides: props.dataOutputOverrides,
      allowFailure: props.allowFailure ?? false,
      target: props.target,
      labels: props.labels,
      platform: props.platform,
      queueTimeout: props.queueTimeout,
      guard: props.guard,
      writes: props.writes,
    });

    return Step.fromData(data);
  }

  static fromData(data: StepInput): Step {
    const validated = StepSchema.parse(data);
    const task = StepTask.fromData(validated.task);
    const dependsOn = validated.dependsOn.map((d) => ({
      step: d.step,
      condition: TriggerCondition.fromData(d.condition),
    }));

    const dataOutputOverrides: DataOutputOverride[] =
      (validated.dataOutputOverrides ?? []).map((override) => ({
        specName: override.specName,
        lifetime: override.lifetime,
        garbageCollection: override.garbageCollection,
        tags: override.tags,
        vary: override.vary,
        vaultName: override.vaultName,
      }));

    const forEach: ForEach | undefined = validated.forEach
      ? { item: validated.forEach.item, in: validated.forEach.in }
      : undefined;

    return new Step(
      validated.name,
      validated.description,
      task,
      forEach,
      dependsOn,
      validated.weight,
      validated.concurrency,
      dataOutputOverrides,
      validated.allowFailure,
      validated.target,
      validated.labels,
      validated.platform,
      validated.queueTimeout,
      validated.guard,
      validated.writes,
    );
  }

  get task(): StepTask {
    return this._task;
  }

  get dependsOn(): ReadonlyArray<StepDependency> {
    return this._dependsOn;
  }

  get dataOutputOverrides(): ReadonlyArray<DataOutputOverride> {
    return this._dataOutputOverrides;
  }

  getDependencyNames(): string[] {
    return this._dependsOn.map((d) => d.step);
  }

  toData(): StepData {
    return {
      name: this.name,
      description: this.description,
      task: this._task.toData(),
      forEach: this.forEach
        ? { item: this.forEach.item, in: this.forEach.in }
        : undefined,
      dependsOn: this._dependsOn.map((d) => ({
        step: d.step,
        condition: d.condition.toData() as TriggerConditionData,
      })),
      weight: this.weight,
      concurrency: this.concurrency,
      dataOutputOverrides: this._dataOutputOverrides.length > 0
        ? this._dataOutputOverrides.map((override) => ({
          specName: override.specName,
          lifetime: override.lifetime,
          garbageCollection: override.garbageCollection,
          tags: override.tags,
          vary: override.vary,
          vaultName: override.vaultName,
        }))
        : undefined,
      allowFailure: this.allowFailure,
      target: this.target,
      labels: this.labels,
      platform: this.platform,
      queueTimeout: this.queueTimeout,
      guard: this.guard,
      writes: this.writes,
    };
  }

  get placementFields(): PlacementFields {
    return {
      target: this.target,
      labels: this.labels,
      platform: this.platform,
      queueTimeout: this.queueTimeout,
    };
  }

  get placement(): ResolvedPlacement | undefined {
    return resolvePlacement(this.placementFields);
  }
}
