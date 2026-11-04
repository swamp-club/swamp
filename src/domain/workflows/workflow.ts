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
import { addRemovedDriverFieldIssues } from "../removed_driver_fields.ts";
import { rejectUnknownKeys } from "./unknown_keys.ts";
import { fanOutJobRefusals } from "./fan_out_job.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import {
  type ReportSelection,
  ReportSelectionSchema,
} from "../reports/report_selection.ts";
import { Cron } from "croner";
import { type PlacementFields, PlacementFieldsSchema } from "./placement.ts";
import { WorkflowSchemaError } from "./workflow_schema_error.ts";
import {
  type ScheduleCatchUp,
  ScheduleCatchUpSchema,
} from "./schedule_catch_up.ts";

const WORKFLOW_NAME_MAX_LENGTH = 64;
const WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * legacy names that do not match the strict pattern fall back to UUID-based
 * filenames
 */
export function isFilenameSafeName(name: string): boolean {
  return (
    WORKFLOW_NAME_PATTERN.test(name) && name.length <= WORKFLOW_NAME_MAX_LENGTH
  );
}

export const workflowNameBase = z.string().min(1).refine(
  (name) => {
    if (name.includes("..") || name.includes("\\") || name.includes("\0")) {
      return false;
    }
    if (name.includes("/")) {
      return /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(name);
    }
    return true;
  },
  {
    message:
      "Workflow name must not contain '..', '\\', or null bytes (path traversal). '/' is only allowed in scoped @collective/name patterns.",
  },
);

const workflowNameStrict = workflowNameBase
  .refine(
    (name) => WORKFLOW_NAME_PATTERN.test(name),
    {
      message:
        "Workflow name must be lowercase alphanumeric with hyphens (e.g. 'deploy-pipeline'). Must start with a letter or number.",
    },
  )
  .refine(
    (name) => name.length <= WORKFLOW_NAME_MAX_LENGTH,
    {
      message:
        `Workflow name must be at most ${WORKFLOW_NAME_MAX_LENGTH} characters.`,
    },
  );

/**
 * mirrors Workflow.create, where scoped @collective/name names get the base
 * rules only, so callers can reject user input before the factory throws
 */
export function workflowNameViolation(name: string): string | undefined {
  const schema = name.includes("/") ? workflowNameBase : workflowNameStrict;
  const result = schema.safeParse(name);
  return result.success ? undefined : result.error.issues[0]?.message;
}

export const WorkflowObjectSchema = z.object({
  id: z.string().uuid(),
  name: workflowNameBase,
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
    catchUp: ScheduleCatchUpSchema.optional(),
  }).refine(
    (trigger) =>
      trigger.catchUp === undefined || trigger.schedule !== undefined,
    { message: "trigger.catchUp requires trigger.schedule", path: ["catchUp"] },
  ).optional(),
  tags: z.record(z.string(), z.string()).default({}),
  inputs: InputsSchemaSchema,
  jobs: z.array(JobSchema).min(1),
  version: z.number().int().positive().default(1),
  concurrency: z.number().int().nonnegative().optional(),
  reports: ReportSelectionSchema,
  affinity: z.boolean().optional(),
  writes: z.boolean().optional(),
  autoResume: z.boolean().optional(),
  /**
   * a run is refused every vault operation on a vault not listed, whoever
   * triggers it; nested workflows intersect their list with their parent's
   */
  vaults: z.array(z.string().min(1)).optional(),
  ...PlacementFieldsSchema.shape,
});

/**
 * rejects unknown keys because Zod's silent stripping would discard misplaced
 * or typo'd top-level keys
 */
export const WorkflowSchema = z.preprocess(
  addRemovedDriverFieldIssues,
  z.preprocess(
    rejectUnknownKeys("workflow", Object.keys(WorkflowObjectSchema.shape)),
    WorkflowObjectSchema,
  ),
).superRefine((workflow, ctx) => {
  for (const refusal of fanOutJobRefusals(workflow)) {
    ctx.addIssue({
      code: "custom",
      path: refusal.path,
      message: refusal.message,
    });
  }
});

export function workflowDeclaresInputs(
  inputs: InputsSchema | undefined,
): boolean {
  if (!inputs) return false;
  if (Object.keys(inputs.properties ?? {}).length > 0) return true;
  return inputs.additionalProperties !== undefined &&
    inputs.additionalProperties !== false;
}

export type WorkflowData = z.infer<typeof WorkflowObjectSchema>;

export type WorkflowInput = z.input<typeof WorkflowObjectSchema>;

export interface WorkflowTrigger {
  schedule?: string;
  inputs?: Record<string, unknown>;
  catchUp?: ScheduleCatchUp;
}

export interface CreateWorkflowProps {
  id?: string;
  name: string;
  description?: string;
  trigger?: WorkflowTrigger;
  tags?: Record<string, string>;
  inputs?: InputsSchema;
  jobs?: Job[];
  version?: number;
  concurrency?: number;
  reports?: ReportSelection;
  affinity?: boolean;
  writes?: boolean;
  target?: string;
  labels?: Record<string, string>;
  platform?: string;
  queueTimeout?: number;
  autoResume?: boolean;
  vaults?: string[];
}

export class Workflow {
  private constructor(
    readonly id: WorkflowId,
    readonly name: string,
    readonly description: string | undefined,
    readonly trigger: WorkflowTrigger | undefined,
    readonly tags: Record<string, string>,
    readonly inputs: InputsSchema | undefined,
    private _jobs: Job[],
    readonly version: number,
    readonly concurrency: number | undefined,
    readonly reports: ReportSelection | undefined,
    readonly affinity: boolean | undefined,
    readonly writes: boolean | undefined,
    readonly target: string | undefined,
    readonly labels: Record<string, string> | undefined,
    readonly platform: string | undefined,
    readonly queueTimeout: number | undefined,
    readonly autoResume: boolean | undefined,
    readonly vaults: readonly string[] | undefined,
  ) {}

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
      affinity: props.affinity,
      writes: props.writes,
      target: props.target,
      labels: props.labels,
      platform: props.platform,
      queueTimeout: props.queueTimeout,
      autoResume: props.autoResume,
      vaults: props.vaults,
    };

    // Scoped @collective/name is validated by workflowNameBase (in the schema);
    // unscoped names additionally enforce kebab-case and max length.
    if (data.name.includes("/")) {
      workflowNameBase.parse(data.name);
    } else {
      workflowNameStrict.parse(data.name);
    }

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
      data.affinity,
      data.writes,
      data.target,
      data.labels,
      data.platform,
      data.queueTimeout,
      data.autoResume,
      data.vaults,
    );
  }

  static fromData(data: WorkflowInput): Workflow {
    try {
      return Workflow.reconstitute(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw WorkflowSchemaError.fromZodError(error);
      }
      throw error;
    }
  }

  private static reconstitute(data: WorkflowInput): Workflow {
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
      validated.affinity,
      validated.writes,
      validated.target,
      validated.labels,
      validated.platform,
      validated.queueTimeout,
      validated.autoResume,
      validated.vaults,
    );
  }

  get schedule(): string | undefined {
    return this.trigger?.schedule;
  }

  get triggerInputs(): Record<string, unknown> | undefined {
    return this.trigger?.inputs;
  }

  get catchUp(): ScheduleCatchUp | undefined {
    return this.trigger?.catchUp;
  }

  /**
   * precedence is caller inputs, then trigger.inputs, then schema defaults
   * applied downstream; resolved trigger inputs replace the raw ones so the
   * rule stays in the aggregate
   */
  baselineInputs(
    callerInputs: Record<string, unknown>,
    resolvedTriggerInputs?: Record<string, unknown>,
  ): Record<string, unknown> {
    return deepMerge(
      resolvedTriggerInputs ?? this.trigger?.inputs ?? {},
      callerInputs,
    );
  }

  get reportSelection(): ReportSelection | undefined {
    return this.reports ? structuredClone(this.reports) : undefined;
  }

  get jobs(): ReadonlyArray<Job> {
    return this._jobs;
  }

  getJob(name: string): Job | undefined {
    return this._jobs.find((j) => j.name === name);
  }

  addJob(job: Job): void {
    if (this._jobs.some((j) => j.name === job.name)) {
      throw new Error(`Job with name '${job.name}' already exists`);
    }
    this._jobs.push(job);
  }

  /**
   * an explicit autoResume wins; the server default applies only to a workflow
   * with no inputs, since resume-time inputs are never declared separately and
   * a workflow with inputs must opt in itself
   */
  shouldAutoResume(serverDefault: boolean): boolean {
    if (this.autoResume !== undefined) return this.autoResume;
    return serverDefault && !workflowDeclaresInputs(this.inputs);
  }

  get placementFields(): PlacementFields {
    return {
      target: this.target,
      labels: this.labels,
      platform: this.platform,
      queueTimeout: this.queueTimeout,
    };
  }

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
      affinity: this.affinity,
      writes: this.writes,
      target: this.target,
      labels: this.labels,
      platform: this.platform,
      queueTimeout: this.queueTimeout,
      autoResume: this.autoResume,
      vaults: this.vaults !== undefined ? [...this.vaults] : undefined,
    };
  }
}
