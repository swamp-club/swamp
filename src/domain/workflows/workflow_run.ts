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
import { InputRecordSchema } from "../inputs/input_record.ts";
import { createWorkflowRunId, type WorkflowRunId } from "./workflow_id.ts";
import {
  isUnfinishedStatus,
  type RunStatus,
  type TriggerEvaluationContext,
} from "./trigger_condition.ts";
import type { Workflow } from "./workflow.ts";
import type { StepStart } from "./step_start.ts";
import type { RunTriggeringPrincipal } from "../vaults/run_vault_access.ts";
import { DataArtifactRefSchema } from "../models/model_output.ts";
import type { DataArtifactRef } from "../models/model_output.ts";
import { AssertSeveritySchema } from "./step_task.ts";
import { fanOutGateOf, type FanOutPlan, hasLane } from "../remote/fan_out.ts";
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
  receiptForCaller,
  type SignalWait,
  type StoredWait,
  WAIT_TIMEOUT_STEP_ERROR,
  WAIT_UNREADABLE_STEP_ERROR,
} from "./signal_wait.ts";
import type { WaitOutcome } from "./signal_wait_records.ts";
import {
  alignProvenance,
  ProvenanceMap,
  ProvenanceMapDataSchema,
  sentinelReferenceTextOf,
} from "../expressions/provenance_map.ts";
import { withWrittenReferenceRanges } from "../expressions/persisted_evaluation.ts";
import {
  type RunStartKeyData,
  RunStartKeyDataSchema,
} from "./run_start_key.ts";

export const ApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
  decidedBy: z.string().optional(),
  client: z.string().optional(),
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
 * a discriminated union so only a guard carries an expression; a flat shape
 * would validate a dependency skip with an expression, which describes nothing
 * that can occur
 */
export const StepSkipReasonSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("guarded"),
    expression: z.string().optional(),
  }),
  z.object({
    kind: z.literal("dependency"),
  }),
  z.object({
    kind: z.literal("job_skipped"),
  }),
]);

export type StepSkipReasonData = z.infer<typeof StepSkipReasonSchema>;

/**
 * workflow_changed: a failed-run resume reset the step, then its job finished
 * without running it because the workflow or a forEach collection changed; a
 * retry would fail the same way
 */
export const StepFailureKindSchema = z.enum(["workflow_changed"]);

export type StepFailureKind = z.infer<typeof StepFailureKindSchema>;

export const STRANDED_STEP_ERROR =
  "Not run: the workflow or a forEach collection changed since the run. Start a new run.";

/**
 * also set for a step in a level the abort interrupted before it started; a
 * resume runs a step that never started
 */
export const CANCELLED_STEP_ERROR = "cancelled";

export const OWNER_STOPPED_STEP_ERROR =
  "cancelled: the process running this step stopped before the step finished";

export const StepRunSchema = z.object({
  stepName: z.string().min(1),
  status: z.enum([
    "pending",
    "running",
    "waiting_approval",
    "waiting",
    // a binary that predates control-plane waits cannot parse this status, so
    // it refuses the run instead of settling the wait from the record
    "waiting_signal",
    "succeeded",
    "failed",
    "skipped",
    "unknown",
  ]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  output: z.unknown().optional(),
  dataArtifacts: z.array(DataArtifactRefSchema).optional(),
  allowedFailure: z.boolean().optional(),
  approvalDecision: ApprovalDecisionSchema.optional(),
  approvalPrompt: z.string().optional(),
  // the step run holds the gate timeout because a step expanded by forEach has
  // no step of its name in the definition
  approvalTimeout: z.number().positive().optional(),
  assertResult: AssertResultSchema.optional(),
  forEachTemplate: z.string().optional(),
  skipReason: StepSkipReasonSchema.optional(),
  resetByResume: z.boolean().optional(),
  failureKind: StepFailureKindSchema.optional(),
  settledByAbort: z.boolean().optional(),
  stoppedByAbort: z.boolean().optional(),
  // kept as read and validated in the domain, so a malformed value never makes
  // the run unloadable and is written back unchanged
  nestedRun: z.unknown().optional(),
  detachedNestedRun: z.boolean().optional(),
  // kept as read and validated in the domain (see parseStoredWait), as
  // nestedRun is
  wait: z.unknown().optional(),
});

export type StepRunData = z.infer<typeof StepRunSchema>;

const FanOutMemberRecordSchema = z.object({
  worker: z.string().min(1),
  instanceUuid: z.string().min(1),
  disposition: z.enum(["dispatch", "waiting", "skipped", "failed", "excluded"]),
  reason: z.enum(["disconnected", "unverified", "draining"]).optional(),
  // the index into batches; only members with a lane have one
  batch: z.number().int().nonnegative().optional(),
});

// always empty: lane steps live in the job's steps, where every run-record
// check sees them; kept because older readers require the key
const FanOutLaneRecordSchema = z.object({
  name: z.string().min(1),
  worker: z.string().min(1),
  instanceUuid: z.string().min(1),
  steps: z.array(StepRunSchema).max(0),
});

export const FanOutPlanRecordSchema = z.object({
  members: z.array(FanOutMemberRecordSchema),
  plannedLanes: z.number().int().nonnegative(),
  maxFailures: z.number().int().nonnegative().nullable(),
  batches: z.array(z.array(z.string().min(1))),
  lanes: z.array(FanOutLaneRecordSchema),
});

export type FanOutPlanRecordData = z.infer<typeof FanOutPlanRecordSchema>;

// outside the plan, so the frozen plan and older readers of it are unchanged
const FanOutSnapshotSchema = z.object({
  // the selector as authored, so a resume can tell an edited one
  selector: z.object({
    labels: z.record(z.string(), z.string()).optional(),
    platform: z.string().optional(),
  }).optional(),
  // self.worker at plan time, for a lane whose worker has left the pool
  workers: z.array(z.object({
    name: z.string().min(1),
    labels: z.record(z.string(), z.string()),
    platform: z.string(),
    arch: z.string(),
  })),
});

export type FanOutSnapshot = z.infer<typeof FanOutSnapshotSchema>;

// a halted rollout; batch is the first frozen batch that holds a held lane
const FanOutHaltSchema = z.object({
  batch: z.number().int().nonnegative(),
  maxFailures: z.number().int().nonnegative(),
  failed: z.array(z.string().min(1)),
  held: z.array(z.string().min(1)).min(1),
});

export type FanOutHalt = z.infer<typeof FanOutHaltSchema>;

export interface FanOutLaneRun {
  readonly name: string;
  readonly worker: string;
  readonly instanceUuid: string;
}

// what a step's dependsOn and cleanup rules read: a job, or one lane of it
export interface StepStatusView {
  getStatus(ref: string): RunStatus | undefined;
  skippedByGuard(ref: string): boolean;
}

export interface FanOutPlanRecord {
  readonly members: FanOutPlanRecordData["members"];
  readonly plannedLanes: number;
  readonly maxFailures: number | null;
  readonly batches: readonly (readonly string[])[];
  readonly lanes: readonly FanOutLaneRun[];
}

export function fanOutLaneName(jobName: string, worker: string): string {
  return `${jobName}[${worker}]`;
}

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
  fanOutPlan: FanOutPlanRecordSchema.optional(),
  fanOutSnapshot: FanOutSnapshotSchema.optional(),
  // one per halted attempt, appended as the job ends and never changed
  fanOutHalts: z.array(FanOutHaltSchema).optional(),
});

export type JobRunData = z.infer<typeof JobRunSchema>;

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
  // captured when a run suspends so post-resume steps can resolve inputs.*;
  // optional for runs persisted before this field existed
  inputs: InputRecordSchema.optional(),
  // key names only: values are deliberately not persisted, to keep secrets such
  // as a freshly minted auth key out of the plaintext run record
  resumeInputs: z.array(z.string()).optional(),
  // persisted so a direct resume can admit them as provenance; the child's own
  // YAML cannot reconstruct what a parent passed in unresolved
  inheritedExpressions: z.array(z.string()).optional(),
  deferredExpressions: z.array(DeferredExpressionSchema).optional(),
  // ranges and paths only, so a resume knows which input text came from the
  // caller
  inputsProvenance: ProvenanceMapDataSchema.optional(),
  // absent on older runs, which a typed resume treats fail-closed: an input
  // string holding a reference is whole data
  persistedInputsProvenance: ProvenanceMapDataSchema.optional(),
  // its steps ran the evaluated cache, whose source may differ from the
  // workflow on disk
  replayedEvaluatedCache: z.literal(true).optional(),
  initiatedBy: z.string().optional(),
  client: z.string().optional(),
  startKey: RunStartKeyDataSchema.optional(),
  instanceId: z.string().optional(),
  // pid and instanceId name the live process only while it runs, otherwise the
  // run's owner, which cancel routing and supersede read; kept while a resume
  // drives the run and restored when it leaves running
  ownerBeforeResume: z.object({
    pid: z.number().int().positive().optional(),
    instanceId: z.string().optional(),
  }).optional(),
  triggerSource: z.string().optional(),
  failedStep: z.string().optional(),
  failureReason: z.string().optional(),
  writtenReferences: z.array(WrittenReferenceSchema).optional(),
  sensitiveFormat: z.number().int().positive().optional(),
  stepProgress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).optional(),
  // derived on save: suspended with every approval gate decided, so waiting for
  // a resume rather than an approval
  awaitingResume: z.boolean().optional(),
  // the steps a recovery reset wait for someone to resume the run, so serve
  // does not continue it
  recovered: z.boolean().optional(),
  // a step start older than this belongs to an attempt the resume reset
  resumedAt: z.string().datetime().optional(),
  runPlan: z.object({
    fingerprint: z.string(),
    evaluatedWorkflowId: z.string().optional(),
    definitionFingerprint: z.string().optional(),
  }).optional(),
  parentRun: z.unknown().optional(),
  // a resume is held to this principal, never to the resumer
  triggeringPrincipal: TriggeringPrincipalSchema.optional(),
  // a resume is held to this list and the workflow's current one, so an edit
  // can narrow a suspended run but never widen it
  allowedVaults: z.array(z.string()).optional(),
});

export type WorkflowRunData = z.infer<typeof WorkflowRunSchema>;

export type WorkflowRunInput = z.input<typeof WorkflowRunSchema>;

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
    private _stoppedByAbort: boolean = false,
    private _errorCode: string | undefined = undefined,
  ) {}

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
      validated.stoppedByAbort ?? false,
      validated.errorCode,
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

  get errorCode(): string | undefined {
    return this._errorCode;
  }

  get output(): unknown {
    return this._output;
  }

  get dataArtifacts(): ReadonlyArray<DataArtifactRef> {
    return this._dataArtifacts;
  }

  get allowedFailure(): boolean {
    return this._allowedFailure;
  }

  get approvalDecision(): ApprovalDecisionData | undefined {
    return this._approvalDecision;
  }

  get approvalPrompt(): string | undefined {
    return this._approvalPrompt;
  }

  get approvalTimeout(): number | undefined {
    return this._approvalTimeout;
  }

  get assertResult(): AssertResultData | undefined {
    return this._assertResult;
  }

  get forEachTemplate(): string | undefined {
    return this._forEachTemplate;
  }

  get skipReason(): StepSkipReasonData | undefined {
    return this._skipReason;
  }

  /** persisted, so a resume that suspends again keeps it */
  get resetByResume(): boolean {
    return this._resetByResume;
  }

  get failureKind(): StepFailureKind | undefined {
    return this._failureKind;
  }

  /**
   * persisted: a resume resets such a step to pending and runs it, as if the
   * abort had left it pending
   */
  get settledByAbort(): boolean {
    return this._settledByAbort;
  }

  /**
   * the abort stopped its work so its outcome is ambiguous; persisted so
   * interrupting the run marks it unknown and a recovery reopens it
   */
  get stoppedByAbort(): boolean {
    return this._stoppedByAbort;
  }

  /** a malformed link reads as broken and is never followed */
  get nestedRun(): RunLink<NestedRunRef> | undefined {
    return this._nestedRun;
  }

  get isNestedWait(): boolean {
    return this._status === "waiting_approval" &&
      this._nestedRun !== undefined;
  }

  get detachedNestedRun(): boolean {
    return this._detachedNestedRun;
  }

  /** a malformed wait reads as undefined and never accepts a signal */
  get signalWait(): SignalWait | undefined {
    return this._wait?.kind === "valid" ? this._wait.wait : undefined;
  }

  get isSignalWait(): boolean {
    return this._status === "waiting_signal" || this._status === "waiting";
  }

  recordApprovalDecision(decision: ApprovalDecisionData): void {
    this._approvalDecision = decision;
  }

  recordAssertResult(result: AssertResultData): void {
    this._assertResult = result;
  }

  markAllowedFailure(): void {
    this._allowedFailure = true;
  }

  addDataArtifact(artifact: DataArtifactRef): void {
    this._dataArtifacts.push({ ...artifact });
  }

  resetToPending(): void {
    this._status = "pending";
    this._startedAt = undefined;
    this._completedAt = undefined;
    this._error = undefined;
    this._errorCode = undefined;
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
    this._stoppedByAbort = false;
    this._nestedRun = undefined;
    this._detachedNestedRun = false;
    this._wait = undefined;
  }

  /** a start that could not be committed never ran: the step is pending */
  revertUnrecordedStart(): void {
    if (this._status !== "running") return;
    this._status = "pending";
    this._startedAt = undefined;
  }

  markResetByResume(): void {
    this._resetByResume = true;
  }

  clearResetMarker(): void {
    this._resetByResume = false;
  }

  failStranded(): void {
    this.fail(STRANDED_STEP_ERROR);
    this._allowedFailure = false;
    this._failureKind = "workflow_changed";
  }

  failStoppedByAbort(error: string, code?: string): void {
    this.fail(error, code);
    this._stoppedByAbort = true;
  }

  cancelUnstarted(): void {
    this.fail(CANCELLED_STEP_ERROR);
    this._settledByAbort = true;
  }

  skipUnstarted(reason: StepSkipReasonData): void {
    this.skip(reason);
    this._settledByAbort = true;
  }

  cancelUndecidedApproval(): void {
    if (this._status !== "waiting_approval") return;
    this.fail(CANCELLED_STEP_ERROR);
    this._settledByAbort = true;
  }

  cancelOpenWait(): void {
    if (!this.isSignalWait) return;
    this.fail(CANCELLED_STEP_ERROR);
    this._settledByAbort = true;
  }

  waitForSignal(wait: SignalWait): void {
    this._status = "waiting_signal";
    this._resetByResume = false;
    this._wait = { kind: "valid", wait };
  }

  canApplyWaitOutcome(outcome: WaitOutcome): boolean {
    const wait = this.signalWait;
    if (!this.isSignalWait || !wait || outcome.waitId !== wait.id) return false;
    return outcome.kind !== "accepted" ||
      (outcome.receipt.waitId === wait.id &&
        wait.validatePayload(outcome.payload).valid);
  }

  /**
   * the outcome comes from a store other writers can reach, so its payload is
   * checked against the schema this step captured before it is kept
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
          // the wait keeps the receipt as stored while the output has the
          // documented shape
          signal: receiptForCaller(outcome.receipt),
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

  failUnreadableWait(): boolean {
    if (!this.isSignalWait || this.signalWait) return false;
    this.fail(WAIT_UNREADABLE_STEP_ERROR);
    return true;
  }

  /**
   * the outcome is written once, so nothing will ever settle the wait another
   * way
   */
  failUnusableOutcome(): boolean {
    if (!this.isSignalWait) return false;
    this.fail(WAIT_UNREADABLE_STEP_ERROR);
    return true;
  }

  start(at: Date = new Date()): void {
    this._status = "running";
    this._startedAt = at;
    this._resetByResume = false;
  }

  waitForApproval(prompt?: string, timeout?: number): void {
    this._status = "waiting_approval";
    this._resetByResume = false;
    if (prompt !== undefined) {
      this._approvalPrompt = prompt;
    }
    this._approvalTimeout = timeout;
  }

  waitForNestedRun(ref: NestedRunRef): void {
    this._status = "waiting_approval";
    this._resetByResume = false;
    this._nestedRun = { kind: "valid", ref: { ...ref } };
  }

  rejectNested(decision: ApprovalDecisionData, error: string): void {
    this._approvalDecision = { ...decision };
    this.fail(error);
  }

  detachNestedRun(error: string): void {
    this.fail(error);
    this._settledByAbort = true;
    this._detachedNestedRun = true;
  }

  succeed(output?: unknown): void {
    this._status = "succeeded";
    this._completedAt = new Date();
    this._resetByResume = false;
    if (output !== undefined) {
      this._output = output;
    }
  }

  fail(error: string, code?: string): void {
    this._status = "failed";
    this._completedAt = new Date();
    this._error = error;
    this._errorCode = code;
    this._resetByResume = false;
  }

  markUnknown(error?: string): void {
    this._status = "unknown";
    this._completedAt = new Date();
    this._resetByResume = false;
    if (error !== undefined) {
      this._error = error;
      this._errorCode = undefined;
    }
  }

  /**
   * reason is optional so older callers compile, but every production skip site
   * supplies one: a skip with no recorded cause is the ambiguity this field
   * removes
   */
  skip(reason?: StepSkipReasonData): void {
    this._status = "skipped";
    this._completedAt = new Date();
    this._resetByResume = false;
    if (reason !== undefined) {
      this._skipReason = { ...reason };
    }
  }

  toData(): StepRunData {
    const data: StepRunData = {
      stepName: this.stepName,
      status: this._status,
      startedAt: this._startedAt?.toISOString(),
      completedAt: this._completedAt?.toISOString(),
      error: this._error,
      output: this._output,
    };
    if (this._errorCode !== undefined) data.errorCode = this._errorCode;
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
    if (this._stoppedByAbort) {
      data.stoppedByAbort = true;
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

export class JobRun implements TriggerEvaluationContext {
  private _forEachMappings = new Map<string, readonly string[]>();

  constructor(
    readonly jobName: string,
    private _status: RunStatus,
    private _startedAt: Date | undefined,
    private _completedAt: Date | undefined,
    private _steps: StepRun[],
    private _fanOutPlan: FanOutPlanRecord | undefined = undefined,
    private _fanOutSnapshot: FanOutSnapshot | undefined = undefined,
    private _fanOutHalts: FanOutHalt[] = [],
  ) {}

  static pending(jobName: string, stepNames: string[]): JobRun {
    const steps = stepNames.map((name) => StepRun.pending(name));
    return new JobRun(jobName, "pending", undefined, undefined, steps);
  }

  static fromData(data: JobRunData): JobRun {
    const validated = JobRunSchema.parse(data);
    const steps = validated.steps.map((s) => StepRun.fromData(s));
    const plan = validated.fanOutPlan;
    return new JobRun(
      validated.jobName,
      validated.status,
      validated.startedAt ? new Date(validated.startedAt) : undefined,
      validated.completedAt ? new Date(validated.completedAt) : undefined,
      steps,
      plan && {
        members: plan.members,
        plannedLanes: plan.plannedLanes,
        maxFailures: plan.maxFailures,
        batches: plan.batches,
        lanes: plan.lanes.map((lane) => ({
          name: lane.name,
          worker: lane.worker,
          instanceUuid: lane.instanceUuid,
        })),
      },
      validated.fanOutSnapshot,
      validated.fanOutHalts ?? [],
    );
  }

  get fanOutHalts(): readonly FanOutHalt[] {
    return this._fanOutHalts;
  }

  /**
   * holds the lanes that never started, records the halt and fails the job in
   * one call, so no save between them can persist half a halt
   */
  haltFanOut(halt: FanOutHalt, heldSteps: readonly string[]): void {
    if (this._fanOutPlan === undefined) {
      throw new Error(`Job '${this.jobName}' has no fan-out plan to halt`);
    }
    const valid = FanOutHaltSchema.parse(halt);
    for (const name of heldSteps) {
      const step = this.getStep(name);
      if (step?.status !== "pending") {
        throw new Error(
          `Job '${this.jobName}' cannot hold step '${name}': it is ${
            step?.status ?? "missing"
          }`,
        );
      }
    }
    // job_skipped: a new skip reason would make older binaries refuse the
    // record; settledByAbort makes a resume reopen the lane
    for (const name of heldSteps) {
      this.getStep(name)!.skipUnstarted({ kind: "job_skipped" });
    }
    this._fanOutHalts.push(structuredClone(valid));
    this.fail();
  }

  get fanOutPlan(): FanOutPlanRecord | undefined {
    return this._fanOutPlan;
  }

  get fanOutSnapshot(): FanOutSnapshot | undefined {
    return this._fanOutSnapshot;
  }

  recordFanOutPlan(
    plan: Extract<FanOutPlan, { kind: "planned" }>,
    batches: readonly (readonly string[])[],
    snapshot?: FanOutSnapshot,
  ): void {
    if (this._fanOutPlan !== undefined) {
      throw new Error(`Job '${this.jobName}' already holds a fan-out plan`);
    }
    const batchOf = new Map<string, number>();
    batches.forEach((batch, index) => {
      for (const worker of batch) {
        if (batchOf.has(worker)) {
          throw new Error(
            `Fan-out plan for job '${this.jobName}' lists '${worker}' in more than one batch`,
          );
        }
        batchOf.set(worker, index);
      }
    });
    const workers = new Set<string>();
    for (const member of plan.members) {
      if (workers.has(member.worker)) {
        throw new Error(
          `Fan-out plan for job '${this.jobName}' lists '${member.worker}' more than once`,
        );
      }
      workers.add(member.worker);
    }
    const laned = new Map(
      plan.members.filter(hasLane).map((member) => [member.worker, member]),
    );
    for (const worker of laned.keys()) {
      if (!batchOf.has(worker)) {
        throw new Error(
          `Fan-out plan for job '${this.jobName}' has lane '${worker}' in no batch`,
        );
      }
    }
    this._fanOutPlan = {
      members: plan.members.map((member) => ({
        worker: member.worker,
        instanceUuid: member.instanceUuid,
        disposition: member.disposition,
        ...(member.reason !== undefined ? { reason: member.reason } : {}),
        ...(batchOf.has(member.worker) && hasLane(member)
          ? { batch: batchOf.get(member.worker) }
          : {}),
      })),
      plannedLanes: plan.plannedLanes,
      maxFailures: plan.maxFailures,
      batches: batches.map((batch) => [...batch]),
      lanes: batches.flat().flatMap((worker) => {
        const member = laned.get(worker);
        if (member === undefined) return [];
        return [{
          name: fanOutLaneName(this.jobName, worker),
          worker,
          instanceUuid: member.instanceUuid,
        }];
      }),
    };
    if (snapshot !== undefined) {
      this._fanOutSnapshot = FanOutSnapshotSchema.parse(snapshot);
    }
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
   * replaces the job's authored step records with its lanes' records; no
   * forEach template, so nothing groups lanes as iterations of one step
   */
  expandLanes(
    laneStepNames: readonly string[],
    gateStepNames: readonly string[] = [],
  ): void {
    if (this._fanOutPlan === undefined) {
      throw new Error(`Job '${this.jobName}' has no fan-out plan to expand`);
    }
    const started = this._steps.find((step) => step.status !== "pending");
    if (started !== undefined) {
      throw new Error(
        `Job '${this.jobName}' cannot expand its lanes: step '${started.stepName}' is already ${started.status}`,
      );
    }
    this._steps.splice(0, this._steps.length);
    for (const name of gateStepNames) this._steps.push(StepRun.pending(name));
    for (const name of laneStepNames) this._steps.push(StepRun.pending(name));
  }

  /**
   * decides a waiting gate as rejected, holds every lane with a step still to
   * run and fails the job in one call, so no save holds half a rejection
   */
  rejectFanOutGate(
    stepName: string,
    decision: ApprovalDecisionData,
    error: string,
  ): string[] {
    const plan = this._fanOutPlan;
    const gate = this.getStep(stepName);
    if (
      plan === undefined || fanOutGateOf(this.jobName, stepName) === undefined
    ) {
      throw new Error(
        `Step '${stepName}' is not an approval gate of fan-out job '${this.jobName}'`,
      );
    }
    if (gate?.status !== "waiting_approval") {
      throw new Error(
        `Gate '${stepName}' of job '${this.jobName}' is not waiting for a decision`,
      );
    }
    // worker names hold no brackets, so a suffix names at most one lane
    const lanes = new Map(
      plan.lanes.map((lane) => [
        lane.worker,
        this._steps.filter((step) =>
          step.stepName.length > lane.worker.length + 2 &&
          step.stepName.endsWith(`[${lane.worker}]`)
        ),
      ]),
    );
    const held = plan.batches.flat().filter((worker) =>
      (lanes.get(worker) ?? []).some((step) => step.status === "pending")
    );
    gate.recordApprovalDecision({ ...decision, approved: false });
    gate.fail(error);
    // job_skipped, as a budget halt holds them; the failed gate records why
    for (const worker of held) {
      for (const step of lanes.get(worker)!) {
        if (step.status === "pending") {
          step.skipUnstarted({ kind: "job_skipped" });
        }
      }
    }
    // a later gate is never reached, so it is held with the lanes
    for (const step of this._steps) {
      if (
        step.status === "pending" &&
        fanOutGateOf(this.jobName, step.stepName) !== undefined
      ) {
        step.skipUnstarted({ kind: "job_skipped" });
      }
    }
    this.fail();
    return held;
  }

  /** dependsOn and cleanup rules of a lane read only that lane's steps */
  laneView(laneStepOf: (authored: string) => string): StepStatusView {
    return {
      getStatus: (ref) => this.getStep(laneStepOf(ref))?.status,
      skippedByGuard: (ref) =>
        this.getStep(laneStepOf(ref))?.skipReason?.kind === "guarded",
    };
  }

  /**
   * for a forEach template name, aggregates the expanded steps: failed if any
   * failed, succeeded if all succeeded, skipped if all skipped, running if any
   * in progress
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

  getStep(name: string): StepRun | undefined {
    return this._steps.find((s) => s.stepName === name);
  }

  addExpandedStep(stepName: string): void {
    if (!this._steps.find((s) => s.stepName === stepName)) {
      this._steps.push(StepRun.pending(stepName));
    }
  }

  /**
   * called after forEach.in resolves so the persisted job reflects the steps
   * that will run; an existing replacement is left and only missing names
   * inserted; empty expansion removes the template
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
    // edit in place since callers may hold the steps array, and never spread
    // insertions into splice: a forEach can expand to more steps than fit in a
    // spread call
    const after = this._steps.splice(templateIndex);
    after.shift();
    for (const step of insertions) this._steps.push(step);
    for (const step of after) this._steps.push(step);
  }

  /**
   * the execution service registers this after every forEach expansion, resume
   * included, so the mapping need not be persisted
   */
  registerForEachExpansion(
    templateName: string,
    expandedNames: readonly string[],
  ): void {
    this._forEachMappings.set(templateName, expandedNames);
  }

  skippedByGuard(ref: string): boolean {
    const names = this.getStep(ref)
      ? [ref]
      : this._forEachMappings.get(ref) ?? [];
    return names.length > 0 &&
      names.every((name) => this.getStep(name)?.skipReason?.kind === "guarded");
  }

  /** a run loaded from storage has none until one is registered */
  hasForEachExpansion(templateName: string): boolean {
    return this._forEachMappings.has(templateName);
  }

  resetToPending(): void {
    this._status = "pending";
    this._startedAt = undefined;
    this._completedAt = undefined;
  }

  start(at: Date = new Date()): void {
    this._status = "running";
    this._startedAt = at;
  }

  succeed(): void {
    this._status = "succeeded";
    this._completedAt = new Date();
  }

  fail(): void {
    this._status = "failed";
    this._completedAt = new Date();
  }

  markUnknown(): void {
    this._status = "unknown";
    this._completedAt = new Date();
  }

  skip(): void {
    this._status = "skipped";
    this._completedAt = new Date();
    for (const step of this._steps) {
      if (step.status === "pending") {
        step.skip({ kind: "job_skipped" });
      }
    }
  }

  /**
   * a tracked reset step the current workflow does not produce, such as an
   * iteration dropped from a smaller collection, would otherwise stay pending
   * in a job reported succeeded
   */
  failStrandedResetSteps(): StepRun[] {
    const stranded = this._steps.filter((step) => step.resetByResume);
    for (const step of stranded) {
      step.failStranded();
    }
    return stranded;
  }

  /**
   * a step queued behind a concurrency limit never started and would stay
   * pending, so a failed or completed condition on it could never be met;
   * marked settledByAbort so a resume runs it
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

  skipNotStarted(): void {
    for (const step of this._steps) {
      if (step.status === "pending") {
        step.skipUnstarted({ kind: "job_skipped" });
      }
    }
    this.skip();
  }

  /**
   * while any step is still pending the job stays pending: nothing in it ran,
   * so a cancelled sibling is no evidence of failure; settled steps are marked
   * settledByAbort so a resume walks the job again
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
   * fails when a step failed without its failure being allowed, is unknown
   * while a step is unfinished since its outcome is ambiguous, else succeeds;
   * settled steps are marked settledByAbort
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

  get holdsAbortedWork(): boolean {
    return this._steps.some((step) => step.settledByAbort) ||
      (this._status === "unknown" &&
        this._steps.some((step) => step.status === "pending"));
  }

  toData(): JobRunData {
    const data: JobRunData = {
      jobName: this.jobName,
      status: this._status,
      startedAt: this._startedAt?.toISOString(),
      completedAt: this._completedAt?.toISOString(),
      steps: this._steps.map((s) => s.toData()),
    };
    const plan = this._fanOutPlan;
    if (plan !== undefined) {
      data.fanOutPlan = {
        members: plan.members.map((member) => ({ ...member })),
        plannedLanes: plan.plannedLanes,
        maxFailures: plan.maxFailures,
        batches: plan.batches.map((batch) => [...batch]),
        lanes: plan.lanes.map((lane) => ({
          name: lane.name,
          worker: lane.worker,
          instanceUuid: lane.instanceUuid,
          steps: [],
        })),
      };
    }
    if (this._fanOutSnapshot !== undefined) {
      data.fanOutSnapshot = structuredClone(this._fanOutSnapshot);
    }
    if (this._fanOutHalts.length > 0) {
      data.fanOutHalts = structuredClone(this._fanOutHalts);
    }
    return data;
  }
}

export interface FailedStepRef {
  jobName: string;
  stepName: string;
  forEachTemplate?: string;
  approvalRejected: boolean;
  failureKind?: StepFailureKind;
}

export interface StepRunRef {
  readonly jobName: string;
  readonly stepName: string;
}

/**
 * JSON quotes both names, so no character either holds (an evaluated job name
 * can hold any) makes two distinct pairs share a key
 */
export function stepRunKey(ref: StepRunRef): string {
  return JSON.stringify([ref.jobName, ref.stepName]);
}

export interface SignalWaitRef {
  readonly jobName: string;
  readonly stepName: string;
  readonly wait: SignalWait | undefined;
}

export interface NestedWaitRef {
  readonly jobName: string;
  readonly stepName: string;
  readonly link: RunLink<NestedRunRef>;
}

export interface DetachedNestedRunRef {
  readonly jobName: string;
  readonly stepName: string;
  readonly child: NestedRunRef;
}

/** a run with no instance id is owned by a local CLI process */
export interface RunOwner {
  readonly pid: number;
  readonly instanceId?: string;
}

export class WorkflowRun implements TriggerEvaluationContext {
  private _inputsProvenance: ProvenanceMap | undefined;
  private _persistedInputsProvenance: ProvenanceMap | undefined;
  private _replayedEvaluatedCache = false;
  private _resumedAt: Date | undefined;
  private _startKey: RunStartKeyData | undefined;

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
    private _client: string | undefined = undefined,
  ) {}

  /**
   * attached for the lifetime of the process driving the run and never
   * persisted
   */
  private _sensitiveValues: RunSensitiveValues | undefined = undefined;

  attachSensitiveValues(values: RunSensitiveValues): void {
    this._sensitiveValues = values;
  }

  /**
   * masks every recorded sensitive value and, in a typed run, every sentinel
   * issued, without reading it; the one display view the run events and run
   * view share
   */
  mask<T>(value: T): T {
    return (this._sensitiveValues?.masked(value) ?? value) as T;
  }

  maskedInputs(): Record<string, unknown> {
    return this.mask(this._inputs) as Record<string, unknown>;
  }

  get writtenReferences(): readonly WrittenReference[] {
    return this._writtenReferences;
  }

  get sensitiveFormat(): number | undefined {
    return this._sensitiveFormat;
  }

  /**
   * with the run's record attached, sensitive values at value positions are
   * written as the vault reference they came from; without one (a status-only
   * process) stored data and references are written back unchanged
   */
  toPersistedData(): WorkflowRunData {
    const data = this.toData();
    if (!this._sensitiveValues) return data;
    const {
      writtenReferences: _stale,
      sensitiveFormat: _format,
      persistedInputsProvenance: _staleMap,
      ...rest
    } = data;
    const form = toPersistedForm(rest, this._sensitiveValues);
    const inputReferences = form.writtenReferences
      .filter((reference) => reference.path[0] === "inputs")
      .map((reference) => ({ ...reference, path: reference.path.slice(1) }));
    const persistedInputsProvenance = this._inputsProvenance === undefined
      ? undefined
      : withWrittenReferenceRanges(
        alignProvenance(
          this._inputsProvenance,
          data.inputs ?? {},
          form.data.inputs ?? {},
          sentinelReferenceTextOf(this._sensitiveValues.sentinels),
        ),
        form.data.inputs ?? {},
        inputReferences,
      );
    return {
      ...form.data,
      ...(form.writtenReferences.length > 0
        ? { writtenReferences: form.writtenReferences }
        : {}),
      ...(persistedInputsProvenance
        ? { persistedInputsProvenance: persistedInputsProvenance.toData() }
        : {}),
      sensitiveFormat: SENSITIVE_FORMAT_VERSION,
    };
  }

  static create(
    workflow: Workflow,
    tags?: Record<string, string>,
    initiatedBy?: string,
    triggerSource?: string,
    client?: string,
    id: string = crypto.randomUUID(),
  ): WorkflowRun {
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
      undefined,
      undefined,
      [],
      [],
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      client,
    );
  }

  static fromData(data: WorkflowRunInput): WorkflowRun {
    const validated = WorkflowRunSchema.parse(data);
    const jobs = validated.jobs.map((j) => JobRun.fromData(j));

    const run = new WorkflowRun(
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
      validated.client,
    );
    run._replayedEvaluatedCache = validated.replayedEvaluatedCache === true;
    if (validated.resumedAt) run._resumedAt = new Date(validated.resumedAt);
    run._startKey = validated.startKey;
    if (validated.inputsProvenance) {
      run._inputsProvenance = ProvenanceMap.fromData(
        validated.inputsProvenance,
      );
    }
    if (validated.persistedInputsProvenance) {
      run._persistedInputsProvenance = ProvenanceMap.fromData(
        validated.persistedInputsProvenance,
      );
    }
    return run;
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

  get client(): string | undefined {
    return this._client;
  }

  get triggeringPrincipal(): RunTriggeringPrincipal | undefined {
    return this._triggeringPrincipal;
  }

  recordTriggeringPrincipal(principal: RunTriggeringPrincipal): void {
    this._triggeringPrincipal = structuredClone(principal);
  }

  /** a resume is held to this list as well as to the workflow's current one */
  get allowedVaults(): readonly string[] | undefined {
    return this._allowedVaults;
  }

  recordAllowedVaults(vaults: Iterable<string>): void {
    this._allowedVaults = [...vaults];
  }

  get startedAt(): Date | undefined {
    return this._startedAt;
  }

  get completedAt(): Date | undefined {
    return this._completedAt;
  }

  get startKey(): RunStartKeyData | undefined {
    return this._startKey;
  }

  recordStartKey(key: RunStartKeyData): void {
    this._startKey = key;
  }

  /** a run that failed before it started: a retry of its key starts afresh */
  clearStartKey(): void {
    this._startKey = undefined;
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

  get parentRun(): RunLink<ParentRunRef> | undefined {
    return this._parentRun;
  }

  recordParentRun(ref: ParentRunRef): void {
    this._parentRun = {
      kind: "valid",
      ref: { ...ref, ancestorWorkflowNames: [...ref.ancestorWorkflowNames] },
    };
  }

  get jobs(): ReadonlyArray<JobRun> {
    return this._jobs;
  }

  get workflowDataArtifacts(): ReadonlyArray<DataArtifactRef> {
    return this._workflowDataArtifacts;
  }

  addWorkflowDataArtifact(artifact: DataArtifactRef): void {
    this._workflowDataArtifacts.push({ ...artifact });
  }

  get logFile(): string | undefined {
    return this._logFile;
  }

  get tags(): Readonly<Record<string, string>> {
    return this._tags;
  }

  setLogFile(path: string): void {
    this._logFile = path;
  }

  getStatus(ref: string): RunStatus | undefined {
    return this._jobs.find((j) => j.jobName === ref)?.status;
  }

  getJob(name: string): JobRun | undefined {
    return this._jobs.find((j) => j.jobName === name);
  }

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

  get isCancellable(): boolean {
    return this._status === "pending" || this._status === "running" ||
      this._status === "suspended";
  }

  /**
   * no-ops unless cancellable so late cancellation signals cannot corrupt a
   * finalized run; unlike ModelOutput.markCancelled it does not throw on
   * terminal states
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
   * steps naming data a v3 commit refused fail, and so do their job and a
   * succeeded run, so the committed record names no refused data as a success;
   * a suspended or cancelled run keeps its status
   */
  failStepsNamingRefusedData(
    refused: readonly { readonly dataId: string; readonly version: number }[],
    reason: string,
  ): StepRun[] {
    const keys = new Set(refused.map((v) => `${v.dataId}@${v.version}`));
    const names = (artifacts: ReadonlyArray<DataArtifactRef>) =>
      artifacts.some((a) => keys.has(`${a.dataId}@${a.version}`));
    const failed: StepRun[] = [];
    for (const job of this._jobs) {
      // A step that already failed keeps its own error.
      const steps = job.steps.filter((step) =>
        step.status !== "failed" && names(step.dataArtifacts)
      );
      for (const step of steps) step.fail(reason);
      if (steps.length > 0 && job.status === "succeeded") job.fail();
      for (const step of steps) failed.push(step);
    }
    if (
      (failed.length > 0 || names(this._workflowDataArtifacts)) &&
      this._status === "succeeded"
    ) {
      this._status = "failed";
    }
    return failed;
  }

  recordCancelReason(reason: string): void {
    if (this._status !== "cancelled" || !reason) {
      return;
    }
    this._tags["cancel_reason"] = reason;
  }

  /**
   * a step the abort stopped in flight is already failed but as ambiguous as a
   * running one, so it is marked unknown too, and its job, so a recovery
   * reopens both
   */
  interrupt(reason: string): void {
    if (
      this._status === "succeeded" || this._status === "failed" ||
      this._status === "interrupted"
    ) {
      return;
    }
    for (const job of this._jobs) {
      let stopped = false;
      for (const step of job.steps) {
        if (step.status === "running") {
          step.markUnknown(`interrupted: ${reason}`);
        } else if (step.status === "failed" && step.stoppedByAbort) {
          step.markUnknown(`interrupted: ${reason}`);
          stopped = true;
        }
      }
      if (
        job.status === "running" ||
        (stopped && (job.status === "failed" || job.status === "succeeded"))
      ) {
        job.markUnknown();
      }
    }
    this._status = "interrupted";
    this._completedAt = new Date();
    this._tags["interrupt_reason"] = reason;
    this.releaseOwnership();
  }

  /**
   * a kill that beat the step-start save shows the in-flight step as pending,
   * so in a running job with no running step every pending step is marked
   * unknown and recovery asks before re-running it
   */
  interruptOrphaned(reason: string, starts: readonly StepStart[]): void {
    if (this._status === "running") {
      for (const { job, stepName } of this.#journalledStarts(starts)) {
        job.addExpandedStep(stepName);
        const step = job.getStep(stepName)!;
        if (step.status === "running") continue;
        step.markUnknown(`interrupted: ${reason} (start recorded)`);
        if (job.status !== "running") job.markUnknown();
      }
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
   * a step the journal shows started in this attempt reads running, whatever
   * the record holds; only a running job's steps start, so only a pending job
   * moves
   */
  applyStepStarts(starts: readonly StepStart[]): void {
    if (this._status !== "running") return;
    const attempt = this._resumedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const latest = new Map<string, StepStart>();
    for (const start of starts) {
      if (start.startedAt < attempt) continue;
      const key = JSON.stringify([start.jobName, start.stepName]);
      const kept = latest.get(key);
      if (kept === undefined || kept.startedAt < start.startedAt) {
        latest.set(key, start);
      }
    }
    for (
      const { job, stepName } of this.#journalledStarts([...latest.values()])
    ) {
      const start = latest.get(JSON.stringify([job.jobName, stepName]))!;
      job.addExpandedStep(stepName);
      const step = job.getStep(stepName)!;
      if (step.status !== "pending") step.resetToPending();
      step.start(new Date(start.startedAt));
      if (job.status === "pending") job.start(new Date(start.startedAt));
    }
  }

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
   * what workflow recover would ask to be acknowledged for this run as it
   * stands, without changing the run
   */
  unknownStepsIfOrphaned(starts: readonly StepStart[]): string[] {
    const ended = this._status === "succeeded" || this._status === "failed" ||
      this._status === "interrupted";
    const result: string[] = [];
    if (this._status === "running") {
      for (const { stepName } of this.#journalledStarts(starts)) {
        result.push(stepName);
      }
    }
    for (const job of this._jobs) {
      const startNotRecorded = this._status === "running" &&
        job.status === "running" &&
        !job.steps.some((step) => step.status === "running");
      for (const step of job.steps) {
        if (
          step.status === "unknown" ||
          (startNotRecorded && step.status === "pending") ||
          (!ended && step.status === "running") ||
          (!ended && step.status === "failed" && step.stoppedByAbort)
        ) {
          result.push(step.stepName);
        }
      }
    }
    return [...new Set(result)];
  }

  /** starts whose step the record shows pending, lacks, or holds from an older start */
  #journalledStarts(
    starts: readonly StepStart[],
  ): { readonly job: JobRun; readonly stepName: string }[] {
    const found: { job: JobRun; stepName: string }[] = [];
    if (starts.length === 0) return found;
    const seen = new Set<string>();
    // indexed once: a run with many steps is saved once per step
    const steps = new Map<string, Map<string, StepRun>>();
    for (const job of this._jobs) {
      steps.set(
        job.jobName,
        new Map(job.steps.map((step) => [step.stepName, step])),
      );
    }
    for (const start of starts) {
      if (start.runId !== this.id) continue;
      const job = this._jobs.find((other) => other.jobName === start.jobName);
      if (job === undefined) continue;
      const step = steps.get(job.jobName)?.get(start.stepName);
      const recorded = step === undefined ||
        step.status === "pending" ||
        (step.startedAt?.getTime() ?? Number.NEGATIVE_INFINITY) <
          start.startedAt;
      const key = JSON.stringify([start.jobName, start.stepName]);
      if (!recorded || seen.has(key)) continue;
      seen.add(key);
      found.push({ job, stepName: start.stepName });
    }
    return found;
  }

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
   * the reset steps had an unknown outcome, so only a resume someone asks for
   * runs them again: serve never continues such a run by itself
   */
  get awaitsResumeAfterRecovery(): boolean {
    return this._status === "suspended" && this._recovered;
  }

  /**
   * recovery compares the definition fingerprint, since the evaluated one also
   * changes with the run's inputs
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

  captureInputs(inputs: Record<string, unknown>): void {
    this._inputs = inputs;
  }

  suspend(inputs?: Record<string, unknown>): void {
    this._status = "suspended";
    if (inputs) {
      this._inputs = inputs;
    }
    this.releaseOwnership();
  }

  get inputs(): Readonly<Record<string, unknown>> {
    return this._inputs;
  }

  captureInheritedExpressions(expressions: Iterable<string>): void {
    this._inheritedExpressions = [...expressions];
  }

  captureInputsProvenance(provenance: ProvenanceMap): void {
    this._inputsProvenance = provenance;
  }

  recordReplayedEvaluatedCache(): void {
    this._replayedEvaluatedCache = true;
  }

  get replayedEvaluatedCache(): boolean {
    return this._replayedEvaluatedCache;
  }

  get inputsProvenance(): ProvenanceMap | undefined {
    return this._inputsProvenance;
  }

  get persistedInputsProvenance(): ProvenanceMap | undefined {
    return this._persistedInputsProvenance;
  }

  captureDeferredExpressions(expressions: readonly DeferredExpression[]): void {
    this._deferredExpressions = structuredClone([...expressions]);
  }

  get deferredExpressions(): readonly DeferredExpression[] {
    return this._deferredExpressions;
  }

  get inheritedExpressions(): ReadonlyArray<string> {
    return this._inheritedExpressions;
  }

  /** key names only, never values */
  get resumeInputs(): ReadonlyArray<string> {
    return this._resumeInputs;
  }

  /**
   * appends and de-duplicates so multiple resume cycles accumulate a complete
   * audit trail
   */
  recordResumeInputs(keys: string[]): void {
    for (const key of keys) {
      if (!this._resumeInputs.includes(key)) {
        this._resumeInputs.push(key);
      }
    }
  }

  resumeFromSuspended(owner: RunOwner): void {
    this._status = "running";
    this._completedAt = undefined;
    this._recovered = false;
    this._resumedAt = new Date();
    this.takeOwnership(owner);
  }

  resumeFromFailed(owner: RunOwner): void {
    this._status = "running";
    this._completedAt = undefined;
    this._resumedAt = new Date();
    this.takeOwnership(owner);
  }

  /**
   * the instance id is replaced, not merged, so a local resume of a
   * serve-started run clears it and cancel stops the resuming process; an owner
   * already kept aside is not replaced
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
   * a run that suspends again is cancelled and superseded as its original
   * owner's run, not as the resume's
   */
  private releaseOwnership(): void {
    if (this._ownerBeforeResume === undefined) return;
    this._pid = this._ownerBeforeResume.pid;
    this._instanceId = this._ownerBeforeResume.instanceId;
    this._ownerBeforeResume = undefined;
  }

  /**
   * a same-named record in another job is left alone since step names are
   * unique only within a job; a marked step still pending when its job finishes
   * is failed
   */
  resetForResumeFrom(
    stepsToReset: readonly StepRunRef[],
    tracked: readonly StepRunRef[] = [],
  ): void {
    const keys = new Set(stepsToReset.map(stepRunKey));
    for (const job of this._jobs) {
      let jobNeedsReset = false;
      for (const step of job.steps) {
        step.clearResetMarker();
        if (
          keys.has(
            stepRunKey({ jobName: job.jobName, stepName: step.stepName }),
          )
        ) {
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
   * resets abort-settled steps and the jobs holding them to pending so the
   * resume walks them as if the abort had left them pending; same-named records
   * in other jobs are left alone
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
   * the recorded allowedFailure already reflects allowFailure and the assertion
   * severity threshold in force when the run failed
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
   * a wait past its deadline or one that cannot be read is not open: a resume
   * settles it
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
   * changes only this run, since cancelling the children is the caller's
   * cascade; not called on interrupt, because an interrupted run is recovered
   * and keeps waiting
   */
  detachNestedWaits(): void {
    for (const job of this._jobs) {
      let detached = false;
      for (const step of job.steps) {
        if (!step.isNestedWait) continue;
        // the child's own state is not read here: it may have finished since
        // this run last looked
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
    // written even when nothing is data, so an absent map always means a run
    // recorded before provenance existed
    if (this._replayedEvaluatedCache) {
      data.replayedEvaluatedCache = true;
    }
    if (this._resumedAt) data.resumedAt = this._resumedAt.toISOString();
    if (this._startKey) data.startKey = { ...this._startKey };
    if (this._inputsProvenance) {
      data.inputsProvenance = this._inputsProvenance.toData();
    }
    if (this._persistedInputsProvenance) {
      data.persistedInputsProvenance = this._persistedInputsProvenance
        .toData();
    }
    if (this._initiatedBy !== undefined) {
      data.initiatedBy = this._initiatedBy;
    }
    if (this._client !== undefined) {
      data.client = this._client;
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
   * a wait past its deadline still counts as waiting; whether a nested wait's
   * child finished is derived from the child, never stored here
   */
  isAwaitingResume(): boolean {
    return this._status === "suspended" &&
      this.findWaitingApprovalStep() === undefined &&
      this.findNestedWaits().length === 0 &&
      this.findSignalWaits().length === 0;
  }

  /**
   * a step settled by the run's end without running reports the end, not why it
   * ended, so it is named only when no other step failed
   */
  failureInfo(): {
    failedStep: string | undefined;
    failureReason: string | undefined;
  } {
    let settled: StepRun | undefined;
    for (const job of this._jobs) {
      for (const step of job.steps) {
        // a step detached when the run ended reports the run's end, not why it
        // ended
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

/**
 * only serve records a triggering principal or an owning instance, so either
 * marks a run gates bind on and no member writes
 */
export function isServeDrivenRun(
  run: { readonly triggeringPrincipal?: unknown; readonly instanceId?: string },
): boolean {
  return run.triggeringPrincipal !== undefined || run.instanceId !== undefined;
}

/**
 * a record serve drives or that holds a decision: deleting it would let a
 * forwarded first record under the same id drop the marker or the decision
 */
export function isGuardedRunRecord(
  run: Pick<WorkflowRunData, "triggeringPrincipal" | "instanceId" | "jobs">,
): boolean {
  return isServeDrivenRun(run) ||
    run.jobs.some((job) =>
      job.steps.some((step) => step.approvalDecision !== undefined)
    );
}
