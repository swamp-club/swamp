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

import type { Data } from "../data/data.ts";
import type { ModelType } from "../models/model_type.ts";

/**
 * Minimal read-only interface for data repository access in summaries.
 * Defined at the domain level to avoid importing from infrastructure.
 */
export interface DataRepositoryReader {
  findAllGlobal(): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >;

  /**
   * Finds all data items whose `createdAt` is at or after the given cutoff.
   * Prefer this over `findAllGlobal()` when the caller has a time bound;
   * implementations may short-circuit the underlying scan and skip work that
   * `findAllGlobal()` would do unconditionally.
   */
  findAllGlobalSince(
    cutoff: Date,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>>;
}

/**
 * Detail for a single method execution run.
 */
export interface MethodRunDetail {
  id: string;
  definitionId: string;
  startedAt: string;
  durationMs?: number;
  status: string;
  error?: string;
  triggeredBy: string;
}

/**
 * A group of runs for a single method on a model.
 *
 * `runs` may be capped by an opt-in `--limit` flag; when that happens the
 * group sets `truncated: true` so consumers can tell the detail list was
 * shortened. Counts (`succeeded`, `failed`, `total`) always reflect every
 * matching run in the window — `truncated` only signals that `runs` does
 * not. The field is omitted when no truncation occurred.
 */
export interface MethodGroup {
  method: string;
  succeeded: number;
  failed: number;
  total: number;
  runs: MethodRunDetail[];
  truncated?: boolean;
}

/**
 * A model's method execution activity, grouped by method.
 */
export interface ModelExecutionGroup {
  modelName: string;
  type: string;
  succeeded: number;
  failed: number;
  total: number;
  methods: MethodGroup[];
}

/**
 * Detail for a step within a workflow run.
 */
export interface StepRunSummary {
  jobName: string;
  stepName: string;
  modelName?: string;
  status: string;
  durationMs?: number;
  error?: string;
}

/**
 * Detail for a single workflow run.
 */
export interface WorkflowRunDetail {
  id: string;
  startedAt?: string;
  completedAt?: string;
  status: string;
  firstFailedStep?: string;
  steps: StepRunSummary[];
}

/**
 * A group of workflow runs for a given workflow name.
 *
 * `runs` may be capped by an opt-in `--limit` flag; when that happens the
 * group sets `truncated: true` so consumers can tell the detail list was
 * shortened. Counts (`succeeded`, `failed`, `total`) always reflect every
 * matching run in the window. The field is omitted when no truncation
 * occurred.
 */
export interface WorkflowRunGroup {
  workflowName: string;
  succeeded: number;
  failed: number;
  total: number;
  runs: WorkflowRunDetail[];
  truncated?: boolean;
}

/**
 * Data grouped by model type for the summary breakdown.
 */
export interface DataModelGroup {
  modelType: string;
  items: number;
  versions: number;
}

/**
 * Summary of data produced in the time window.
 */
export interface DataSummary {
  totalItems: number;
  totalVersions: number;
  uniqueModels: number;
  byModelType: DataModelGroup[];
}

/**
 * Top-level activity summary for a repo over a time window.
 */
export interface ActivitySummary {
  since: string;
  methodExecutions: ModelExecutionGroup[];
  workflows: WorkflowRunGroup[];
  data: DataSummary;
}
