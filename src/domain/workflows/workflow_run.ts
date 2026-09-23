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

import {
  type DeferredExpression,
  DeferredExpressionSchema,
} from "../expressions/deferred_expression.ts";
import { z } from "zod";
import { createWorkflowRunId, type WorkflowRunId } from "./workflow_id.ts";
import type {
  RunStatus,
  TriggerEvaluationContext,
} from "./trigger_condition.ts";
import type { Workflow } from "./workflow.ts";
import { DataArtifactRefSchema } from "../models/model_output.ts";
import type { DataArtifactRef } from "../models/model_output.ts";
import { AssertSeveritySchema } from "./step_task.ts";

/**
 * Zod schema for an approval decision recorded on a manual_approval step.
 */
export const ApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().datetime(),
});

export type ApprovalDecisionData = z.infer<typeof ApprovalDecisionSchema>;

export const AssertResultSchema = z.object({
  passed: z.boolean(),
  expr: z.string(),
  message: z.string(),
  severity: AssertSeveritySchema,
  error: z.string().optional(),
});

export type AssertResultData = z.infer<typeof AssertResultSchema>;

/**
 * Why a step did not run.
 *
 * A bare `skipped` status cannot distinguish a step a path guard correctly
 * excluded from one an operator deselected for a subset re-run, and both
 * reach CI as the same skip count. Recording the cause — and, for a guard,
 * the expression that decided it — is what lets an attestation say which
 * it was.
 *
 * A discriminated union rather than one object with an optional
 * `expression`: only a guard has an expression to report, and a flat shape
 * would happily validate `{ kind: "dependency", expression: "..." }`, which
 * describes nothing that can occur. Making it unrepresentable is cheaper
 * than a comment asking readers not to do it.
 */
export const StepSkipReasonSchema = z.discriminatedUnion("kind", [
  z.object({
    /** The step's own `guard` expression evaluated truthy. */
    kind: z.literal("guarded"),
    /** The evaluated guard expression, when one was recorded. */
    expression: z.string().optional(),
  }),
  z.object({
    /** A `dependsOn` condition on the step was not satisfied. */
    kind: z.literal("dependency"),
  }),
  z.object({
    /** The step's job was skipped, so the step never became eligible. */
    kind: z.literal("job_skipped"),
  }),
]);

/**
 * Type representing why a step was skipped.
 */
export type StepSkipReasonData = z.infer<typeof StepSkipReasonSchema>;

/**
 * Zod schema for step run.
 */
export const StepRunSchema = z.object({
  stepName: z.string().min(1),
  status: z.enum([
    "pending",
    "running",
    "waiting_approval",
    "succeeded",
    "failed",
    "skipped",
    "unknown",
  ]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  output: z.unknown().optional(),
  dataArtifacts: z.array(DataArtifactRefSchema).optional(),
  allowedFailure: z.boolean().optional(),
  approvalDecision: ApprovalDecisionSchema.optional(),
  approvalPrompt: z.string().optional(),
  assertResult: AssertResultSchema.optional(),
  forEachTemplate: z.string().optional(),
  skipReason: StepSkipReasonSchema.optional(),
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
  status: z.enum([
    "pending",
    "running",
    "waiting_approval",
    "succeeded",
    "failed",
    "skipped",
    "unknown",
  ]),
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
  status: z.enum([
    "pending",
    "running",
    "suspended",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  jobs: z.array(JobRunSchema),
  workflowDataArtifacts: z.array(DataArtifactRefSchema).optional(),
  logFile: z.string().optional(),
  pid: z.number().int().positive().optional(),
  tags: z.record(z.string(), z.string()).default({}),
  references: z.record(z.string(), z.string()).optional(),
  // Effective workflow inputs captured when a run suspends, so post-resume
  // steps can resolve `inputs.*`. Optional for backward compatibility with
  // runs persisted before this field existed.
  inputs: z.record(z.string(), z.unknown()).optional(),
  // Key NAMES of inputs supplied at resume time, recorded for audit. Values are
  // deliberately NOT persisted to avoid writing secrets (e.g. a freshly minted
  // auth key) to the plaintext run record.
  resumeInputs: z.array(z.string()).optional(),
  // Runtime expressions (env, vault) a parent workflow authored and passed in
  // through `inputs` unresolved. Persisted so a direct resume of this run can
  // admit them as provenance; the child's own YAML cannot reconstruct them.
  inheritedExpressions: z.array(z.string()).optional(),
  deferredExpressions: z.array(DeferredExpressionSchema).optional(),
  initiatedBy: z.string().optional(),
  instanceId: z.string().optional(),
  triggerSource: z.string().optional(),
  failedStep: z.string().optional(),
  failureReason: z.string().optional(),
  stepProgress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).optional(),
  // Derived on save: the run is suspended with every approval gate decided,
  // so it is waiting for a resume rather than an approval.
  awaitingResume: z.boolean().optional(),
  runPlan: z.object({
    fingerprint: z.string(),
    evaluatedWorkflowId: z.string().optional(),
    definitionFingerprint: z.string().optional(),
  }).optional(),
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
    private _approvalDecision: ApprovalDecisionData | undefined = undefined,
    private _approvalPrompt: string | undefined = undefined,
    private _assertResult: AssertResultData | undefined = undefined,
    private _forEachTemplate: string | undefined = undefined,
    private _skipReason: StepSkipReasonData | undefined = undefined,
  ) {}

  /**
   * Creates a pending step run.
   */
  static pending(
    stepName: string,
    forEachTemplate?: string,
  ): StepRun {
    return new StepRun(
      stepName,
      "pending",
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      forEachTemplate,
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
      validated.approvalDecision,
      validated.approvalPrompt,
      validated.assertResult,
      validated.forEachTemplate,
      validated.skipReason,
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

  get approvalDecision(): ApprovalDecisionData | undefined {
    return this._approvalDecision;
  }

  get approvalPrompt(): string | undefined {
    return this._approvalPrompt;
  }

  get assertResult(): AssertResultData | undefined {
    return this._assertResult;
  }

  get forEachTemplate(): string | undefined {
    return this._forEachTemplate;
  }

  /**
   * Why this step was skipped. Undefined unless {@link status} is `skipped`.
   */
  get skipReason(): StepSkipReasonData | undefined {
    return this._skipReason;
  }

  /**
   * Records an approval or rejection decision on this step.
   */
  recordApprovalDecision(decision: ApprovalDecisionData): void {
    this._approvalDecision = decision;
  }

  recordAssertResult(result: AssertResultData): void {
    this._assertResult = result;
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

  resetToPending(): void {
    this._status = "pending";
    this._startedAt = undefined;
    this._completedAt = undefined;
    this._error = undefined;
    this._output = undefined;
    this._dataArtifacts = [];
    this._allowedFailure = false;
    this._approvalDecision = undefined;
    this._approvalPrompt = undefined;
    this._assertResult = undefined;
    this._skipReason = undefined;
  }

  /**
   * Marks the step as running.
   */
  start(): void {
    this._status = "running";
    this._startedAt = new Date();
  }

  /**
   * Marks the step as waiting for manual approval.
   */
  waitForApproval(prompt?: string): void {
    this._status = "waiting_approval";
    if (prompt !== undefined) {
      this._approvalPrompt = prompt;
    }
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
   * Marks the step as unknown — the step was in-flight when the process
   * crashed and its outcome is ambiguous.
   */
  markUnknown(error?: string): void {
    this._status = "unknown";
    this._completedAt = new Date();
    if (error !== undefined) {
      this._error = error;
    }
  }

  /**
   * Marks the step as skipped.
   *
   * `reason` is optional so older callers keep compiling, but every
   * production skip site supplies one — a skip with no recorded cause is
   * exactly the ambiguity this field exists to remove.
   */
  skip(reason?: StepSkipReasonData): void {
    this._status = "skipped";
    this._completedAt = new Date();
    if (reason !== undefined) {
      this._skipReason = { ...reason };
    }
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
    if (this._approvalDecision) {
      data.approvalDecision = { ...this._approvalDecision };
    }
    if (this._approvalPrompt !== undefined) {
      data.approvalPrompt = this._approvalPrompt;
    }
    if (this._assertResult) {
      data.assertResult = { ...this._assertResult };
    }
    if (this._forEachTemplate) {
      data.forEachTemplate = this._forEachTemplate;
    }
    if (this._skipReason) {
      data.skipReason = { ...this._skipReason };
    }
    return data;
  }
}

/**
 * JobRun tracks the execution state of a job and its steps.
 */
export class JobRun implements TriggerEvaluationContext {
  private _forEachMappings = new Map<string, readonly string[]>();

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
   *
   * When `ref` is a forEach template name, aggregates the expanded steps'
   * statuses: failed if any failed, succeeded if all succeeded, skipped if
   * all skipped, running if any still in progress.
   */
  getStatus(ref: string): RunStatus | undefined {
    const direct = this._steps.find((s) => s.stepName === ref)?.status;
    if (direct !== undefined) return direct;

    const expandedNames = this._forEachMappings.get(ref);
    if (!expandedNames || expandedNames.length === 0) return undefined;

    const statuses: RunStatus[] = [];
    for (const name of expandedNames) {
      const status = this._steps.find((s) => s.stepName === name)?.status;
      if (status === undefined) return undefined;
      statuses.push(status);
    }

    if (
      statuses.some((s) =>
        s === "pending" || s === "running" || s === "waiting_approval"
      )
    ) {
      return "running";
    }
    if (statuses.some((s) => s === "unknown")) return "unknown";
    if (statuses.some((s) => s === "failed")) return "failed";
    if (statuses.every((s) => s === "succeeded")) return "succeeded";
    if (statuses.every((s) => s === "skipped")) return "skipped";
    // Mix of succeeded and skipped (no failures, all terminal)
    return "succeeded";
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
        insertions.push(StepRun.pending(name, templateName));
      }
    }
    this._steps.splice(templateIndex, 1, ...insertions);
  }

  /**
   * Records the mapping from a forEach template step name to its expanded
   * step names so {@link getStatus} can aggregate their statuses. Called
   * by the execution service after forEach expansion on every run
   * (including resume), so the mapping does not need to be persisted.
   */
  registerForEachExpansion(
    templateName: string,
    expandedNames: readonly string[],
  ): void {
    this._forEachMappings.set(templateName, expandedNames);
  }

  resetToPending(): void {
    this._status = "pending";
    this._startedAt = undefined;
    this._completedAt = undefined;
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
   * Marks the job as unknown — the job was in-flight when the process
   * crashed and its outcome is ambiguous.
   */
  markUnknown(): void {
    this._status = "unknown";
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
        step.skip({ kind: "job_skipped" });
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
 * A failed step recorded on a run, as returned by
 * {@link WorkflowRun.failedSteps}.
 */
export interface FailedStepRef {
  jobName: string;
  stepName: string;
  /** The workflow step this expanded forEach iteration came from. */
  forEachTemplate?: string;
  /** True when the step is a manual approval that was rejected. */
  approvalRejected: boolean;
}

/**
 * WorkflowRun is an aggregate root that tracks the execution state of a workflow.
 */
export class WorkflowRun implements TriggerEvaluationContext {
  private constructor(
    readonly id: WorkflowRunId,
    readonly workflowId: string,
    readonly workflowName: string,
    private _status:
      | "pending"
      | "running"
      | "suspended"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "interrupted",
    private _startedAt: Date | undefined,
    private _completedAt: Date | undefined,
    private _jobs: JobRun[],
    private _logFile: string | undefined,
    private readonly _tags: Record<string, string>,
    private _workflowDataArtifacts: DataArtifactRef[] = [],
    private _inputs: Record<string, unknown> = {},
    private _resumeInputs: string[] = [],
    private _pid: number | undefined = undefined,
    private _initiatedBy: string | undefined = undefined,
    private _instanceId: string | undefined = undefined,
    private _triggerSource: string | undefined = undefined,
    private _references: Record<string, string> | undefined = undefined,
    private _runPlan:
      | {
        fingerprint: string;
        evaluatedWorkflowId?: string;
        definitionFingerprint?: string;
      }
      | undefined = undefined,
    private _inheritedExpressions: string[] = [],
    private _deferredExpressions: DeferredExpression[] = [],
  ) {}

  /**
   * Creates a new WorkflowRun from a workflow, initializing all jobs and steps as pending.
   */
  static create(
    workflow: Workflow,
    tags?: Record<string, string>,
    initiatedBy?: string,
    triggerSource?: string,
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
      {},
      [],
      undefined,
      initiatedBy,
      undefined,
      triggerSource,
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
      validated.inputs ?? {},
      validated.resumeInputs ?? [],
      validated.pid,
      validated.initiatedBy,
      validated.instanceId,
      validated.triggerSource,
      validated.references,
      validated.runPlan,
      validated.inheritedExpressions ?? [],
      validated.deferredExpressions ?? [],
    );
  }

  get status():
    | "pending"
    | "running"
    | "suspended"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted" {
    return this._status;
  }

  get initiatedBy(): string | undefined {
    return this._initiatedBy;
  }

  get startedAt(): Date | undefined {
    return this._startedAt;
  }

  get completedAt(): Date | undefined {
    return this._completedAt;
  }

  get instanceId(): string | undefined {
    return this._instanceId;
  }

  get triggerSource(): string | undefined {
    return this._triggerSource;
  }

  get references(): Record<string, string> | undefined {
    return this._references;
  }

  setReferences(refs: Record<string, string>): void {
    this._references = refs;
  }

  get pid(): number | undefined {
    return this._pid;
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
   * Marks the workflow run as started and records the owning process ID.
   */
  start(pid?: number, instanceId?: string): void {
    this._status = "running";
    this._startedAt = new Date();
    this._pid = pid;
    if (instanceId) this._instanceId = instanceId;
  }

  /**
   * Marks the workflow run as completed (succeeded or failed based on job results).
   * No-ops if the run is already cancelled.
   */
  complete(): void {
    if (this._status === "cancelled" || this._status === "interrupted") {
      return;
    }
    const anyNonTerminal = this._jobs.some((j) =>
      j.status !== "succeeded" && j.status !== "skipped"
    );
    this._status = anyNonTerminal ? "failed" : "succeeded";
    this._completedAt = new Date();
  }

  /**
   * Marks the workflow run as cancelled with an optional reason.
   *
   * Deliberately no-ops on terminal states (succeeded, failed, cancelled)
   * so that late cancellation signals don't corrupt an already-finalized run.
   * This differs from ModelOutput.markCancelled which throws on terminal states.
   */
  cancel(reason?: string): void {
    if (
      this._status === "succeeded" || this._status === "failed" ||
      this._status === "cancelled" || this._status === "interrupted"
    ) {
      return;
    }
    this._status = "cancelled";
    this._completedAt = new Date();
    if (reason) {
      this._tags["cancel_reason"] = reason;
    }
  }

  interrupt(reason: string): void {
    if (
      this._status === "succeeded" || this._status === "failed" ||
      this._status === "interrupted"
    ) {
      return;
    }
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.status === "running") {
          step.markUnknown(`interrupted: ${reason}`);
        }
      }
      if (job.status === "running") {
        job.markUnknown();
      }
    }
    this._status = "interrupted";
    this._completedAt = new Date();
    this._tags["interrupt_reason"] = reason;
  }

  /**
   * Returns the names of all steps currently in `unknown` status.
   */
  unknownSteps(): string[] {
    const result: string[] = [];
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.status === "unknown") {
          result.push(step.stepName);
        }
      }
    }
    return result;
  }

  /**
   * Resets all `unknown` steps to `pending` for recovery re-execution.
   * Also resets their containing jobs if those jobs are in `unknown` status.
   * Only valid on interrupted runs.
   */
  resetUnknownStepsForRecovery(): void {
    if (this._status !== "interrupted") {
      throw new Error(
        `Cannot reset unknown steps: run is ${this._status}, expected interrupted`,
      );
    }
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.status === "unknown") {
          step.resetToPending();
        }
      }
      if (job.status === "unknown") {
        job.resetToPending();
      }
    }
    this._status = "suspended";
    this._completedAt = undefined;
  }

  /**
   * The run plan identity captured at run start. Contains the fingerprint
   * of the evaluated workflow, an optional reference to the persisted snapshot,
   * and the fingerprint of the definition as loaded from disk before
   * evaluation. Recovery compares the definition fingerprint, since the
   * evaluated one also changes with the run's inputs.
   */
  get runPlan():
    | {
      fingerprint: string;
      evaluatedWorkflowId?: string;
      definitionFingerprint?: string;
    }
    | undefined {
    return this._runPlan;
  }

  captureRunPlan(
    fingerprint: string,
    evaluatedWorkflowId?: string,
    definitionFingerprint?: string,
  ): void {
    this._runPlan = { fingerprint, evaluatedWorkflowId, definitionFingerprint };
  }

  /**
   * Records the effective workflow inputs on this run. Called at run
   * creation so every run persists its inputs, and again at suspend
   * so resume-time steps can resolve `inputs.*`.
   */
  captureInputs(inputs: Record<string, unknown>): void {
    this._inputs = inputs;
  }

  /**
   * Marks the workflow run as suspended (waiting for manual approval).
   */
  suspend(inputs?: Record<string, unknown>): void {
    this._status = "suspended";
    if (inputs) {
      this._inputs = inputs;
    }
  }

  /**
   * The effective workflow inputs for this run.
   */
  get inputs(): Readonly<Record<string, unknown>> {
    return this._inputs;
  }

  /**
   * Records runtime expressions a parent workflow authored into this run's
   * inputs, so a resume can restore the provenance a fresh run inherited.
   */
  captureInheritedExpressions(expressions: Iterable<string>): void {
    this._inheritedExpressions = [...expressions];
  }

  /** Capture durable parent scopes so resume does not borrow child bindings. */
  captureDeferredExpressions(expressions: readonly DeferredExpression[]): void {
    this._deferredExpressions = structuredClone([...expressions]);
  }

  get deferredExpressions(): readonly DeferredExpression[] {
    return this._deferredExpressions;
  }

  /** Authored expressions inherited from a parent or evaluated cache. */
  get inheritedExpressions(): ReadonlyArray<string> {
    return this._inheritedExpressions;
  }

  /**
   * The key names of inputs supplied across resume invocations, for audit.
   * Values are never recorded.
   */
  get resumeInputs(): ReadonlyArray<string> {
    return this._resumeInputs;
  }

  /**
   * Records the key names of inputs supplied at resume time. Appends and
   * de-duplicates so multiple resume cycles accumulate a complete audit trail.
   */
  recordResumeInputs(keys: string[]): void {
    for (const key of keys) {
      if (!this._resumeInputs.includes(key)) {
        this._resumeInputs.push(key);
      }
    }
  }

  /**
   * Resumes a suspended workflow run without overwriting startedAt.
   */
  resumeFromSuspended(): void {
    this._status = "running";
    this._completedAt = undefined;
  }

  resumeFromFailed(): void {
    this._status = "running";
    this._completedAt = undefined;
  }

  /**
   * Resets steps for a --from resume. The `fromStep` is a template step name
   * from the workflow YAML. `stepsToReset` is the set of persisted step names
   * (including forEach-expanded names) that should be reset to pending — the
   * fromStep itself plus all its transitive downstream dependents.
   * The caller (execution service) computes this set using the workflow
   * definition and the step dependency graph.
   */
  resetForResumeFrom(stepsToReset: ReadonlySet<string>): void {
    for (const job of this._jobs) {
      let jobNeedsReset = false;
      for (const step of job.steps) {
        if (stepsToReset.has(step.stepName)) {
          step.resetToPending();
          jobNeedsReset = true;
        }
      }
      if (jobNeedsReset) {
        job.resetToPending();
      }
    }
  }

  /**
   * Lists, in stored order, every step whose status is `failed` and whose
   * recorded `allowedFailure` is not set. The recorded value already
   * reflects `allowFailure` and the assertion severity threshold in force
   * when the run failed.
   */
  failedSteps(): FailedStepRef[] {
    const result: FailedStepRef[] = [];
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.status !== "failed" || step.allowedFailure) continue;
        const ref: FailedStepRef = {
          jobName: job.jobName,
          stepName: step.stepName,
          approvalRejected: step.approvalDecision?.approved === false,
        };
        if (step.forEachTemplate !== undefined) {
          ref.forEachTemplate = step.forEachTemplate;
        }
        result.push(ref);
      }
    }
    return result;
  }

  /**
   * Finds the step that is currently waiting for approval.
   */
  findWaitingApprovalStep(): { jobName: string; stepName: string } | undefined {
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.status === "waiting_approval") {
          return { jobName: job.jobName, stepName: step.stepName };
        }
      }
    }
    return undefined;
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
    if (this._pid !== undefined) {
      data.pid = this._pid;
    }
    if (this._logFile) {
      data.logFile = this._logFile;
    }
    if (this._workflowDataArtifacts.length > 0) {
      data.workflowDataArtifacts = this._workflowDataArtifacts.map((a) => ({
        ...a,
      }));
    }
    if (Object.keys(this._inputs).length > 0) {
      data.inputs = { ...this._inputs };
    }
    if (this._resumeInputs.length > 0) {
      data.resumeInputs = [...this._resumeInputs];
    }
    if (this._deferredExpressions.length > 0) {
      data.deferredExpressions = structuredClone(this._deferredExpressions);
    }
    if (this._inheritedExpressions.length > 0) {
      data.inheritedExpressions = [...this._inheritedExpressions];
    }
    if (this._initiatedBy !== undefined) {
      data.initiatedBy = this._initiatedBy;
    }
    if (this._instanceId !== undefined) {
      data.instanceId = this._instanceId;
    }
    if (this._triggerSource !== undefined) {
      data.triggerSource = this._triggerSource;
    }
    if (
      this._references !== undefined &&
      Object.keys(this._references).length > 0
    ) {
      data.references = { ...this._references };
    }

    const { failedStep, failureReason } = this.computeFailureInfo();
    if (failedStep !== undefined) {
      data.failedStep = failedStep;
    }
    if (failureReason !== undefined) {
      data.failureReason = failureReason;
    }

    const stepProgress = this.computeStepProgress();
    if (stepProgress !== undefined) {
      data.stepProgress = stepProgress;
    }
    if (this.isAwaitingResume()) {
      data.awaitingResume = true;
    }
    if (this._runPlan !== undefined) {
      data.runPlan = { ...this._runPlan };
    }

    return data;
  }

  /**
   * True when the run is suspended and no step is still waiting for approval:
   * every gate has been decided and the run needs a resume to continue.
   */
  isAwaitingResume(): boolean {
    return this._status === "suspended" &&
      this.findWaitingApprovalStep() === undefined;
  }

  private computeFailureInfo(): {
    failedStep: string | undefined;
    failureReason: string | undefined;
  } {
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.status === "failed" && !step.allowedFailure) {
          return {
            failedStep: step.stepName,
            failureReason: step.error,
          };
        }
      }
    }
    return { failedStep: undefined, failureReason: undefined };
  }

  private computeStepProgress():
    | { completed: number; total: number }
    | undefined {
    let completed = 0;
    let total = 0;
    for (const job of this._jobs) {
      for (const step of job.steps) {
        total++;
        if (
          step.status === "succeeded" || step.status === "skipped" ||
          step.status === "failed" || step.status === "unknown"
        ) {
          completed++;
        }
      }
    }
    if (total === 0) return undefined;
    return { completed, total };
  }
}
