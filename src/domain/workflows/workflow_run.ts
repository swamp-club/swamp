import { z } from "zod";
import { createWorkflowRunId, type WorkflowRunId } from "./workflow_id.ts";
import type {
  RunStatus,
  TriggerEvaluationContext,
} from "./trigger_condition.ts";
import type { Workflow } from "./workflow.ts";

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
    this._output = output;
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
    return {
      stepName: this.stepName,
      status: this._status,
      startedAt: this._startedAt?.toISOString(),
      completedAt: this._completedAt?.toISOString(),
      error: this._error,
      output: this._output,
    };
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
    return {
      id: this.id,
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      status: this._status,
      startedAt: this._startedAt?.toISOString(),
      completedAt: this._completedAt?.toISOString(),
      jobs: this._jobs.map((j) => j.toData()),
    };
  }
}
