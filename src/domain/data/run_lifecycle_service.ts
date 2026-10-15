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
  /**
   * True when the run or output collection stopped at its `limit` with more
   * left to collect; a later call continues where this one stopped.
   */
  more: boolean;
}

export interface RunLifecycleService {
  gcWorkflowRuns(options: {
    retentionDays: number;
    dryRun: boolean;
    limit?: number;
  }): Promise<
    {
      deleted: number;
      bytesReclaimed: number;
      deletedRunIds?: string[];
      more?: boolean;
    }
  >;

  gcOutputs(options: {
    retentionDays: number;
    dryRun: boolean;
    limit?: number;
  }): Promise<{ deleted: number; bytesReclaimed: number; more?: boolean }>;

  gcRunSnapshots(options: {
    retentionDays: number;
    deletedRunIds: readonly string[];
    dryRun: boolean;
    snapshotRetentionDays?: number;
  }): Promise<{ deleted: number; bytesReclaimed: number }>;

  gcAll(options: {
    workflowRunRetentionDays: number;
    outputRetentionDays: number;
    dryRun: boolean;
    /** Most runs, and most outputs, one call collects. */
    limit?: number;
    /** How long a finished run's evaluated snapshot is kept. */
    snapshotRetentionDays?: number;
  }): Promise<RunGcResult>;
}

export class DefaultRunLifecycleService implements RunLifecycleService {
  constructor(
    private readonly workflowRunRepo: WorkflowRunRepository,
    private readonly outputRepo: OutputRepository,
    private readonly runSnapshotRepo: RunSnapshotRepository,
    private readonly listRunIds: () => Promise<ReadonlySet<string>>,
    /**
     * Removes the signal wait records of the runs a collection deleted, so
     * an outcome never outlives its run (swamp-club#3093). Absent where the
     * datastore holds no wait records.
     */
    private readonly collectWaitRecords?: (
      deletedRunIds: readonly string[],
    ) => Promise<void>,
    /**
     * The IDs of the stored runs that have finished (succeeded, failed or
     * cancelled). Read only when a snapshot retention is given; absent, no
     * snapshot of an existing run is removed before its run.
     */
    private readonly listTerminalRunIds?: () => Promise<
      ReadonlyMap<string, number | undefined>
    >,
  ) {}

  async gcWorkflowRuns(options: {
    retentionDays: number;
    dryRun: boolean;
    limit?: number;
  }): Promise<
    {
      deleted: number;
      bytesReclaimed: number;
      deletedRunIds?: string[];
      more?: boolean;
    }
  > {
    const cutoffMs = Date.now() - options.retentionDays * 86_400_000;
    return await this.workflowRunRepo.deleteOlderThan(
      new Date(cutoffMs),
      options.limit === undefined
        ? { dryRun: options.dryRun }
        : { dryRun: options.dryRun, limit: options.limit },
    );
  }

  /**
   * Collects per-run evaluated-workflow snapshots. A snapshot is collected
   * when its run was just garbage-collected (`deletedRunIds`), or when no run
   * record exists for it and it is older than both the retention cutoff and
   * {@link MIN_ORPHAN_SNAPSHOT_AGE_MS}. The age guard matters: a snapshot is
   * written before its run record's first save, so a snapshot with no run
   * record may belong to a run that is starting.
   *
   * With `snapshotRetentionDays`, the snapshot of an existing run is also
   * collected once it is older than that retention, but only when the run
   * has finished (succeeded, failed or cancelled): cancel, reject and orphan
   * settlement read the snapshot of a run that has not.
   */
  async gcRunSnapshots(options: {
    retentionDays: number;
    deletedRunIds: readonly string[];
    dryRun: boolean;
    snapshotRetentionDays?: number;
  }): Promise<{ deleted: number; bytesReclaimed: number }> {
    const now = Date.now();
    const cutoffMs = Math.min(
      now - options.retentionDays * 86_400_000,
      now - MIN_ORPHAN_SNAPSHOT_AGE_MS,
    );
    const snapshotCutoffMs = options.snapshotRetentionDays === undefined
      ? undefined
      : now - options.snapshotRetentionDays * 86_400_000;
    const collectedRuns = new Set(options.deletedRunIds);
    const snapshots = await this.runSnapshotRepo.listRunSnapshots();
    if (snapshots.length === 0) return { deleted: 0, bytesReclaimed: 0 };
    const existingRuns = await this.listRunIds();
    // Read run statuses only when some snapshot is old enough to need one.
    const finishedRuns = snapshotCutoffMs !== undefined &&
        this.listTerminalRunIds !== undefined &&
        snapshots.some((snapshot) =>
          snapshot.modifiedAt.getTime() < snapshotCutoffMs
        )
      ? await this.listTerminalRunIds()
      : new Map<string, number | undefined>();

    let deleted = 0;
    let bytesReclaimed = 0;
    for (const snapshot of snapshots) {
      const modifiedMs = snapshot.modifiedAt.getTime();
      const orphaned = !existingRuns.has(snapshot.runId) &&
        modifiedMs < cutoffMs;
      // A snapshot is written when its run starts; a run suspended for long
      // finishes much later, so its snapshot is aged from whichever is
      // later, never before the run itself finished.
      const finishedAt = finishedRuns.get(snapshot.runId);
      const expired = snapshotCutoffMs !== undefined &&
        existingRuns.has(snapshot.runId) && finishedRuns.has(snapshot.runId) &&
        Math.max(modifiedMs, finishedAt ?? modifiedMs) < snapshotCutoffMs;
      if (!collectedRuns.has(snapshot.runId) && !orphaned && !expired) {
        continue;
      }
      if (!options.dryRun) {
        await this.runSnapshotRepo.deleteForRun(snapshot.runId);
      }
      deleted++;
      bytesReclaimed += snapshot.sizeBytes;
    }
    return { deleted, bytesReclaimed };
  }

  /**
   * One batch of run retention (swamp-club#3473): removes up to `limit`
   * finished runs older than `cutoff`, with the snapshots and signal wait
   * records of exactly those runs. Orphaned and expired snapshots are left
   * to {@link gcRunSnapshots}, which lists every snapshot and so runs once
   * per pass rather than once per batch.
   */
  async gcWorkflowRunBatch(options: {
    cutoff: Date;
    limit: number;
  }): Promise<{ deleted: number; bytesReclaimed: number; more: boolean }> {
    const runs = await this.workflowRunRepo.deleteOlderThan(options.cutoff, {
      limit: options.limit,
    });
    const deletedRunIds = runs.deletedRunIds ?? [];
    for (const runId of deletedRunIds) {
      try {
        await this.runSnapshotRepo.deleteForRun(runId);
      } catch (error) {
        logger
          .warn`Could not remove the snapshot of run ${runId}; it is swept as an orphan later: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (this.collectWaitRecords && deletedRunIds.length > 0) {
      try {
        await this.collectWaitRecords(deletedRunIds);
      } catch (error) {
        logger
          .warn`Signal wait record cleanup failed; leftover records are swept by a later pass: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return {
      deleted: runs.deleted,
      bytesReclaimed: runs.bytesReclaimed,
      more: runs.more ?? false,
    };
  }

  async gcOutputs(options: {
    retentionDays: number;
    dryRun: boolean;
    limit?: number;
  }): Promise<{ deleted: number; bytesReclaimed: number; more?: boolean }> {
    const cutoffMs = Date.now() - options.retentionDays * 86_400_000;
    return await this.outputRepo.deleteByMethodLifetime(
      new Date(cutoffMs),
      options.limit === undefined
        ? { dryRun: options.dryRun }
        : { dryRun: options.dryRun, limit: options.limit },
    );
  }

  async gcAll(options: {
    workflowRunRetentionDays: number;
    outputRetentionDays: number;
    dryRun: boolean;
    limit?: number;
    snapshotRetentionDays?: number;
  }): Promise<RunGcResult> {
    const [[workflowRuns, snapshots], outputs] = await Promise.all([
      (async () => {
        const runs = await this.gcWorkflowRuns({
          retentionDays: options.workflowRunRetentionDays,
          dryRun: options.dryRun,
          limit: options.limit,
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
            snapshotRetentionDays: options.snapshotRetentionDays,
          });
        } catch (error) {
          logger
            .warn`Run snapshot cleanup failed; leftover snapshots are collected by a later run gc: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        // As for snapshots: records left behind are swept later.
        if (!options.dryRun && this.collectWaitRecords) {
          try {
            await this.collectWaitRecords(runs.deletedRunIds ?? []);
          } catch (error) {
            logger
              .warn`Signal wait record cleanup failed; leftover records are swept by a later run gc: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        return [runs, snaps] as const;
      })(),
      this.gcOutputs({
        retentionDays: options.outputRetentionDays,
        dryRun: options.dryRun,
        limit: options.limit,
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
      more: (workflowRuns.more ?? false) || (outputs.more ?? false),
    };
  }
}
