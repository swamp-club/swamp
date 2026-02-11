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
import { createWorkflowId, type WorkflowId } from "./workflow_id.ts";
import { Job, type JobData, JobSchema } from "./job.ts";
import {
  type InputsSchema,
  InputsSchemaSchema,
} from "../definitions/definition.ts";

/**
 * Zod schema for Workflow aggregate root.
 */
export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  inputs: InputsSchemaSchema,
  jobs: z.array(JobSchema).min(1),
  version: z.number().int().positive().default(1),
});

/**
 * Type representing workflow data.
 */
export type WorkflowData = z.infer<typeof WorkflowSchema>;

/**
 * Properties for creating a new Workflow.
 */
export interface CreateWorkflowProps {
  id?: string;
  name: string;
  description?: string;
  inputs?: InputsSchema;
  jobs?: Job[];
  version?: number;
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
    readonly inputs: InputsSchema | undefined,
    private _jobs: Job[],
    readonly version: number,
  ) {}

  /**
   * Creates a new Workflow.
   */
  static create(props: CreateWorkflowProps): Workflow {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;
    const jobs = props.jobs ?? [];

    // Allow empty jobs for initial creation - will be validated later
    const data: WorkflowData = {
      id,
      name: props.name,
      description: props.description,
      inputs: props.inputs,
      jobs: jobs.map((j) => j.toData()),
      version,
    };

    // Only validate with schema if jobs exist
    if (jobs.length > 0) {
      WorkflowSchema.parse(data);
    }

    return new Workflow(
      createWorkflowId(data.id),
      data.name,
      data.description,
      data.inputs,
      jobs,
      data.version,
    );
  }

  /**
   * Reconstructs a Workflow from persisted data.
   */
  static fromData(data: WorkflowData): Workflow {
    const validated = WorkflowSchema.parse(data);
    const jobs = validated.jobs.map((j) => Job.fromData(j));

    return new Workflow(
      createWorkflowId(validated.id),
      validated.name,
      validated.description,
      validated.inputs,
      jobs,
      validated.version,
    );
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
      inputs: this.inputs,
      jobs: this._jobs.map((j) => j.toData()) as JobData[],
      version: this.version,
    };
  }
}
