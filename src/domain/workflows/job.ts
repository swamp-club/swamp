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
import { Step, type StepData, StepSchema } from "./step.ts";
import { addRemovedDriverFieldIssues } from "../removed_driver_fields.ts";
import { rejectUnknownKeys } from "./unknown_keys.ts";
import { nodeName } from "./node_name.ts";
import { type PlacementFields, PlacementFieldsSchema } from "./placement.ts";

export const JobDependencySchema = z.object({
  job: z.string().min(1),
  condition: TriggerConditionSchema,
});

export type JobDependencyData = z.infer<typeof JobDependencySchema>;

const JobDependencyFieldSchema = z.array(JobDependencySchema).default([]);

export const JobObjectSchema = z.object({
  name: nodeName("Job"),
  description: z.string().optional(),
  steps: z.array(StepSchema).min(1),
  dependsOn: JobDependencyFieldSchema,
  weight: z.number().default(0),
  concurrency: z.number().int().nonnegative().optional(),
  affinity: z.boolean().optional(),
  writes: z.boolean().optional(),
  ...PlacementFieldsSchema.shape,
});

/**
 * the message is one line: schema errors escape control characters, so a
 * newline would print as an escape
 */
function rejectStringJobDependsOn(
  data: unknown,
  ctx: z.RefinementCtx,
): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const raw = data as Record<string, unknown>;
    const deps = raw.dependsOn;
    if (Array.isArray(deps)) {
      const name = typeof raw.name === "string" ? raw.name : "<unnamed job>";
      deps.forEach((entry, index) => {
        if (typeof entry !== "string") return;
        ctx.addIssue({
          code: "custom",
          message: `Job "${name}": dependsOn entries must be objects, not ` +
            `strings. Replace "- ${entry}" with "- job: ${entry}" plus ` +
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
 * rejects the removed driver/driverConfig fields with an actionable error, and
 * unknown keys with did-you-mean suggestions
 */
export const JobSchema = z.preprocess(
  addRemovedDriverFieldIssues,
  z.preprocess(
    rejectUnknownKeys("job", Object.keys(JobObjectSchema.shape)),
    z.preprocess(rejectStringJobDependsOn, JobObjectSchema),
  ),
);

export type JobData = z.infer<typeof JobObjectSchema>;

export type JobInput = z.input<typeof JobObjectSchema>;

export interface JobDependency {
  job: string;
  condition: TriggerCondition;
}

export interface CreateJobProps {
  name: string;
  description?: string;
  steps: Step[];
  dependsOn?: JobDependency[];
  weight?: number;
  concurrency?: number;
  affinity?: boolean;
  writes?: boolean;
  target?: string;
  labels?: Record<string, string>;
  platform?: string;
  queueTimeout?: number;
}

export class Job {
  private constructor(
    readonly name: string,
    readonly description: string | undefined,
    private _steps: Step[],
    private _dependsOn: JobDependency[],
    readonly weight: number,
    readonly concurrency: number | undefined,
    readonly affinity: boolean | undefined,
    readonly writes: boolean | undefined,
    readonly target: string | undefined,
    readonly labels: Record<string, string> | undefined,
    readonly platform: string | undefined,
    readonly queueTimeout: number | undefined,
  ) {}

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
      concurrency: props.concurrency,
      affinity: props.affinity,
      writes: props.writes,
      target: props.target,
      labels: props.labels,
      platform: props.platform,
      queueTimeout: props.queueTimeout,
    });

    return Job.fromData(data);
  }

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
      validated.concurrency,
      validated.affinity,
      validated.writes,
      validated.target,
      validated.labels,
      validated.platform,
      validated.queueTimeout,
    );
  }

  get steps(): ReadonlyArray<Step> {
    return this._steps;
  }

  get dependsOn(): ReadonlyArray<JobDependency> {
    return this._dependsOn;
  }

  getDependencyNames(): string[] {
    return this._dependsOn.map((d) => d.job);
  }

  getStep(name: string): Step | undefined {
    return this._steps.find((s) => s.name === name);
  }

  get placementFields(): PlacementFields {
    return {
      target: this.target,
      labels: this.labels,
      platform: this.platform,
      queueTimeout: this.queueTimeout,
    };
  }

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
      concurrency: this.concurrency,
      affinity: this.affinity,
      writes: this.writes,
      target: this.target,
      labels: this.labels,
      platform: this.platform,
      queueTimeout: this.queueTimeout,
    };
  }
}
