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

/**
 * Read-model projections of workflow run domain aggregates.
 * These are presentation-oriented views with computed fields (duration, path, artifacts).
 * Named "View" to avoid collision with the domain persistence types in workflow_run.ts.
 */

/**
 * Artifact data included when --verbose is set.
 */
export interface StepArtifactsData {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  dataAttributes?: Record<string, unknown>;
}

/**
 * Reference to a Data artifact produced by a step.
 */
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

export interface StepRunView {
  name: string;
  status:
    | "pending"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "skipped"
    | "unknown";
  error?: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  /** Output ID if this step produced an output (for model methods) */
  outputId?: string;
  /** Step artifacts included when --verbose is set */
  artifacts?: StepArtifactsData;
  /** Data artifacts produced by this step */
  dataArtifacts?: DataArtifactRefData[];
  /** Whether this step's failure was allowed (did not fail the job) */
  allowedFailure?: boolean;
  /** Assert result if this step is an assert task */
  assertResult?: AssertResultView;
  /** Approval decision metadata for manual_approval steps */
  approval?: ApprovalView;
  /** Step outputs (resource attributes from model methods) */
  outputs?: Record<string, unknown>;
}

export interface JobRunView {
  name: string;
  status:
    | "pending"
    | "running"
    | "waiting_approval"
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
  /** Data artifacts produced at workflow scope (e.g. workflow-scope reports). */
  workflowDataArtifacts?: DataArtifactRefData[];
  initiatedBy?: string;
  /** Optional metadata linking the run to external systems. */
  references?: Record<string, string>;
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
