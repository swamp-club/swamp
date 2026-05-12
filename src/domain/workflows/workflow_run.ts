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
  allowedFailure: z.boolean().optional(),
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
  workflowDataArtifacts: z.array(DataArtifactRefSchema).optional(),
  logFile: z.string().optional(),
  tags: z.record(z.string(), z.string()).default({}),
});

/**
 * Type representing workflow run data (output — tags always present).
 */
export type WorkflowRunData = z.infer<typeof WorkflowRunSchema>;

/**
 * Type representing workflow run input data (tags optional for backward compat).
 */
export type WorkflowRunInput = z.input<typeof WorkflowRunSchema>;

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
    private _allowedFailure: boolean = false,
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
      false,
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
      validated.allowedFailure ?? false,
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
   * Whether this step's failure was allowed (not propagated to the job).
   */
  get allowedFailure(): boolean {
    return this._allowedFailure;
  }

  /**
   * Marks this step's failure as allowed.
   */
  markAllowedFailure(): void {
    this._allowedFailure = true;
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
    if (this._allowedFailure) {
      data.allowedFailure = true;
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
   * Replaces a forEach step's template entry with pending StepRuns for each
   * expanded step name. Called after forEach.in resolves at job start so
   * the persisted job run reflects the actual set of steps that will run,
   * rather than leaving the un-executed template alongside the expansions.
   *
   * If the template has already been replaced in a prior call (for example
   * when an expanded step was lazily added via {@link addExpandedStep}),
   * this method leaves existing entries in place and only inserts missing
   * expanded names. When `expandedNames` is empty the template is removed
   * outright — an empty forEach result means no steps run.
   */
  replaceExpandedSteps(
    templateName: string,
    expandedNames: readonly string[],
  ): void {
    const templateIndex = this._steps.findIndex(
      (s) => s.stepName === templateName,
    );
    if (templateIndex === -1) return;
    const existing = new Map(
      this._steps.map((s, i) => [s.stepName, i] as const),
    );
    const insertions: StepRun[] = [];
    for (const name of expandedNames) {
      if (!existing.has(name)) {
        insertions.push(StepRun.pending(name));
      }
    }
    this._steps.splice(templateIndex, 1, ...insertions);
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
    private readonly _tags: Record<string, string>,
    private _workflowDataArtifacts: DataArtifactRef[] = [],
  ) {}

  /**
   * Creates a new WorkflowRun from a workflow, initializing all jobs and steps as pending.
   */
  static create(
    workflow: Workflow,
    tags?: Record<string, string>,
  ): WorkflowRun {
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
      tags ?? {},
      [],
    );
  }

  /**
   * Reconstructs a WorkflowRun from persisted data.
   */
  static fromData(data: WorkflowRunInput): WorkflowRun {
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
      validated.tags,
      validated.workflowDataArtifacts ?? [],
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
   * Gets the data artifacts produced at workflow scope (e.g. by workflow-scope
   * reports), independent of any single step.
   */
  get workflowDataArtifacts(): ReadonlyArray<DataArtifactRef> {
    return this._workflowDataArtifacts;
  }

  /**
   * Adds a workflow-scope data artifact reference to this run.
   */
  addWorkflowDataArtifact(artifact: DataArtifactRef): void {
    this._workflowDataArtifacts.push({ ...artifact });
  }

  /**
   * Gets the log file path for this run.
   */
  get logFile(): string | undefined {
    return this._logFile;
  }

  /**
   * Gets the tags associated with this run.
   */
  get tags(): Readonly<Record<string, string>> {
    return this._tags;
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
      tags: { ...this._tags },
    };
    if (this._logFile) {
      data.logFile = this._logFile;
    }
    if (this._workflowDataArtifacts.length > 0) {
      data.workflowDataArtifacts = this._workflowDataArtifacts.map((a) => ({
        ...a,
      }));
    }
    return data;
  }
}
