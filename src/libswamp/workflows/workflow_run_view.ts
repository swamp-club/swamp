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

import type { ReportResultView } from "../models/model_method_run_view.ts";
import type { AssertSeverity } from "../../domain/workflows/step_task.ts";

export interface StepArtifactsData {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  dataAttributes?: Record<string, unknown>;
}

export interface DataArtifactRefData {
  dataId: string;
  name: string;
  version: number;
  tags: Record<string, string>;
  attributes?: Record<string, unknown>;
  /** content left out: the run's attribute budget was spent */
  attributesOmitted?: true;
}

export interface AssertResultView {
  passed: boolean;
  expr: string;
  message: string;
  severity: AssertSeverity;
  error?: string;
}

export interface ApprovalView {
  status: "approved" | "rejected" | "timed_out";
  approvedBy?: string;
  /** set when serve knew the decider's username; approvedBy keeps the id */
  approvedByUsername?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedByUsername?: string;
  rejectedAt?: string;
  timeoutAt?: string;
  reason?: string;
  approvalDuration?: number;
  client?: string;
}

/**
 * mirrors the domain's StepSkipReasonData; present only on skipped steps, and
 * absent on runs recorded before skip reasons existed
 */
export interface StepSkipReasonView {
  kind: "dependency" | "guarded" | "job_skipped";
  expression?: string;
}

export interface StepRunView {
  name: string;
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "waiting"
    | "succeeded"
    | "failed"
    | "skipped"
    | "unknown";
  error?: string;
  errorCode?: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  outputId?: string;
  artifacts?: StepArtifactsData;
  dataArtifacts?: DataArtifactRefData[];
  allowedFailure?: boolean;
  assertResult?: AssertResultView;
  approval?: ApprovalView;
  outputs?: Record<string, unknown>;
  /** outputs merge only the resources read within the run's attribute budget */
  outputsPartial?: true;
  skipReason?: StepSkipReasonView;
  /**
   * Set when the failure is structural. `workflow_changed`: a failed-run
   * resume reset the step and its job finished without running it; start a
   * new run.
   */
  failureKind?: "workflow_changed";
  /**
   * on a nested workflow step: the child run it started and, while
   * `waiting_approval`, waits on; `detached` when the run ended while the step
   * still waited and left the child suspended
   */
  nestedRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    detached?: true;
  };
  wait?: SignalWaitView;
}

export interface SignalWaitView {
  id: string;
  deadline: string;
  key?: string;
  receipt?: {
    id: string;
    waitId: string;
    receivedAt: string;
    submittedBy: string;
    /**
     * set when the signal arrived before the wait opened and was held as its
     * key's pending signal until the wait took it; the run view is the one
     * place that shows it
     */
    heldAsPending?: true;
  };
}

export interface FanOutMemberRunView {
  worker: string;
  disposition: string;
  reason?: string;
  batch?: number;
  lane?: "succeeded" | "failed" | "held" | "running" | "unknown" | "not_run";
  failedSteps?: { step: string; error?: string }[];
  assertions?: { step: string; severity: string; message: string }[];
}

export type FanOutHaltRunView =
  | {
    reason: "budget";
    batch: number;
    maxFailures: number;
    failed: string[];
    held: string[];
  }
  | { reason: "gate_rejected"; gate: "plan" | "canary"; held: string[] };

export interface FanOutGateRunView {
  kind: "plan" | "canary";
  step: string;
  status:
    | "pending"
    | "waiting"
    | "expired"
    | "approved"
    | "rejected"
    | "held"
    | "failed";
  expiredAt?: string;
  approval?: ApprovalView;
}

/** a fan-out job rebuilt from the run record; no instance UUIDs */
export interface FanOutRunView {
  selector: { labels?: Record<string, string>; platform?: string };
  /** absent when the run's evaluated workflow is gone */
  policy?: { offline: string; minWorkers: number };
  plannedLanes: number;
  batches: string[][];
  budget: { allowed: number | null; used: number };
  members: FanOutMemberRunView[];
  halts: FanOutHaltRunView[];
  gates: FanOutGateRunView[];
  /** the latest resume only; the record holds no earlier ones */
  resume?: { at: string; rerun: string[]; kept: string[] };
}

export interface JobRunView {
  name: string;
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "waiting"
    | "succeeded"
    | "failed"
    | "skipped"
    | "unknown";
  steps: StepRunView[];
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  /** set by history get on a job that holds a fan-out plan */
  fanOut?: FanOutRunView;
}

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  workflowName: string;
  inputs?: Record<string, unknown>;
  status:
    | "pending"
    | "running"
    | "suspended"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted";
  jobs: JobRunView[];
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  path?: string;
  reports?: ReportResultView[];
  workflowDataArtifacts?: DataArtifactRefData[];
  initiatedBy?: string;
  /** set when serve knew the initiator's username; initiatedBy keeps the id */
  initiatedByUsername?: string;
  client?: string;
  references?: Record<string, string>;
  parentRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
  };
  inheritedPlacement?: {
    target?: string;
    labels?: Record<string, string>;
    platform?: string;
    source: { workflowName: string; jobName: string; stepName: string };
  };
  nestedWaits?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
    status?: string;
  }[];
  /**
   * Derived: the run is suspended, no gate of its own waits, and every
   * nested run it waits on has finished, so it can be resumed.
   */
  awaitingResume?: boolean;
  /** why the run stopped, while it is interrupted */
  interruptReason?: string;
  /**
   * a planned restart stopped it between steps (status stays interrupted);
   * serve continues it under the same id with nothing to re-run
   */
  parked?: boolean;
  /** serve's last automatic continuation of the run, or its refusal */
  autoContinuation?: {
    count: number;
    continuedAt?: string;
    interruptReason?: string;
    resetSteps?: string[];
    refused?: {
      at: string;
      reason: string;
      steps: string[];
      message: string;
    };
  };
}

export function extractFirstStepError(run: WorkflowRunView): string {
  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (step.status === "failed" && !step.allowedFailure && step.error) {
        return step.error;
      }
    }
  }
  return "unknown error";
}
