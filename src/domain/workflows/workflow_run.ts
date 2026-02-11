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
import { createWorkflowRunId, type WorkflowRunId } from "./workflow_id.ts";
import type {
  RunStatus,
  TriggerEvaluationContext,
} from "./trigger_condition.ts";
import type { Workflow } from "./workflow.ts";
import { DataArtifactRefSchema } from "../models/model_output.ts";
import type { DataArtifactRef } from "../models/model_output.ts";

/**
 * Zod schema for step run.
 */
export const StepRunSchema = z.object({
  stepName: z.string().min(1),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  output: z.unknown().optional(),
  dataArtifacts: z.array(DataArtifactRefSchema).optional(),
});

/**
 * Type representing step run data.
 */
export type StepRunData = z.infer<typeof StepRunSchema>;

/**
 * Zod schema for job run.
 */
export const JobRunSchema = z.object({
  jobName: z.string().min(1),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  steps: z.array(StepRunSchema),
});

/**
 * Type representing job run data.
 */
export type JobRunData = z.infer<typeof JobRunSchema>;

/**
 * Zod schema for workflow run.
 */
export const WorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid(),
  workflowName: z.string().min(1),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  jobs: z.array(JobRunSchema),
  logFile: z.string().optional(),
});

/**
 * Type representing workflow run data.
 */
export type WorkflowRunData = z.infer<typeof WorkflowRunSchema>;

/**
 * StepRun tracks the execution state of a single step.
 */
export class StepRun {
  constructor(
    readonly stepName: string,
    private _status: RunStatus,
    private _startedAt: Date | undefined,
    private _completedAt: Date | undefined,
    private _error: string | undefined,
    private _output: unknown,
    private _dataArtifacts: DataArtifactRef[] = [],
  ) {}

  /**
   * Creates a pending step run.
   */
  static pending(stepName: string): StepRun {
    return new StepRun(
      stepName,
      "pending",
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
  }

  /**
   * Reconstructs a StepRun from persisted data.
   */
  static fromData(data: StepRunData): StepRun {
    const validated = StepRunSchema.parse(data);
    return new StepRun(
      validated.stepName,
      validated.status,
      validated.startedAt ? new Date(validated.startedAt) : undefined,
      validated.completedAt ? new Date(validated.completedAt) : undefined,
      validated.error,
      validated.output,
      validated.dataArtifacts ?? [],
    );
  }

  get status(): RunStatus {
    return this._status;
  }

  get startedAt(): Date | undefined {
    return this._startedAt;
  }

  get completedAt(): Date | undefined {
    return this._completedAt;
  }

  get error(): string | undefined {
    return this._error;
  }

  get output(): unknown {
    return this._output;
  }

  /**
   * Gets the data artifacts produced by this step.
   */
  get dataArtifacts(): ReadonlyArray<DataArtifactRef> {
    return this._dataArtifacts;
  }

  /**
   * Adds a data artifact reference to this step.
   */
  addDataArtifact(artifact: DataArtifactRef): void {
    this._dataArtifacts.push({ ...artifact });
  }

  /**
   * Marks the step as running.
   */
  start(): void {
    this._status = "running";
    this._startedAt = new Date();
  }

  /**
   * Marks the step as succeeded.
   */
  succeed(output?: unknown): void {
    this._status = "succeeded";
    this._completedAt = new Date();
    if (output !== undefined) {
      this._output = output;
    }
  }

  /**
   * Marks the step as failed.
   */
  fail(error: string): void {
    this._status = "failed";
    this._completedAt = new Date();
    this._error = error;
  }

  /**
   * Marks the step as skipped.
   */
  skip(): void {
    this._status = "skipped";
    this._completedAt = new Date();
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): StepRunData {
    const data: StepRunData = {
      stepName: this.stepName,
      status: this._status,
      startedAt: this._startedAt?.toISOString(),
      completedAt: this._completedAt?.toISOString(),
      error: this._error,
      output: this._output,
    };
    if (this._dataArtifacts.length > 0) {
      data.dataArtifacts = this._dataArtifacts.map((a) => ({ ...a }));
    }
    return data;
  }
}

/**
 * JobRun tracks the execution state of a job and its steps.
 */
export class JobRun implements TriggerEvaluationContext {
  constructor(
    readonly jobName: string,
    private _status: RunStatus,
    private _startedAt: Date | undefined,
    private _completedAt: Date | undefined,
    private _steps: StepRun[],
  ) {}

  /**
   * Creates a pending job run with pending steps.
   */
  static pending(jobName: string, stepNames: string[]): JobRun {
    const steps = stepNames.map((name) => StepRun.pending(name));
    return new JobRun(jobName, "pending", undefined, undefined, steps);
  }

  /**
   * Reconstructs a JobRun from persisted data.
   */
  static fromData(data: JobRunData): JobRun {
    const validated = JobRunSchema.parse(data);
    const steps = validated.steps.map((s) => StepRun.fromData(s));
    return new JobRun(
      validated.jobName,
      validated.status,
      validated.startedAt ? new Date(validated.startedAt) : undefined,
      validated.completedAt ? new Date(validated.completedAt) : undefined,
      steps,
    );
  }

  get status(): RunStatus {
    return this._status;
  }

  get startedAt(): Date | undefined {
    return this._startedAt;
  }

  get completedAt(): Date | undefined {
    return this._completedAt;
  }

  get steps(): ReadonlyArray<StepRun> {
    return this._steps;
  }

  /**
   * Gets the status of a step by name (for TriggerEvaluationContext).
   */
  getStatus(ref: string): RunStatus | undefined {
    return this._steps.find((s) => s.stepName === ref)?.status;
  }

  /**
   * Gets a step run by name.
   */
  getStep(name: string): StepRun | undefined {
    return this._steps.find((s) => s.stepName === name);
  }

  /**
   * Adds a new expanded step (from forEach) to the job run.
   * The step is created in pending state.
   */
  addExpandedStep(stepName: string): void {
    // Only add if not already present
    if (!this._steps.find((s) => s.stepName === stepName)) {
      this._steps.push(StepRun.pending(stepName));
    }
  }

  /**
   * Marks the job as running.
   */
  start(): void {
    this._status = "running";
    this._startedAt = new Date();
  }

  /**
   * Marks the job as succeeded.
   */
  succeed(): void {
    this._status = "succeeded";
    this._completedAt = new Date();
  }

  /**
   * Marks the job as failed.
   */
  fail(): void {
    this._status = "failed";
    this._completedAt = new Date();
  }

  /**
   * Marks the job as skipped.
   */
  skip(): void {
    this._status = "skipped";
    this._completedAt = new Date();
    // Skip all pending steps
    for (const step of this._steps) {
      if (step.status === "pending") {
        step.skip();
      }
    }
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): JobRunData {
    return {
      jobName: this.jobName,
      status: this._status,
      startedAt: this._startedAt?.toISOString(),
      completedAt: this._completedAt?.toISOString(),
      steps: this._steps.map((s) => s.toData()),
    };
  }
}

/**
 * WorkflowRun is an aggregate root that tracks the execution state of a workflow.
 */
export class WorkflowRun implements TriggerEvaluationContext {
  private constructor(
    readonly id: WorkflowRunId,
    readonly workflowId: string,
    readonly workflowName: string,
    private _status: "pending" | "running" | "succeeded" | "failed",
    private _startedAt: Date | undefined,
    private _completedAt: Date | undefined,
    private _jobs: JobRun[],
    private _logFile: string | undefined,
  ) {}

  /**
   * Creates a new WorkflowRun from a workflow, initializing all jobs and steps as pending.
   */
  static create(workflow: Workflow): WorkflowRun {
    const id = crypto.randomUUID();
    const jobs = workflow.jobs.map((job) =>
      JobRun.pending(
        job.name,
        job.steps.map((s) => s.name),
      )
    );

    return new WorkflowRun(
      createWorkflowRunId(id),
      workflow.id,
      workflow.name,
      "pending",
      undefined,
      undefined,
      jobs,
      undefined,
    );
  }

  /**
   * Reconstructs a WorkflowRun from persisted data.
   */
  static fromData(data: WorkflowRunData): WorkflowRun {
    const validated = WorkflowRunSchema.parse(data);
    const jobs = validated.jobs.map((j) => JobRun.fromData(j));

    return new WorkflowRun(
      createWorkflowRunId(validated.id),
      validated.workflowId,
      validated.workflowName,
      validated.status,
      validated.startedAt ? new Date(validated.startedAt) : undefined,
      validated.completedAt ? new Date(validated.completedAt) : undefined,
      jobs,
      validated.logFile,
    );
  }

  get status(): "pending" | "running" | "succeeded" | "failed" {
    return this._status;
  }

  get startedAt(): Date | undefined {
    return this._startedAt;
  }

  get completedAt(): Date | undefined {
    return this._completedAt;
  }

  get jobs(): ReadonlyArray<JobRun> {
    return this._jobs;
  }

  /**
   * Gets the log file path for this run.
   */
  get logFile(): string | undefined {
    return this._logFile;
  }

  /**
   * Sets the log file path for this run.
   */
  setLogFile(path: string): void {
    this._logFile = path;
  }

  /**
   * Gets the status of a job by name (for TriggerEvaluationContext).
   */
  getStatus(ref: string): RunStatus | undefined {
    return this._jobs.find((j) => j.jobName === ref)?.status;
  }

  /**
   * Gets a job run by name.
   */
  getJob(name: string): JobRun | undefined {
    return this._jobs.find((j) => j.jobName === name);
  }

  /**
   * Marks the workflow run as started.
   */
  start(): void {
    this._status = "running";
    this._startedAt = new Date();
  }

  /**
   * Marks the workflow run as completed (succeeded or failed based on job results).
   */
  complete(): void {
    const anyFailed = this._jobs.some((j) => j.status === "failed");
    this._status = anyFailed ? "failed" : "succeeded";
    this._completedAt = new Date();
  }

  /**
   * Converts to plain data for persistence.
   */
  toData(): WorkflowRunData {
    const data: WorkflowRunData = {
      id: this.id,
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      status: this._status,
      startedAt: this._startedAt?.toISOString(),
      completedAt: this._completedAt?.toISOString(),
      jobs: this._jobs.map((j) => j.toData()),
    };
    if (this._logFile) {
      data.logFile = this._logFile;
    }
    return data;
  }
}
