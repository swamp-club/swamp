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

import type {
  RunSnapshotRepository,
  WorkflowRunRepository,
} from "../workflows/repositories.ts";
import type { OutputRepository } from "../models/repositories.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["swamp", "domain", "data", "run-lifecycle"]);

export const DEFAULT_WORKFLOW_RUN_RETENTION_DAYS = 30;
export const DEFAULT_OUTPUT_RETENTION_DAYS = 30;

/**
 * Minimum age before a snapshot with no run record counts as an orphan,
 * whatever the retention. A snapshot is written before its run record's
 * first save, so a very short `--older-than` must not sweep a starting run's
 * snapshot.
 */
export const MIN_ORPHAN_SNAPSHOT_AGE_MS = 60 * 60 * 1000;

export interface RunGcResult {
  workflowRunsDeleted: number;
  workflowRunBytesReclaimed: number;
  outputsDeleted: number;
  outputBytesReclaimed: number;
  snapshotsDeleted: number;
  snapshotBytesReclaimed: number;
  dryRun: boolean;
}

export interface RunLifecycleService {
  gcWorkflowRuns(options: {
    retentionDays: number;
    dryRun: boolean;
  }): Promise<
    { deleted: number; bytesReclaimed: number; deletedRunIds?: string[] }
  >;

  gcOutputs(options: {
    retentionDays: number;
    dryRun: boolean;
  }): Promise<{ deleted: number; bytesReclaimed: number }>;

  gcRunSnapshots(options: {
    retentionDays: number;
    deletedRunIds: readonly string[];
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
    private readonly runSnapshotRepo: RunSnapshotRepository,
    private readonly listRunIds: () => Promise<ReadonlySet<string>>,
  ) {}

  async gcWorkflowRuns(options: {
    retentionDays: number;
    dryRun: boolean;
  }): Promise<
    { deleted: number; bytesReclaimed: number; deletedRunIds?: string[] }
  > {
    const cutoffMs = Date.now() - options.retentionDays * 86_400_000;
    return await this.workflowRunRepo.deleteOlderThan(new Date(cutoffMs), {
      dryRun: options.dryRun,
    });
  }

  /**
   * Collects per-run evaluated-workflow snapshots. A snapshot is collected
   * when its run was just garbage-collected (`deletedRunIds`), or when no run
   * record exists for it and it is older than both the retention cutoff and
   * {@link MIN_ORPHAN_SNAPSHOT_AGE_MS}. The age guard matters: a snapshot is
   * written before its run record's first save, so a snapshot with no run
   * record may belong to a run that is starting.
   */
  async gcRunSnapshots(options: {
    retentionDays: number;
    deletedRunIds: readonly string[];
    dryRun: boolean;
  }): Promise<{ deleted: number; bytesReclaimed: number }> {
    const now = Date.now();
    const cutoffMs = Math.min(
      now - options.retentionDays * 86_400_000,
      now - MIN_ORPHAN_SNAPSHOT_AGE_MS,
    );
    const collectedRuns = new Set(options.deletedRunIds);
    const snapshots = await this.runSnapshotRepo.listRunSnapshots();
    if (snapshots.length === 0) return { deleted: 0, bytesReclaimed: 0 };
    const existingRuns = await this.listRunIds();

    let deleted = 0;
    let bytesReclaimed = 0;
    for (const snapshot of snapshots) {
      const orphaned = !existingRuns.has(snapshot.runId) &&
        snapshot.modifiedAt.getTime() < cutoffMs;
      if (!collectedRuns.has(snapshot.runId) && !orphaned) continue;
      if (!options.dryRun) {
        await this.runSnapshotRepo.deleteForRun(snapshot.runId);
      }
      deleted++;
      bytesReclaimed += snapshot.sizeBytes;
    }
    return { deleted, bytesReclaimed };
  }

  async gcOutputs(options: {
    retentionDays: number;
    dryRun: boolean;
  }): Promise<{ deleted: number; bytesReclaimed: number }> {
    const cutoffMs = Date.now() - options.retentionDays * 86_400_000;
    return await this.outputRepo.deleteByMethodLifetime(new Date(cutoffMs), {
      dryRun: options.dryRun,
    });
  }

  async gcAll(options: {
    workflowRunRetentionDays: number;
    outputRetentionDays: number;
    dryRun: boolean;
  }): Promise<RunGcResult> {
    const [[workflowRuns, snapshots], outputs] = await Promise.all([
      (async () => {
        const runs = await this.gcWorkflowRuns({
          retentionDays: options.workflowRunRetentionDays,
          dryRun: options.dryRun,
        });
        // Runs first: the snapshot pass needs the IDs of the runs collected.
        // A failing snapshot pass must not fail a run collection that already
        // happened; any snapshots left behind are swept as orphans later.
        let snaps = { deleted: 0, bytesReclaimed: 0 };
        try {
          snaps = await this.gcRunSnapshots({
            retentionDays: options.workflowRunRetentionDays,
            deletedRunIds: runs.deletedRunIds ?? [],
            dryRun: options.dryRun,
          });
        } catch (error) {
          logger
            .warn`Run snapshot cleanup failed; leftover snapshots are collected by a later run gc: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        return [runs, snaps] as const;
      })(),
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
      snapshotsDeleted: snapshots.deleted,
      snapshotBytesReclaimed: snapshots.bytesReclaimed,
      dryRun: options.dryRun,
    };
  }
}
