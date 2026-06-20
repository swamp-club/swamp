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
import { createWorkflowId, type WorkflowId } from "./workflow_id.ts";
import { Job, type JobData, JobSchema } from "./job.ts";
import {
  type InputsSchema,
  InputsSchemaSchema,
} from "../definitions/definition.ts";
import { rejectRemovedDriverFields } from "../removed_driver_fields.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import {
  type ReportSelection,
  ReportSelectionSchema,
} from "../reports/report_selection.ts";
import { Cron } from "croner";

const WorkflowObjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).refine(
    (name) => {
      if (name.includes("..") || name.includes("\\") || name.includes("\0")) {
        return false;
      }
      if (name.includes("/")) {
        // Allow '/' only in scoped @collective/name extension names
        return /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(name);
      }
      return true;
    },
    {
      message:
        "Workflow name must not contain '..', '\\', or null bytes (path traversal). '/' is only allowed in scoped @collective/name patterns.",
    },
  ),
  description: z.string().optional(),
  trigger: z.object({
    schedule: z.string().refine(
      (expr) => {
        try {
          const cron = new Cron(expr);
          cron.stop();
          return true;
        } catch {
          return false;
        }
      },
      { message: "Invalid cron expression" },
    ).optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
  tags: z.record(z.string(), z.string()).default({}),
  inputs: InputsSchemaSchema,
  jobs: z.array(JobSchema).min(1),
  version: z.number().int().positive().default(1),
  concurrency: z.number().int().nonnegative().optional(),
  reports: ReportSelectionSchema,
});

/**
 * Zod schema for Workflow aggregate root. Rejects the removed
 * `driver`/`driverConfig` fields with an actionable error (see
 * design/remote-execution.md).
 */
export const WorkflowSchema = z.preprocess(
  rejectRemovedDriverFields,
  WorkflowObjectSchema,
);

/**
 * Type representing workflow data (output — defaults applied).
 */
export type WorkflowData = z.infer<typeof WorkflowObjectSchema>;

/**
 * Type representing workflow input data (defaults optional for backward compat).
 */
export type WorkflowInput = z.input<typeof WorkflowObjectSchema>;

/**
 * Properties for creating a new Workflow.
 */
export interface CreateWorkflowProps {
  id?: string;
  name: string;
  description?: string;
  trigger?: { schedule?: string; inputs?: Record<string, unknown> };
  tags?: Record<string, string>;
  inputs?: InputsSchema;
  jobs?: Job[];
  version?: number;
  concurrency?: number;
  reports?: ReportSelection;
}

/**
 * Workflow is the aggregate root for workflow orchestration.
 *
 * Each workflow has:
 * - A unique ID (UUID)
 * - A globally unique name
 * - An optional description
 * - One or more jobs
 * - A version number
 */
export class Workflow {
  private constructor(
    readonly id: WorkflowId,
    readonly name: string,
    readonly description: string | undefined,
    readonly trigger:
      | { schedule?: string; inputs?: Record<string, unknown> }
      | undefined,
    readonly tags: Record<string, string>,
    readonly inputs: InputsSchema | undefined,
    private _jobs: Job[],
    readonly version: number,
    readonly concurrency: number | undefined,
    readonly reports: ReportSelection | undefined,
  ) {}

  /**
   * Creates a new Workflow.
   */
  static create(props: CreateWorkflowProps): Workflow {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;
    const jobs = props.jobs ?? [];
    const tags = props.tags ?? {};

    // Allow empty jobs for initial creation - will be validated later
    const data: WorkflowData = {
      id,
      name: props.name,
      description: props.description,
      trigger: props.trigger,
      tags,
      inputs: props.inputs,
      jobs: jobs.map((j) => j.toData()),
      version,
      concurrency: props.concurrency,
      reports: props.reports,
    };

    // Always validate the name (path traversal protection)
    WorkflowObjectSchema.shape.name.parse(data.name);

    // Only validate full schema if jobs exist (jobs.min(1) requires at least one)
    if (jobs.length > 0) {
      WorkflowSchema.parse(data);
    }

    return new Workflow(
      createWorkflowId(data.id),
      data.name,
      data.description,
      data.trigger,
      data.tags,
      data.inputs,
      jobs,
      data.version,
      data.concurrency,
      data.reports,
    );
  }

  /**
   * Reconstructs a Workflow from persisted data.
   */
  static fromData(data: WorkflowInput): Workflow {
    const validated = WorkflowSchema.parse(data);
    const jobs = validated.jobs.map((j) => Job.fromData(j));

    return new Workflow(
      createWorkflowId(validated.id),
      validated.name,
      validated.description,
      validated.trigger,
      validated.tags,
      validated.inputs,
      jobs,
      validated.version,
      validated.concurrency,
      validated.reports,
    );
  }

  /**
   * Returns the cron schedule expression, if configured.
   */
  get schedule(): string | undefined {
    return this.trigger?.schedule;
  }

  /**
   * Returns the baseline input values declared on the trigger, if any.
   * These are supplied by the trigger (e.g. scheduled or webhook runs), not
   * by an operator invoking the workflow manually.
   */
  get triggerInputs(): Record<string, unknown> | undefined {
    return this.trigger?.inputs;
  }

  /**
   * Computes the baseline inputs for a trigger-initiated run by layering
   * caller-supplied inputs over the trigger's declared inputs. Caller values
   * win on conflict (e.g. a webhook payload overrides a trigger default).
   * Schema defaults are applied later, downstream, for any keys still missing —
   * yielding precedence: caller inputs > trigger.inputs > schema defaults.
   */
  baselineInputs(
    callerInputs: Record<string, unknown>,
  ): Record<string, unknown> {
    return deepMerge(this.trigger?.inputs ?? {}, callerInputs);
  }

  /**
   * Returns the report selection (require/skip lists).
   */
  get reportSelection(): ReportSelection | undefined {
    return this.reports ? structuredClone(this.reports) : undefined;
  }

  /**
   * Returns the jobs for this workflow.
   */
  get jobs(): ReadonlyArray<Job> {
    return this._jobs;
  }

  /**
   * Finds a job by name.
   */
  getJob(name: string): Job | undefined {
    return this._jobs.find((j) => j.name === name);
  }

  /**
   * Adds a job to the workflow.
   */
  addJob(job: Job): void {
    if (this._jobs.some((j) => j.name === job.name)) {
      throw new Error(`Job with name '${job.name}' already exists`);
    }
    this._jobs.push(job);
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): WorkflowData {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      trigger: this.trigger,
      tags: this.tags,
      inputs: this.inputs,
      jobs: this._jobs.map((j) => j.toData()) as JobData[],
      version: this.version,
      concurrency: this.concurrency,
      reports: this.reports,
    };
  }
}
