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
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  timeoutAt?: string;
  reason?: string;
  approvalDuration?: number;
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
  references?: Record<string, string>;
  parentRun?: {
    workflowId: string;
    workflowName: string;
    runId: string;
    stepName: string;
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
