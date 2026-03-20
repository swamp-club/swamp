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
import { Step, type StepData, StepSchema } from "./step.ts";
import {
  DriverConfigFieldSchema,
  DriverFieldSchema,
} from "../drivers/driver_config.ts";

/**
 * Schema for job dependency with condition.
 */
export const JobDependencySchema = z.object({
  job: z.string().min(1),
  condition: TriggerConditionSchema,
});

/**
 * Type representing job dependency data.
 */
export type JobDependencyData = z.infer<typeof JobDependencySchema>;

/**
 * Zod schema for Job entity.
 */
export const JobSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(StepSchema).min(1),
  dependsOn: z.array(JobDependencySchema).default([]),
  weight: z.number().default(0),
  driver: DriverFieldSchema,
  driverConfig: DriverConfigFieldSchema,
});

/**
 * Type representing job data (output — defaults applied).
 */
export type JobData = z.infer<typeof JobSchema>;

/**
 * Type representing job input data (defaults optional for backward compat).
 */
export type JobInput = z.input<typeof JobSchema>;

/**
 * Job dependency with resolved TriggerCondition.
 */
export interface JobDependency {
  job: string;
  condition: TriggerCondition;
}

/**
 * Properties for creating a new Job.
 */
export interface CreateJobProps {
  name: string;
  description?: string;
  steps: Step[];
  dependsOn?: JobDependency[];
  weight?: number;
  driver?: string;
  driverConfig?: Record<string, unknown>;
}

/**
 * Job is an entity within a Workflow that groups related steps.
 *
 * Each job has:
 * - A unique name (within the workflow)
 * - An optional description
 * - One or more steps to execute
 * - Dependencies on other jobs with trigger conditions
 * - A weight for deterministic topological sorting
 */
export class Job {
  private constructor(
    readonly name: string,
    readonly description: string | undefined,
    private _steps: Step[],
    private _dependsOn: JobDependency[],
    readonly weight: number,
    readonly driver: string | undefined,
    readonly driverConfig: Record<string, unknown> | undefined,
  ) {}

  /**
   * Creates a new Job.
   */
  static create(props: CreateJobProps): Job {
    if (props.steps.length === 0) {
      throw new Error("Job must have at least one step");
    }

    const data = JobSchema.parse({
      name: props.name,
      description: props.description,
      steps: props.steps.map((s) => s.toData()),
      dependsOn: (props.dependsOn ?? []).map((d) => ({
        job: d.job,
        condition: d.condition.toData(),
      })),
      weight: props.weight ?? 0,
      driver: props.driver,
      driverConfig: props.driverConfig,
    });

    return Job.fromData(data);
  }

  /**
   * Reconstructs a Job from persisted data.
   */
  static fromData(data: JobInput): Job {
    const validated = JobSchema.parse(data);
    const steps = validated.steps.map((s) => Step.fromData(s));
    const dependsOn = validated.dependsOn.map((d) => ({
      job: d.job,
      condition: TriggerCondition.fromData(d.condition),
    }));

    return new Job(
      validated.name,
      validated.description,
      steps,
      dependsOn,
      validated.weight,
      validated.driver,
      validated.driverConfig,
    );
  }

  /**
   * Returns the steps for this job.
   */
  get steps(): ReadonlyArray<Step> {
    return this._steps;
  }

  /**
   * Returns the dependencies for this job.
   */
  get dependsOn(): ReadonlyArray<JobDependency> {
    return this._dependsOn;
  }

  /**
   * Returns the names of all jobs this job depends on.
   */
  getDependencyNames(): string[] {
    return this._dependsOn.map((d) => d.job);
  }

  /**
   * Finds a step by name.
   */
  getStep(name: string): Step | undefined {
    return this._steps.find((s) => s.name === name);
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): JobData {
    return {
      name: this.name,
      description: this.description,
      steps: this._steps.map((s) => s.toData()) as StepData[],
      dependsOn: this._dependsOn.map((d) => ({
        job: d.job,
        condition: d.condition.toData() as TriggerConditionData,
      })),
      weight: this.weight,
      driver: this.driver,
      driverConfig: this.driverConfig,
    };
  }
}
