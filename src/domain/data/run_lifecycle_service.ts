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

import type { WorkflowRunRepository } from "../workflows/repositories.ts";
import type { OutputRepository } from "../models/repositories.ts";

export const DEFAULT_WORKFLOW_RUN_RETENTION_DAYS = 30;
export const DEFAULT_OUTPUT_RETENTION_DAYS = 30;

export interface RunGcResult {
  workflowRunsDeleted: number;
  workflowRunBytesReclaimed: number;
  outputsDeleted: number;
  outputBytesReclaimed: number;
  dryRun: boolean;
}

export interface RunLifecycleService {
  gcWorkflowRuns(options: {
    retentionDays: number;
    dryRun: boolean;
  }): Promise<{ deleted: number; bytesReclaimed: number }>;

  gcOutputs(options: {
    retentionDays: number;
    dryRun: boolean;
  }): Promise<{ deleted: number; bytesReclaimed: number }>;

  gcAll(options: {
    workflowRunRetentionDays: number;
    outputRetentionDays: number;
    dryRun: boolean;
  }): Promise<RunGcResult>;
}

export class DefaultRunLifecycleService implements RunLifecycleService {
  constructor(
    private readonly workflowRunRepo: WorkflowRunRepository,
    private readonly outputRepo: OutputRepository,
  ) {}

  async gcWorkflowRuns(options: {
    retentionDays: number;
    dryRun: boolean;
  }): Promise<{ deleted: number; bytesReclaimed: number }> {
    const cutoffMs = Date.now() - options.retentionDays * 86_400_000;
    return await this.workflowRunRepo.deleteOlderThan(new Date(cutoffMs), {
      dryRun: options.dryRun,
    });
  }

  async gcOutputs(options: {
    retentionDays: number;
    dryRun: boolean;
  }): Promise<{ deleted: number; bytesReclaimed: number }> {
    const cutoffMs = Date.now() - options.retentionDays * 86_400_000;
    return await this.outputRepo.deleteOlderThan(new Date(cutoffMs), {
      dryRun: options.dryRun,
    });
  }

  async gcAll(options: {
    workflowRunRetentionDays: number;
    outputRetentionDays: number;
    dryRun: boolean;
  }): Promise<RunGcResult> {
    const [workflowRuns, outputs] = await Promise.all([
      this.gcWorkflowRuns({
        retentionDays: options.workflowRunRetentionDays,
        dryRun: options.dryRun,
      }),
      this.gcOutputs({
        retentionDays: options.outputRetentionDays,
        dryRun: options.dryRun,
      }),
    ]);

    return {
      workflowRunsDeleted: workflowRuns.deleted,
      workflowRunBytesReclaimed: workflowRuns.bytesReclaimed,
      outputsDeleted: outputs.deleted,
      outputBytesReclaimed: outputs.bytesReclaimed,
      dryRun: options.dryRun,
    };
  }
}
