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
import {
  TriggerCondition,
  type TriggerConditionData,
  TriggerConditionSchema,
} from "./trigger_condition.ts";
import { StepTask, StepTaskSchema } from "./step_task.ts";
import { DataOutputOverrideSchema } from "../models/data_output_override.ts";
import type { DataOutputOverride } from "../models/data_output_override.ts";
import {
  DriverConfigFieldSchema,
  DriverFieldSchema,
} from "../drivers/driver_config.ts";

/**
 * Schema for step dependency with condition.
 */
export const StepDependencySchema = z.object({
  step: z.string().min(1),
  condition: TriggerConditionSchema,
});

/**
 * Schema for forEach iteration.
 */
export const ForEachSchema = z.object({
  item: z.string().min(1), // Variable name (e.g., "env")
  in: z.string().min(1), // Expression (e.g., "${{ inputs.environments }}")
});

/**
 * Type representing step dependency data.
 */
export type StepDependencyData = z.infer<typeof StepDependencySchema>;

/**
 * Type representing forEach data.
 */
export type ForEachData = z.infer<typeof ForEachSchema>;

/**
 * Zod schema for Step entity.
 */
export const StepSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  task: StepTaskSchema,
  forEach: ForEachSchema.optional(),
  dependsOn: z.array(StepDependencySchema).default([]),
  weight: z.number().default(0),
  dataOutputOverrides: z.array(DataOutputOverrideSchema).optional(),
  allowFailure: z.boolean().default(false),
  driver: DriverFieldSchema,
  driverConfig: DriverConfigFieldSchema,
});

/**
 * Type representing step data (output — defaults applied).
 */
export type StepData = z.infer<typeof StepSchema>;

/**
 * Type representing step input data (defaults optional for backward compat).
 */
export type StepInput = z.input<typeof StepSchema>;

/**
 * Step dependency with resolved TriggerCondition.
 */
export interface StepDependency {
  step: string;
  condition: TriggerCondition;
}

/**
 * ForEach iteration configuration.
 */
export interface ForEach {
  item: string;
  in: string;
}

/**
 * Properties for creating a new Step.
 */
export interface CreateStepProps {
  name: string;
  description?: string;
  task: StepTask;
  forEach?: ForEach;
  dependsOn?: StepDependency[];
  weight?: number;
  dataOutputOverrides?: DataOutputOverride[];
  allowFailure?: boolean;
  driver?: string;
  driverConfig?: Record<string, unknown>;
}

/**
 * Step is an entity within a Job that represents a single unit of work.
 *
 * Each step has:
 * - A unique name (within the job)
 * - An optional description
 * - A task to execute (model method or shell command)
 * - Dependencies on other steps with trigger conditions
 * - A weight for deterministic topological sorting
 * - Optional data output overrides
 */
export class Step {
  private constructor(
    readonly name: string,
    readonly description: string | undefined,
    private _task: StepTask,
    readonly forEach: ForEach | undefined,
    private _dependsOn: StepDependency[],
    readonly weight: number,
    private _dataOutputOverrides: DataOutputOverride[],
    readonly allowFailure: boolean,
    readonly driver: string | undefined,
    readonly driverConfig: Record<string, unknown> | undefined,
  ) {}

  /**
   * Creates a new Step.
   */
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
      dataOutputOverrides: props.dataOutputOverrides,
      allowFailure: props.allowFailure ?? false,
      driver: props.driver,
      driverConfig: props.driverConfig,
    });

    return Step.fromData(data);
  }

  /**
   * Reconstructs a Step from persisted data.
   */
  static fromData(data: StepInput): Step {
    const validated = StepSchema.parse(data);
    const task = StepTask.fromData(validated.task);
    const dependsOn = validated.dependsOn.map((d) => ({
      step: d.step,
      condition: TriggerCondition.fromData(d.condition),
    }));

    // Convert persisted overrides to DataOutputOverride
    const dataOutputOverrides: DataOutputOverride[] =
      (validated.dataOutputOverrides ?? []).map((override) => ({
        specName: override.specName,
        lifetime: override.lifetime,
        garbageCollection: override.garbageCollection,
        tags: override.tags,
        vary: override.vary,
      }));

    // Convert forEach data to ForEach interface
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
      dataOutputOverrides,
      validated.allowFailure,
      validated.driver,
      validated.driverConfig,
    );
  }

  /**
   * Returns the task for this step.
   */
  get task(): StepTask {
    return this._task;
  }

  /**
   * Returns the dependencies for this step.
   */
  get dependsOn(): ReadonlyArray<StepDependency> {
    return this._dependsOn;
  }

  /**
   * Returns the data output overrides for this step.
   */
  get dataOutputOverrides(): ReadonlyArray<DataOutputOverride> {
    return this._dataOutputOverrides;
  }

  /**
   * Returns the names of all steps this step depends on.
   */
  getDependencyNames(): string[] {
    return this._dependsOn.map((d) => d.step);
  }

  /**
   * Converts to plain data for persistence.
   */
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
      dataOutputOverrides: this._dataOutputOverrides.length > 0
        ? this._dataOutputOverrides.map((override) => ({
          specName: override.specName,
          lifetime: override.lifetime,
          garbageCollection: override.garbageCollection,
          tags: override.tags,
          vary: override.vary,
        }))
        : undefined,
      allowFailure: this.allowFailure,
      driver: this.driver,
      driverConfig: this.driverConfig,
    };
  }
}
