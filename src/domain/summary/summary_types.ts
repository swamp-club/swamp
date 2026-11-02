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

export interface DataRepositoryReader {
  findAllGlobal(): Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >;

  /**
   * prefer over findAllGlobal when the caller has a time bound; implementations
   * may short-circuit the scan
   */
  findAllGlobalSince(
    cutoff: Date,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>>;
}

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
 * runs may be capped by --limit, which sets truncated: true; counts always
 * reflect every matching run in the window; truncated is omitted when nothing
 * was cut
 */
export interface MethodGroup {
  method: string;
  succeeded: number;
  failed: number;
  total: number;
  runs: MethodRunDetail[];
  truncated?: boolean;
}

export interface ModelExecutionGroup {
  modelName: string;
  type: string;
  succeeded: number;
  failed: number;
  total: number;
  methods: MethodGroup[];
}

export interface StepRunSummary {
  jobName: string;
  stepName: string;
  modelName?: string;
  status: string;
  durationMs?: number;
  error?: string;
}

export interface WorkflowRunDetail {
  id: string;
  startedAt?: string;
  completedAt?: string;
  status: string;
  firstFailedStep?: string;
  steps: StepRunSummary[];
}

export interface WorkflowRunGroup {
  workflowName: string;
  succeeded: number;
  failed: number;
  total: number;
  runs: WorkflowRunDetail[];
  truncated?: boolean;
}

export interface DataModelGroup {
  modelType: string;
  items: number;
  versions: number;
}

export interface DataSummary {
  totalItems: number;
  totalVersions: number;
  uniqueModels: number;
  byModelType: DataModelGroup[];
}

export interface ActivitySummary {
  since: string;
  methodExecutions: ModelExecutionGroup[];
  workflows: WorkflowRunGroup[];
  data: DataSummary;
}
