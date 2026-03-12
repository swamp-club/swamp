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
}

export interface StepRunView {
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  error?: string;
  duration?: number;
  /** Output ID if this step produced an output (for model methods) */
  outputId?: string;
  /** Step artifacts included when --verbose is set */
  artifacts?: StepArtifactsData;
  /** Data artifacts produced by this step */
  dataArtifacts?: DataArtifactRefData[];
  /** Whether this step's failure was allowed (did not fail the job) */
  allowedFailure?: boolean;
}

export interface JobRunView {
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  steps: StepRunView[];
  duration?: number;
}

export interface WorkflowRunView {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "pending" | "running" | "succeeded" | "failed";
  jobs: JobRunView[];
  duration?: number;
  path?: string;
}
