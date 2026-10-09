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
  type DataPath,
  type RunSensitiveValues,
  SENSITIVE_FORMAT_VERSION,
  toPersistedForm,
  type WrittenReference,
  WrittenReferenceSchema,
} from "../secrets/mod.ts";
import {
  type DeferredExpression,
  DeferredExpressionSchema,
} from "../expressions/deferred_expression.ts";
import { z } from "zod";
import { createWorkflowRunId, type WorkflowRunId } from "./workflow_id.ts";
import {
  isUnfinishedStatus,
  type RunStatus,
  type TriggerEvaluationContext,
} from "./trigger_condition.ts";
import type { Workflow } from "./workflow.ts";
import type { RunTriggeringPrincipal } from "../vaults/run_vault_access.ts";
import { DataArtifactRefSchema } from "../models/model_output.ts";
import type { DataArtifactRef } from "../models/model_output.ts";
import { AssertSeveritySchema } from "./step_task.ts";
import {
  type NestedRunRef,
  type ParentRunRef,
  parseNestedRunLink,
  parseParentRunLink,
  persistedLink,
  type RunLink,
} from "./nested_run_ref.ts";
import {
  parseStoredWait,
  persistedWait,
  type SignalWait,
  type StoredWait,
  WAIT_TIMEOUT_STEP_ERROR,
  WAIT_UNREADABLE_STEP_ERROR,
} from "./signal_wait.ts";
import type { WaitOutcome } from "./signal_wait_records.ts";

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
 * Why a step failed, when the failure is structural rather than the step's
 * own outcome. `workflow_changed`: a failed-run resume reset the step, then
 * its job finished without running it, because the workflow or a forEach
 * collection changed since the run. A retry would fail the same way.
 */
export const StepFailureKindSchema = z.enum(["workflow_changed"]);

/**
 * Type representing a structural step failure.
 */
export type StepFailureKind = z.infer<typeof StepFailureKindSchema>;

/**
 * The error a stranded step fails with. See {@link JobRun.failStrandedResetSteps}.
 */
export const STRANDED_STEP_ERROR =
  "Not run: the workflow or a forEach collection changed since the run. Start a new run.";

/**
 * The error a step fails with when the run's signal aborted while it ran, or
 * before it started in a level the abort interrupted. See
 * {@link JobRun.cancelPendingSteps}; a resume runs a step that never started
 * ({@link StepRun.settledByAbort}).
 */
export const CANCELLED_STEP_ERROR = "cancelled";

/**
 * The error a step fails with when the process running it stopped before the
 * step finished, and a cancel settled the record it left. See
 * `cancelAndSettle` in abort_settlement.ts.
 */
export const OWNER_STOPPED_STEP_ERROR =
  "cancelled: the process running this step stopped before the step finished";

/**
 * Zod schema for step run.
 */
export const StepRunSchema = z.object({
  stepName: z.string().min(1),
  status: z.enum([
    "pending",
    "running",
    "waiting_approval",
    "waiting",
    // A wait whose registration and outcome live in the control-plane store
    // (swamp-club#3093). A binary that predates it cannot parse the status,
    // so it refuses the run instead of settling the wait from the record.
    "waiting_signal",
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
  // Seconds the gate was requested with. The step run holds it because a
  // step expanded by forEach has no step of its name in the definition
  // (swamp-club#3218).
  approvalTimeout: z.number().positive().optional(),
  assertResult: AssertResultSchema.optional(),
  forEachTemplate: z.string().optional(),
  skipReason: StepSkipReasonSchema.optional(),
  resetByResume: z.boolean().optional(),
  failureKind: StepFailureKindSchema.optional(),
  settledByAbort: z.boolean().optional(),
  // The child run a nested workflow step waits on (swamp-club#2736). Kept as
  // read and validated in the domain (see parseNestedRunLink), so a malformed
  // value never makes the run unloadable and is written back unchanged.
  nestedRun: z.unknown().optional(),
  // Set when the run ended while this step still waited on its child run,
  // leaving the child suspended on its own.
  detachedNestedRun: z.boolean().optional(),
  // The wait a `waiting_signal` step holds (`waiting` in a run suspended
  // before swamp-club#3093), or held before it settled. Kept as read
  // and validated in the domain (see parseStoredWait), as nestedRun is.
  wait: z.unknown().optional(),
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
    "waiting",
    "waiting_signal",
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
 * Whether a path in a run record carries a value that can hold a sensitive
 * value read through an expression, rather than structure: inputs, deferred
 * expression binding values, a step's approval prompt, error and assert
 * text, and the failure reason derived from them.
 */
function isRunValuePath(path: DataPath): boolean {
  if (path[0] === "inputs" || path[0] === "failureReason") return true;
  if (path[0] === "deferredExpressions" && path[2] === "bindings") return true;
  if (path[0] === "jobs" && path[2] === "steps") {
    const field = path[4];
    if (field === "error" || field === "approvalPrompt") return true;
    if (
      field === "assertResult" &&
      (path[5] === "message" || path[5] === "error")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The principal that triggered a serve run and the memberships captured at
 * run start (swamp-club#2676).
 */
export const TriggeringPrincipalSchema = z.object({
  kind: z.enum(["user", "worker", "service"]),
  id: z.string().min(1),
  tokenBinding: z.object({
    name: z.string(),
    createdAt: z.string(),
    principalId: z.string(),
  }).optional(),
  membership: z.object({
    localGroups: z.array(z.string()),
    idpGroups: z.array(z.string()),
    collectives: z.array(z.string()),
  }),
});

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
  // The pid and instance id the run had before a resume took it over, kept
  // while the resume drives the run and restored when the run leaves
  // running. `pid` and `instanceId` name the live process only while it runs;
  // otherwise they name the run's owner, which cancel routing and supersede
  // read.
  ownerBeforeResume: z.object({
    pid: z.number().int().positive().optional(),
    instanceId: z.string().optional(),
  }).optional(),
  triggerSource: z.string().optional(),
  failedStep: z.string().optional(),
  failureReason: z.string().optional(),
  // Where the record holds vault references in place of sensitive values
  // read through expressions, and the format they were written in. Absent in
  // runs written before sensitive values were kept off disk.
  writtenReferences: z.array(WrittenReferenceSchema).optional(),
  sensitiveFormat: z.number().int().positive().optional(),
  stepProgress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).optional(),
  // Derived on save: the run is suspended with every approval gate decided,
  // so it is waiting for a resume rather than an approval.
  awaitingResume: z.boolean().optional(),
  // Suspended by a recovery and not resumed since: the steps it reset wait
  // for someone to resume the run, so serve does not continue it.
  recovered: z.boolean().optional(),
  runPlan: z.object({
    fingerprint: z.string(),
    evaluatedWorkflowId: z.string().optional(),
    definitionFingerprint: z.string().optional(),
  }).optional(),
  // On a nested workflow's run: the parent step that started it
  // (swamp-club#2736). Validated in the domain, as nestedRun is.
  parentRun: z.unknown().optional(),
  // The principal that triggered a serve run and its memberships at run
  // start (swamp-club#2676). A resume is held to it, never to the resumer.
  // Absent on local runs and on runs written before it existed.
  triggeringPrincipal: TriggeringPrincipalSchema.optional(),
  // The vaults the run's `vaults:` lists allowed at run start (their
  // intersection, a parent's included). A resume is held to this list and
  // the workflow's current one, so an edit can narrow a suspended run but
  // never widen it. Absent when no list applied, and on older runs.
  allowedVaults: z.array(z.string()).optional(),
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
    private _resetByResume: boolean = false,
    private _failureKind: StepFailureKind | undefined = undefined,
    private _settledByAbort: boolean = false,
    private _nestedRun: RunLink<NestedRunRef> | undefined = undefined,
    private _detachedNestedRun: boolean = false,
    private _wait: StoredWait | undefined = undefined,
    private _approvalTimeout: number | undefined = undefined,
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
      validated.resetByResume ?? false,
      validated.failureKind,
      validated.settledByAbort ?? false,
      parseNestedRunLink(validated.nestedRun),
      validated.detachedNestedRun ?? false,
      parseStoredWait(validated.wait),
      validated.approvalTimeout,
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

  /** Seconds the waiting gate was requested with, when it has a deadline. */
  get approvalTimeout(): number | undefined {
    return this._approvalTimeout;
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
   * True while a failed-run resume has reset this step and it has not left
   * pending since. Persisted, so a resume that suspends again keeps it.
   */
  get resetByResume(): boolean {
    return this._resetByResume;
  }

  /**
   * Why the step failed, when the failure is structural. Undefined otherwise.
   */
  get failureKind(): StepFailureKind | undefined {
    return this._failureKind;
  }

  /**
   * True when the run's abort settled this step without starting it
   * (cancelled, or skipped on its `dependsOn` or its job's), so that cleanup
   * gated on it could run, or when the run's cleanup skipped it on its
   * `dependsOn` or its job's, possibly on work the abort settled. Persisted:
   * a resume resets such a step to pending and runs it, as it would have run
   * had the abort left it pending (see {@link WorkflowRun.reopenAbortedWork}).
   */
  get settledByAbort(): boolean {
    return this._settledByAbort;
  }

  /**
   * The child run this nested workflow step waits on, or waited on before it
   * settled. A malformed link reads as `broken` and is never followed.
   */
  get nestedRun(): RunLink<NestedRunRef> | undefined {
    return this._nestedRun;
  }

  /**
   * True while the step waits on a suspended child run rather than on an
   * approval gate of its own.
   */
  get isNestedWait(): boolean {
    return this._status === "waiting_approval" &&
      this._nestedRun !== undefined;
  }

  /**
   * True when the run ended while this step still waited on its child run.
   */
  get detachedNestedRun(): boolean {
    return this._detachedNestedRun;
  }

  /**
   * The wait this step holds, or held before it settled. A malformed wait
   * reads as undefined and never accepts a signal.
   */
  get signalWait(): SignalWait | undefined {
    return this._wait?.kind === "valid" ? this._wait.wait : undefined;
  }

  /**
   * True while the step is paused on a wait for a signal.
   */
  get isSignalWait(): boolean {
    return this._status === "waiting_signal" || this._status === "waiting";
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
    this._approvalTimeout = undefined;
    this._assertResult = undefined;
    this._skipReason = undefined;
    this._resetByResume = false;
    this._failureKind = undefined;
    this._settledByAbort = false;
    this._nestedRun = undefined;
    this._detachedNestedRun = false;
    this._wait = undefined;
  }

  /**
   * Marks a pending step as reset by a failed-run resume. Cleared when the
   * step leaves pending.
   */
  markResetByResume(): void {
    this._resetByResume = true;
  }

  /**
   * Clears a reset marker left by an earlier resume.
   */
  clearResetMarker(): void {
    this._resetByResume = false;
  }

  /**
   * Fails a step whose job finished without running it after a failed-run
   * resume reset it. The failure is structural, so it is never allowed.
   */
  failStranded(): void {
    this.fail(STRANDED_STEP_ERROR);
    this._allowedFailure = false;
    this._failureKind = "workflow_changed";
  }

  /**
   * Fails a step the run's abort left unstarted with
   * {@link CANCELLED_STEP_ERROR}, marked {@link settledByAbort}.
   */
  cancelUnstarted(): void {
    this.fail(CANCELLED_STEP_ERROR);
    this._settledByAbort = true;
  }

  /**
   * Skips a step the run's abort left unstarted, or one its cleanup skipped
   * on its `dependsOn`, marked {@link settledByAbort}.
   */
  skipUnstarted(reason: StepSkipReasonData): void {
    this.skip(reason);
    this._settledByAbort = true;
  }

  /**
   * Fails a manual approval the run's cancellation left undecided
   * (`waiting_approval`) with {@link CANCELLED_STEP_ERROR}, marked
   * {@link settledByAbort} like a step the abort settled without starting.
   * Any other status is left alone.
   */
  cancelUndecidedApproval(): void {
    if (this._status !== "waiting_approval") return;
    this.fail(CANCELLED_STEP_ERROR);
    this._settledByAbort = true;
  }

  /**
   * Fails a wait the run's cancellation left unsignalled with
   * {@link CANCELLED_STEP_ERROR}, marked {@link settledByAbort} like an
   * undecided approval. Any other status is left alone.
   */
  cancelOpenWait(): void {
    if (!this.isSignalWait) return;
    this.fail(CANCELLED_STEP_ERROR);
    this._settledByAbort = true;
  }

  /**
   * Marks the step as waiting for a signal on `wait`.
   */
  waitForSignal(wait: SignalWait): void {
    this._status = "waiting_signal";
    this._resetByResume = false;
    this._wait = { kind: "valid", wait };
  }

  /** Whether this step can take the stored outcome, without changing it. */
  canApplyWaitOutcome(outcome: WaitOutcome): boolean {
    const wait = this.signalWait;
    if (!this.isSignalWait || !wait || outcome.waitId !== wait.id) return false;
    return outcome.kind !== "accepted" ||
      (outcome.receipt.waitId === wait.id &&
        wait.validatePayload(outcome.payload).valid);
  }

  /**
   * Settles this step's wait from its stored outcome, the only way a wait
   * ends. An accepted signal succeeds the step with the payload and the
   * receipt as its output; a timeout fails it with
   * {@link WAIT_TIMEOUT_STEP_ERROR}; a cancel fails it as
   * {@link cancelOpenWait} does.
   *
   * The outcome was read from a store other writers can reach, so its
   * payload is checked against the schema this step captured before it is
   * kept. Returns false, changing nothing, when the step is not waiting,
   * its wait cannot be read, the outcome names another wait, or the payload
   * is not one the wait accepts.
   */
  applyWaitOutcome(outcome: WaitOutcome): boolean {
    if (!this.canApplyWaitOutcome(outcome)) return false;
    const wait = this.signalWait!;
    switch (outcome.kind) {
      case "accepted": {
        const validation = wait.validatePayload(outcome.payload);
        if (!validation.valid) return false;
        this._wait = { kind: "valid", wait: wait.settledWith(outcome.receipt) };
        this.succeed({
          type: "wait_for_signal",
          payload: validation.payload,
          signal: { ...outcome.receipt },
        });
        return true;
      }
      case "timed_out":
        this.fail(WAIT_TIMEOUT_STEP_ERROR);
        return true;
      case "cancelled":
        this.cancelOpenWait();
        return true;
    }
  }

  /**
   * Fails a waiting step whose stored wait cannot be read with
   * {@link WAIT_UNREADABLE_STEP_ERROR}: nothing can signal it and it has no
   * deadline to pass. Returns false, changing nothing, for any other step.
   */
  failUnreadableWait(): boolean {
    if (!this.isSignalWait || this.signalWait) return false;
    this.fail(WAIT_UNREADABLE_STEP_ERROR);
    return true;
  }

  /**
   * Fails a waiting step whose wait holds an outcome that cannot be read or
   * applied with {@link WAIT_UNREADABLE_STEP_ERROR}. The outcome is written
   * once, so nothing will ever settle the wait another way. Returns false,
   * changing nothing, for a step that is not waiting.
   */
  failUnusableOutcome(): boolean {
    if (!this.isSignalWait) return false;
    this.fail(WAIT_UNREADABLE_STEP_ERROR);
    return true;
  }

  /**
   * Marks the step as running.
   */
  start(): void {
    this._status = "running";
    this._startedAt = new Date();
    this._resetByResume = false;
  }

  /**
   * Marks the step as waiting for manual approval. `timeout` is the seconds
   * the gate stays open, counted from when the step started; a gate that
   * waits again takes the timeout of the new wait.
   */
  waitForApproval(prompt?: string, timeout?: number): void {
    this._status = "waiting_approval";
    this._resetByResume = false;
    if (prompt !== undefined) {
      this._approvalPrompt = prompt;
    }
    this._approvalTimeout = timeout;
  }

  /**
   * Marks a nested workflow step as waiting on its suspended child run.
   */
  waitForNestedRun(ref: NestedRunRef): void {
    this._status = "waiting_approval";
    this._resetByResume = false;
    this._nestedRun = { kind: "valid", ref: { ...ref } };
  }

  /**
   * Fails a nested workflow step whose child run's approval was rejected,
   * recording the child gate's decision so a retry refuses the step as a
   * rejected approval.
   */
  rejectNested(decision: ApprovalDecisionData, error: string): void {
    this._approvalDecision = { ...decision };
    this.fail(error);
  }

  /**
   * Fails a nested workflow step whose run ended while the step still waited
   * on its child run. The child stays suspended on its own. Marked
   * {@link settledByAbort}, so a resume of the run starts the step afresh.
   */
  detachNestedRun(error: string): void {
    this.fail(error);
    this._settledByAbort = true;
    this._detachedNestedRun = true;
  }

  /**
   * Marks the step as succeeded.
   */
  succeed(output?: unknown): void {
    this._status = "succeeded";
    this._completedAt = new Date();
    this._resetByResume = false;
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
    this._resetByResume = false;
  }

  /**
   * Marks the step as unknown — the step was in-flight when the process
   * crashed and its outcome is ambiguous.
   */
  markUnknown(error?: string): void {
    this._status = "unknown";
    this._completedAt = new Date();
    this._resetByResume = false;
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
    this._resetByResume = false;
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
    if (this._approvalTimeout !== undefined) {
      data.approvalTimeout = this._approvalTimeout;
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
    if (this._resetByResume) {
      data.resetByResume = true;
    }
    if (this._failureKind) {
      data.failureKind = this._failureKind;
    }
    if (this._settledByAbort) {
      data.settledByAbort = true;
    }
    if (this._nestedRun !== undefined) {
      data.nestedRun = persistedLink(this._nestedRun);
    }
    if (this._detachedNestedRun) {
      data.detachedNestedRun = true;
    }
    if (this._wait !== undefined) {
      data.wait = persistedWait(this._wait);
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

    if (statuses.some(isUnfinishedStatus)) {
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
    // Edit in place (callers may hold the `steps` array) without spreading
    // `insertions` into splice: a forEach can expand to more steps than fit
    // in a spread call (swamp-club#2565).
    const after = this._steps.splice(templateIndex);
    after.shift();
    for (const step of insertions) this._steps.push(step);
    for (const step of after) this._steps.push(step);
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

  /**
   * True when {@link registerForEachExpansion} recorded a mapping for the
   * template. A run loaded from storage has none until one is registered.
   */
  hasForEachExpansion(templateName: string): boolean {
    return this._forEachMappings.has(templateName);
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
   * Marks the job as unknown — its outcome is ambiguous: the job was
   * in-flight when the process crashed, or a cancellation left it with only
   * guarded steps whose guards never decided.
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
   * Fails every step a failed-run resume reset that the job finished without
   * running (a stranded step), and returns them. Called when the job's walk
   * ends, unless the run suspended or was cancelled. A tracked reset step
   * that the current workflow no longer produces, such as an iteration
   * dropped from a smaller forEach collection, would otherwise stay pending
   * in a job reported succeeded.
   */
  failStrandedResetSteps(): StepRun[] {
    const stranded = this._steps.filter((step) => step.resetByResume);
    for (const step of stranded) {
      step.failStranded();
    }
    return stranded;
  }

  /**
   * Fails each named step that is still `pending` with
   * {@link CANCELLED_STEP_ERROR}, and returns them. Called for the steps of a
   * level the run's abort interrupted: a step queued behind a concurrency
   * limit never started, and would otherwise stay pending, so a `failed` or
   * `completed` condition on it could never be met. Each is marked
   * {@link StepRun.settledByAbort}, so a resume runs it. Steps in any other
   * status are left alone.
   */
  cancelPendingSteps(stepNames: Iterable<string>): StepRun[] {
    const cancelled: StepRun[] = [];
    for (const name of stepNames) {
      const step = this.getStep(name);
      if (step?.status === "pending") {
        step.cancelUnstarted();
        cancelled.push(step);
      }
    }
    return cancelled;
  }

  /**
   * Skips a job whose `dependsOn` is unmet, the run's abort having left it
   * unstarted or its cleanup having reached it, as {@link skip} does, but
   * marks each step it skips {@link StepRun.settledByAbort}, so a resume
   * walks the job again.
   */
  skipNotStarted(): void {
    for (const step of this._steps) {
      if (step.status === "pending") {
        step.skipUnstarted({ kind: "job_skipped" });
      }
    }
    this.skip();
  }

  /**
   * Settles a job that never started because the run's abort interrupted its
   * level, once its steps are settled. While any step is still `pending` (a
   * guarded step whose guard never decided), the job stays `pending`: nothing
   * in it ran, so a step cancelled beside it is no evidence of failure, and
   * neither `succeeded`, `failed`, `completed` nor `skipped` may hold for it.
   * Otherwise it fails when any step failed and is skipped when every step
   * was skipped. Its settled steps are marked {@link StepRun.settledByAbort},
   * so a resume walks the job again. Any other job status is left alone.
   */
  settleNotStarted(): void {
    if (this._status !== "pending") return;
    if (this._steps.some((step) => step.status === "pending")) return;
    if (this._steps.some((step) => step.status === "failed")) {
      this.fail();
    } else {
      this.skip();
    }
  }

  /**
   * Settles a job a resume inherited as `running` (from the suspension, or
   * left running by a failed run) and never started because its abort kept
   * the job from its level, once its pending steps are settled. It fails
   * when a step failed without its failure being allowed, as a job that
   * finishes its walk does; otherwise it is `unknown` while a step is
   * unfinished (a guarded step left `pending`, or one still `running` or
   * `waiting_approval`), since its outcome is ambiguous; otherwise it
   * succeeds. Like {@link settleNotStarted}, its settled steps are marked
   * {@link StepRun.settledByAbort}, so a resume walks the job again. Any
   * other job status is left alone.
   */
  settleNotResumed(): void {
    if (this._status !== "running") return;
    if (
      this._steps.some((step) =>
        step.status === "failed" && !step.allowedFailure
      )
    ) {
      this.fail();
    } else if (this._steps.some((step) => isUnfinishedStatus(step.status))) {
      this.markUnknown();
    } else {
      this.succeed();
    }
  }

  /**
   * True when the run's abort left work in this job for a resume to run: a
   * step it settled without starting ({@link StepRun.settledByAbort}), or a
   * guarded step it left undecided (`pending`) in a job it ended `unknown`.
   * See {@link WorkflowRun.reopenAbortedWork}.
   */
  get holdsAbortedWork(): boolean {
    return this._steps.some((step) => step.settledByAbort) ||
      (this._status === "unknown" &&
        this._steps.some((step) => step.status === "pending"));
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
  /** Set when the failure is structural. See {@link StepFailureKind}. */
  failureKind?: StepFailureKind;
}

/**
 * One stored step record: step names are unique only within a job.
 */
export interface StepRunRef {
  readonly jobName: string;
  readonly stepName: string;
}

/**
 * A step waiting for a signal, as returned by
 * {@link WorkflowRun.findSignalWaits}.
 */
export interface SignalWaitRef {
  readonly jobName: string;
  readonly stepName: string;
  /** Undefined when the stored wait cannot be read. */
  readonly wait: SignalWait | undefined;
}

/**
 * A nested workflow step that waits on its child run, as returned by
 * {@link WorkflowRun.findNestedWaits}.
 */
export interface NestedWaitRef {
  readonly jobName: string;
  readonly stepName: string;
  readonly link: RunLink<NestedRunRef>;
}

/**
 * A child run a nested workflow step still waited on when its run ended, as
 * returned by {@link WorkflowRun.detachedNestedRuns}.
 */
export interface DetachedNestedRunRef {
  readonly jobName: string;
  readonly stepName: string;
  readonly child: NestedRunRef;
}

/**
 * The process driving a run: its pid, and the serve instance id when serve
 * drives it. A run with no instance id is owned by a local CLI process.
 */
export interface RunOwner {
  readonly pid: number;
  readonly instanceId?: string;
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
    private _ownerBeforeResume:
      | { pid?: number; instanceId?: string }
      | undefined = undefined,
    private _writtenReferences: WrittenReference[] = [],
    private _sensitiveFormat: number | undefined = undefined,
    private _parentRun: RunLink<ParentRunRef> | undefined = undefined,
    private _triggeringPrincipal: RunTriggeringPrincipal | undefined =
      undefined,
    private _allowedVaults: string[] | undefined = undefined,
    private _recovered: boolean = false,
  ) {}

  /**
   * The run's record of sensitive values, attached for the lifetime of the
   * process driving the run. Never persisted; see {@link toPersistedData}.
   */
  private _sensitiveValues: RunSensitiveValues | undefined = undefined;

  /** Attaches the run's record of sensitive values resolved for expressions. */
  attachSensitiveValues(values: RunSensitiveValues): void {
    this._sensitiveValues = values;
  }

  /**
   * The run's inputs with sensitive values masked, for output shown to users
   * or written with reports.
   */
  maskedInputs(): Record<string, unknown> {
    return (this._sensitiveValues?.masked(this._inputs) ??
      this._inputs) as Record<string, unknown>;
  }

  /** Where the stored record holds references, as loaded. */
  get writtenReferences(): readonly WrittenReference[] {
    return this._writtenReferences;
  }

  /** The stored record's sensitive-value format, as loaded. */
  get sensitiveFormat(): number | undefined {
    return this._sensitiveFormat;
  }

  /**
   * The data to write to disk. With the run's record attached, every
   * recorded sensitive value at a value position (inputs, deferred binding
   * values, approval prompts, step errors and assert text, the failure
   * reason) is written as the vault reference it came from. Without one (a
   * process that only changes status), the stored data and its references
   * are written back unchanged.
   */
  toPersistedData(): WorkflowRunData {
    const data = this.toData();
    if (!this._sensitiveValues) return data;
    const { writtenReferences: _stale, sensitiveFormat: _format, ...rest } =
      data;
    const form = toPersistedForm(rest, this._sensitiveValues, {
      applies: isRunValuePath,
    });
    return {
      ...form.data,
      ...(form.writtenReferences.length > 0
        ? { writtenReferences: form.writtenReferences }
        : {}),
      sensitiveFormat: SENSITIVE_FORMAT_VERSION,
    };
  }

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
      validated.ownerBeforeResume,
      validated.writtenReferences ?? [],
      validated.sensitiveFormat,
      parseParentRunLink(validated.parentRun),
      validated.triggeringPrincipal,
      validated.allowedVaults,
      validated.recovered ?? false,
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

  /**
   * The principal that triggered the run and its memberships at run start,
   * when a serve run recorded them (swamp-club#2676).
   */
  get triggeringPrincipal(): RunTriggeringPrincipal | undefined {
    return this._triggeringPrincipal;
  }

  /** Records who triggered the run; resumes are held to this principal. */
  recordTriggeringPrincipal(principal: RunTriggeringPrincipal): void {
    this._triggeringPrincipal = structuredClone(principal);
  }

  /**
   * The vaults the run's `vaults:` lists allowed when it started, when a
   * list applied. A resume is held to it as well as to the workflow's
   * current list.
   */
  get allowedVaults(): readonly string[] | undefined {
    return this._allowedVaults;
  }

  /** Records the vaults the run's `vaults:` lists allow at run start. */
  recordAllowedVaults(vaults: Iterable<string>): void {
    this._allowedVaults = [...vaults];
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

  /**
   * On a nested workflow's run, the parent step that started it. A
   * malformed link reads as `broken` and is never followed.
   */
  get parentRun(): RunLink<ParentRunRef> | undefined {
    return this._parentRun;
  }

  /**
   * Records the parent step that starts this run as a nested workflow.
   * Called once, before the run starts.
   */
  recordParentRun(ref: ParentRunRef): void {
    this._parentRun = {
      kind: "valid",
      ref: { ...ref, ancestorWorkflowNames: [...ref.ancestorWorkflowNames] },
    };
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
    this.detachNestedWaits();
    const anyNonTerminal = this._jobs.some((j) =>
      j.status !== "succeeded" && j.status !== "skipped"
    );
    this._status = anyNonTerminal ? "failed" : "succeeded";
    this._completedAt = new Date();
    this.releaseOwnership();
  }

  /**
   * True while the run can still be cancelled: it is pending, running or
   * suspended. A finished run (succeeded, failed, cancelled or interrupted)
   * keeps its record.
   */
  get isCancellable(): boolean {
    return this._status === "pending" || this._status === "running" ||
      this._status === "suspended";
  }

  /**
   * Marks the workflow run as cancelled with an optional reason. Changes only
   * the run's status: its jobs and steps are settled by `cancelAndSettle`
   * (abort_settlement.ts), the only production caller.
   *
   * Deliberately no-ops unless {@link isCancellable}, so that late
   * cancellation signals don't corrupt an already-finalized run.
   * This differs from ModelOutput.markCancelled which throws on terminal states.
   */
  endAsCancelled(reason?: string): void {
    if (!this.isCancellable) {
      return;
    }
    this.detachNestedWaits();
    this._status = "cancelled";
    this._completedAt = new Date();
    if (reason) {
      this._tags["cancel_reason"] = reason;
    }
    this.releaseOwnership();
  }

  /**
   * Records why an already-cancelled run was cancelled. Only sets the
   * cancel_reason tag; no-ops unless the run is cancelled, so it never
   * changes a run's status. An empty reason is ignored, as in
   * endAsCancelled().
   */
  recordCancelReason(reason: string): void {
    if (this._status !== "cancelled" || !reason) {
      return;
    }
    this._tags["cancel_reason"] = reason;
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
    this.releaseOwnership();
  }

  /**
   * Interrupts a `running` run whose owning process died, as read back from
   * storage. A step's start is saved before it runs, but a record written
   * by a swamp that did not save step starts (or a kill that beat the save)
   * shows the step that was in flight as `pending`. So in a job left
   * `running` with no step recorded `running`, every `pending` step is
   * marked unknown as well: recovery then asks before re-running it rather
   * than assuming it never started.
   */
  interruptOrphaned(reason: string): void {
    if (this._status === "running") {
      for (const job of this._jobs) {
        if (
          job.status !== "running" ||
          job.steps.some((step) => step.status === "running")
        ) {
          continue;
        }
        for (const step of job.steps) {
          if (step.status === "pending") {
            step.markUnknown(`interrupted: ${reason} (start not recorded)`);
          }
        }
      }
    }
    this.interrupt(reason);
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
    this._recovered = true;
  }

  /**
   * True while the run is suspended by a recovery and has not been resumed
   * since. Its reset steps had an unknown outcome, so only a resume someone
   * asks for runs them again: serve never continues such a run by itself.
   */
  get awaitsResumeAfterRecovery(): boolean {
    return this._status === "suspended" && this._recovered;
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
    this.releaseOwnership();
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
   * Resumes a suspended workflow run without overwriting startedAt. The
   * resuming process becomes the run's owner.
   */
  resumeFromSuspended(owner: RunOwner): void {
    this._status = "running";
    this._completedAt = undefined;
    this._recovered = false;
    this.takeOwnership(owner);
  }

  /**
   * Resumes a failed workflow run without overwriting startedAt. The
   * resuming process becomes the run's owner.
   */
  resumeFromFailed(owner: RunOwner): void {
    this._status = "running";
    this._completedAt = undefined;
    this.takeOwnership(owner);
  }

  /**
   * Records the process that now drives the run. The instance id is replaced,
   * not merged: a local resume of a run serve started clears it, so cancel
   * treats the run as local and stops the resuming process. The run's owner
   * is kept aside until the run leaves running (see
   * {@link releaseOwnership}); an owner already kept aside is not replaced.
   */
  private takeOwnership(owner: RunOwner): void {
    this._ownerBeforeResume ??= {
      pid: this._pid,
      instanceId: this._instanceId,
    };
    this._pid = owner.pid;
    this._instanceId = owner.instanceId;
  }

  /**
   * Hands the run back to the owner a resume took it from, once no process
   * drives it: a run that suspends again is cancelled and superseded as its
   * owner's run, not as the resume's.
   */
  private releaseOwnership(): void {
    if (this._ownerBeforeResume === undefined) return;
    this._pid = this._ownerBeforeResume.pid;
    this._instanceId = this._ownerBeforeResume.instanceId;
    this._ownerBeforeResume = undefined;
  }

  /**
   * Resets steps for a failed-run resume (--from or retry). `stepsToReset`
   * is the set of persisted step names (including forEach-expanded names)
   * that should be reset to pending — the entry step plus all its transitive
   * downstream dependents. The caller (see `planFailedRunResume`) computes
   * this set using the workflow definition and the step dependency graph.
   *
   * Each `tracked` record is marked as reset by this resume, after any
   * marker an earlier resume left is cleared. A job that finishes with a
   * marked step still pending fails it (see
   * {@link JobRun.failStrandedResetSteps}).
   */
  resetForResumeFrom(
    stepsToReset: ReadonlySet<string>,
    tracked: readonly StepRunRef[] = [],
  ): void {
    for (const job of this._jobs) {
      let jobNeedsReset = false;
      for (const step of job.steps) {
        step.clearResetMarker();
        if (stepsToReset.has(step.stepName)) {
          step.resetToPending();
          jobNeedsReset = true;
        }
      }
      if (jobNeedsReset) {
        job.resetToPending();
      }
    }
    for (const ref of tracked) {
      this.getJob(ref.jobName)?.getStep(ref.stepName)?.markResetByResume();
    }
  }

  /**
   * Reopens the work the run's abort left unfinished, for any resume, so it
   * runs as it would have had the abort left it pending: every step the
   * abort settled without starting ({@link StepRun.settledByAbort}) is reset
   * to pending, record by record, and a finished job that
   * {@link JobRun.holdsAbortedWork} is reset to pending too, so the resume
   * walks it. Records with the same name in other jobs are left alone.
   */
  reopenAbortedWork(): void {
    for (const job of this._jobs) {
      const reopen = job.holdsAbortedWork;
      for (const step of job.steps) {
        if (step.settledByAbort) step.resetToPending();
      }
      if (
        reopen &&
        (job.status === "succeeded" || job.status === "failed" ||
          job.status === "skipped" || job.status === "unknown")
      ) {
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
        if (step.failureKind !== undefined) {
          ref.failureKind = step.failureKind;
        }
        result.push(ref);
      }
    }
    return result;
  }

  /**
   * Finds the approval gate of this run that is waiting for a decision. A
   * nested workflow step waiting on its child run is not a gate: see
   * {@link findNestedWaits}.
   */
  findWaitingApprovalStep(): { jobName: string; stepName: string } | undefined {
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.status === "waiting_approval" && !step.isNestedWait) {
          return { jobName: job.jobName, stepName: step.stepName };
        }
      }
    }
    return undefined;
  }

  /**
   * Lists, in stored order, the steps waiting for a signal, with the wait
   * each holds. A waiting step whose wait cannot be read is listed without
   * one.
   */
  findSignalWaits(): SignalWaitRef[] {
    const result: SignalWaitRef[] = [];
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (!step.isSignalWait) continue;
        result.push({
          jobName: job.jobName,
          stepName: step.stepName,
          wait: step.signalWait,
        });
      }
    }
    return result;
  }

  /**
   * The first step waiting for a signal on a wait still open at `now`. A
   * wait past its deadline, or one that cannot be read, is not open: a
   * resume settles it.
   */
  findOpenSignalWait(
    now: Date,
  ): { jobName: string; stepName: string; wait: SignalWait } | undefined {
    for (const ref of this.findSignalWaits()) {
      if (ref.wait && !ref.wait.isExpired(now)) {
        return { jobName: ref.jobName, stepName: ref.stepName, wait: ref.wait };
      }
    }
    return undefined;
  }

  /**
   * Lists, in stored order, the nested workflow steps waiting on a suspended
   * child run.
   */
  findNestedWaits(): NestedWaitRef[] {
    const result: NestedWaitRef[] = [];
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.isNestedWait && step.nestedRun !== undefined) {
          result.push({
            jobName: job.jobName,
            stepName: step.stepName,
            link: step.nestedRun,
          });
        }
      }
    }
    return result;
  }

  /**
   * The child runs nested workflow steps still waited on when this run
   * ended. Each child was left suspended on its own.
   */
  detachedNestedRuns(): DetachedNestedRunRef[] {
    const result: DetachedNestedRunRef[] = [];
    for (const job of this._jobs) {
      for (const step of job.steps) {
        if (step.detachedNestedRun && step.nestedRun?.kind === "valid") {
          result.push({
            jobName: job.jobName,
            stepName: step.stepName,
            child: step.nestedRun.ref,
          });
        }
      }
    }
    return result;
  }

  /**
   * Settles every nested workflow step still waiting on its child run as
   * the run ends, and fails a job left with nothing else to finish. Only
   * this run changes: cancelling the children is the caller's cascade
   * (swamp-club#2867). Not called on interrupt, since an interrupted run is
   * recovered and keeps waiting.
   */
  detachNestedWaits(): void {
    for (const job of this._jobs) {
      let detached = false;
      for (const step of job.steps) {
        if (!step.isNestedWait) continue;
        // The child's own state is not read here: it may have finished
        // since this run last looked at it.
        const child = step.nestedRun?.kind === "valid"
          ? `run ${step.nestedRun.ref.runId} of nested workflow "${step.nestedRun.ref.workflowName}"`
          : "its nested workflow run";
        step.detachNestedRun(
          `Detached: the run ended while this step waited on ${child}.`,
        );
        detached = true;
      }
      const unfinished = job.steps.some((step) =>
        isUnfinishedStatus(step.status)
      );
      if (
        detached && !unfinished &&
        (job.status === "pending" || job.status === "running" ||
          job.status === "waiting_approval")
      ) {
        job.fail();
      }
    }
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
    if (this._ownerBeforeResume !== undefined) {
      data.ownerBeforeResume = { ...this._ownerBeforeResume };
    }
    if (this._triggerSource !== undefined) {
      data.triggerSource = this._triggerSource;
    }
    if (this._triggeringPrincipal !== undefined) {
      data.triggeringPrincipal = structuredClone(
        this._triggeringPrincipal,
      ) as WorkflowRunData["triggeringPrincipal"];
    }
    if (this._allowedVaults !== undefined) {
      data.allowedVaults = [...this._allowedVaults];
    }
    if (this._writtenReferences.length > 0) {
      data.writtenReferences = structuredClone(this._writtenReferences);
    }
    if (this._sensitiveFormat !== undefined) {
      data.sensitiveFormat = this._sensitiveFormat;
    }
    if (
      this._references !== undefined &&
      Object.keys(this._references).length > 0
    ) {
      data.references = { ...this._references };
    }

    const { failedStep, failureReason } = this.failureInfo();
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
    if (this.awaitsResumeAfterRecovery) {
      data.recovered = true;
    }
    if (this._runPlan !== undefined) {
      data.runPlan = { ...this._runPlan };
    }
    if (this._parentRun !== undefined) {
      data.parentRun = persistedLink(this._parentRun);
    }

    return data;
  }

  /**
   * True when the run is suspended, no gate is still waiting for a decision
   * and no step waits on a nested run or for a signal: the run needs a
   * resume to continue. A wait past its deadline still counts as waiting.
   * Whether a nested wait's child has finished is derived from the child
   * (see NestedRunLink), never stored here.
   */
  isAwaitingResume(): boolean {
    return this._status === "suspended" &&
      this.findWaitingApprovalStep() === undefined &&
      this.findNestedWaits().length === 0 &&
      this.findSignalWaits().length === 0;
  }

  /**
   * The step the run reports as failed, and its error: the first failed
   * step in stored order whose failure was not allowed. A step the run's end
   * settled without running it (a sibling gate of a rejected one, a step its
   * abort never started) reports the run's end, not why it ended, so it is
   * named only when no other step failed.
   */
  failureInfo(): {
    failedStep: string | undefined;
    failureReason: string | undefined;
  } {
    let settled: StepRun | undefined;
    for (const job of this._jobs) {
      for (const step of job.steps) {
        // A step detached when the run ended reports the run's end, not why
        // it ended.
        if (
          step.status !== "failed" || step.allowedFailure ||
          step.detachedNestedRun
        ) {
          continue;
        }
        if (!step.settledByAbort) {
          return {
            failedStep: step.stepName,
            failureReason: step.error,
          };
        }
        settled ??= step;
      }
    }
    return {
      failedStep: settled?.stepName,
      failureReason: settled?.error,
    };
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
