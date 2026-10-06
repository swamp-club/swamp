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

import { ensureDir } from "@std/fs";
import { basename, join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { signalChange } from "./unit_of_work_scope.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import {
  countYamlRunFiles,
  deleteRunIndex,
  fingerprintMatches,
  INDEX_SCHEMA_VERSION,
  isIndexStale,
  listDirEntries,
  type ReadIndexResult,
  readRunIndex,
  type RecordFingerprint,
  statRecord,
  withIndexQueue,
  type WorkflowRunIndex,
  type WorkflowRunIndexEntry,
  writeRunIndex,
} from "./workflow_run_index.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
  toAbsolutePath,
  toRelativePath,
} from "./paths.ts";
import { assertSafePath, isSinglePathSegment } from "./safe_path.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  WorkflowRun,
  type WorkflowRunData,
} from "../../domain/workflows/workflow_run.ts";
import {
  parseWorkflowRunSummary,
  type WorkflowRunSummary,
} from "../../domain/workflows/workflow_run_summary.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import {
  createWorkflowRunCompleted,
  createWorkflowRunFailed,
  createWorkflowRunStarted,
} from "../../domain/events/types.ts";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import {
  NestedRunRefSchema,
  ParentRunRefSchema,
} from "../../domain/workflows/nested_run_ref.ts";

const logger = getLogger(["swamp", "persistence", "workflow-run-index"]);

/**
 * YAML-based implementation of WorkflowRunRepository.
 *
 * Stores workflow runs as YAML files in the directory structure:
 * {repoDir}/.swamp/workflow-runs/{workflowId}/workflow-run-{runId}.yaml
 */
export class YamlWorkflowRunRepository implements WorkflowRunRepository {
  private readonly baseDir: string;

  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
    baseDir?: string,
    private readonly markDirty?: MarkDirtyHook,
  ) {
    this.baseDir = baseDir ?? swampPath(repoDir, SWAMP_SUBDIRS.workflowRuns);
  }

  async findById(
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null> {
    // Every run id is a UUID (WorkflowRunSchema), so anything else cannot
    // name a run. Checking before the path is built keeps a caller-supplied
    // id such as `../x` from reaching outside the runs directory.
    if (!isUuid(runId)) return null;

    // save() always writes getPath(workflowId, runId), so the run is read
    // from that one file: no directory listing, and no other run is parsed.
    let content: string;
    try {
      content = await Deno.readTextFile(this.getPath(workflowId, runId));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
    const data = parseYaml(content) as WorkflowRunData | null;
    if (!data || data.id !== runId) return null;
    // Convert logFile back to absolute path
    if (data.logFile) {
      data.logFile = toAbsolutePath(this.repoDir, data.logFile);
    }
    return WorkflowRun.fromData(data);
  }

  async findAllByWorkflowId(workflowId: WorkflowId): Promise<WorkflowRun[]> {
    const dir = this.getRunsDir(workflowId);
    const runs: WorkflowRun[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          !entry.isFile || !entry.name.startsWith("workflow-run-") ||
          !entry.name.endsWith(".yaml")
        ) {
          continue;
        }
        const path = join(dir, entry.name);

        // Per-file try/catch closes the TOCTOU window: a concurrent
        // delete (e.g. deleteAllByWorkflowId, GC) can remove the file
        // between readDir and readTextFile. NotFound on a single file
        // means "skip it" — never "abandon the rest of the workflow."
        try {
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as WorkflowRunData | null;
          if (!data) continue;
          if (data.logFile) {
            data.logFile = toAbsolutePath(this.repoDir, data.logFile);
          }
          runs.push(WorkflowRun.fromData(data));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
      }
    } catch (error) {
      // Outer catch handles "directory itself doesn't exist" (no runs yet
      // for this workflow). Per-file NotFound is handled above.
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    // Sort by startedAt descending (most recent first)
    return runs.sort((a, b) => {
      const aTime = a.startedAt?.getTime() ?? 0;
      const bTime = b.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }

  /**
   * Lists lightweight {@link WorkflowRunSummary} projections for a workflow's
   * runs, for listing/search paths that only display summary fields.
   *
   * Unlike {@link findAllByWorkflowId}, this never reconstructs the full
   * WorkflowRun aggregate: each file is read and parsed one at a time, projected
   * to a small summary via `parseWorkflowRunSummary`, and the parsed YAML tree
   * (including the unbounded inline step `output` blobs) is released before the
   * next file. Peak memory is therefore O(one file) + O(N small summaries)
   * rather than O(total on-disk run size), which is what OOMs the full read on
   * workflows with a large accumulated run history.
   *
   * This is a projection method on the concrete repository, deliberately NOT on
   * the `WorkflowRunRepository` port: only the run/history search command paths
   * (which reference the concrete class) need it, so keeping it here avoids
   * forcing every implementer and test double to grow.
   */
  async findAllSummariesByWorkflowId(
    workflowId: WorkflowId,
  ): Promise<WorkflowRunSummary[]> {
    const dir = this.getRunsDir(workflowId);
    const summaries: WorkflowRunSummary[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          !entry.isFile || !entry.name.startsWith("workflow-run-") ||
          !entry.name.endsWith(".yaml")
        ) {
          continue;
        }
        const path = join(dir, entry.name);

        // Per-file try/catch closes the TOCTOU window: a concurrent delete
        // (deleteAllByWorkflowId, GC) can remove the file between readDir and
        // readTextFile. NotFound on a single file means "skip it" — never
        // "abandon the rest of the workflow." Mirrors findAllByWorkflowId.
        try {
          const content = await Deno.readTextFile(path);
          // parseWorkflowRunSummary keeps only the displayed fields; the heavy
          // jobs/output subtree in `parseYaml`'s result is dropped and GC'd.
          const parsed = parseYaml(content);
          if (!parsed) continue;
          summaries.push(parseWorkflowRunSummary(parsed));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
      }
    } catch (error) {
      // Outer catch handles "directory itself doesn't exist" (no runs yet
      // for this workflow). Per-file NotFound is handled above.
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    // Sort by startedAt descending (most recent first) — identical ordering to
    // findAllByWorkflowId so listing order is unchanged.
    return summaries.sort((a, b) => {
      const aTime = a.startedAt?.getTime() ?? 0;
      const bTime = b.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }

  async findLatestByWorkflowId(
    workflowId: WorkflowId,
  ): Promise<WorkflowRun | null> {
    const runsDir = this.getRunsDir(workflowId);
    const indexDir = this.getLocalIndexDir(workflowId);
    const index = await this.getValidatedIndex(runsDir, indexDir);

    if (index) {
      const latestId = this.findLatestRunIdFromIndex(index);
      if (latestId) {
        return this.findById(workflowId, latestId as WorkflowRunId);
      }
      return null;
    }

    // Fallback: scan as lightweight summaries to find the latest, then
    // load only that one as a full aggregate.
    const summaries = await this.findAllSummariesByWorkflowId(workflowId);
    if (summaries.length === 0) return null;
    return this.findById(
      workflowId,
      summaries[0].id as WorkflowRunId,
    );
  }

  private findLatestRunIdFromIndex(
    index: WorkflowRunIndex,
  ): string | null {
    let latestId: string | null = null;
    let latestTime = -1;
    for (const [id, entry] of Object.entries(index)) {
      const time = entry.startedAt ? new Date(entry.startedAt).getTime() : 0;
      if (time > latestTime) {
        latestTime = time;
        latestId = id;
      }
    }
    return latestId;
  }

  /**
   * Finds a single run by ID without knowing its owning workflow, by probing
   * the deterministic run path in each workflow directory.
   *
   * `save()` always writes to `getPath(workflowId, runId)`, so the owner can be
   * located with one `stat` per workflow directory — no directory enumeration,
   * and only the winning run file is read and parsed. Callers that already know
   * the workflow should use {@link findById}; this exists for identity lookups
   * that would otherwise go through {@link findAllGlobal} and parse every
   * retained run to return one.
   *
   * This is an identity-lookup method on the concrete repository, deliberately
   * NOT on the `WorkflowRunRepository` port — the same reasoning as
   * {@link findAllSummariesByWorkflowId}: only the history command paths (which
   * reference the concrete class) need it, so keeping it here avoids forcing
   * every implementer and test double to grow.
   */
  async findGlobalById(
    runId: WorkflowRunId,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null> {
    // As in findById: a non-UUID id names no run and must not become a path.
    if (!isUuid(runId)) return null;
    try {
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (!entry.isDirectory) continue;
        const workflowId = entry.name as WorkflowId;

        try {
          await Deno.stat(this.getPath(workflowId, runId));
        } catch (error) {
          // The ordinary miss: this workflow doesn't own the run.
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }

        // A concurrent delete (GC, deleteOlderThan, deleteAllByWorkflowId) can
        // remove the file between the stat and the read. A null here means
        // "skip it" — never "abandon the rest of the search" — matching the
        // per-file NotFound handling in findAllByWorkflowId.
        const run = await this.findById(workflowId, runId);
        if (run) {
          await this.repairIndexEntry(workflowId, run);
          return { run, workflowId };
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }

    return null;
  }

  /**
   * Finds all workflow runs across all workflows.
   */
  async findAllGlobal(): Promise<
    { run: WorkflowRun; workflowId: WorkflowId }[]
  > {
    const results: { run: WorkflowRun; workflowId: WorkflowId }[] = [];
    const workflowRunsDir = this.baseDir;

    try {
      for await (const entry of Deno.readDir(workflowRunsDir)) {
        if (entry.isDirectory) {
          // Directory name is the workflow ID
          const workflowIdStr = entry.name;
          const workflowId = workflowIdStr as WorkflowId;
          const runs = await this.findAllByWorkflowId(workflowId);
          for (const run of runs) {
            results.push({ run, workflowId });
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    // Sort by startedAt descending (most recent first)
    return results.sort((a, b) => {
      const aTime = a.run.startedAt?.getTime() ?? 0;
      const bTime = b.run.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }

  /**
   * Finds all workflow runs across all workflows whose startedAt is at or
   * after the cutoff, using a two-stage filter to avoid parsing every YAML
   * file on large repos.
   *
   * Stage A — mtime pre-filter: stat each candidate file and skip if mtime
   * is strictly before the cutoff. `save()` rewrites the YAML on every
   * status transition (pending → running → succeeded/failed), so a file
   * with mtime < cutoff cannot have startedAt >= cutoff: any startedAt on
   * or after the cutoff would have triggered a save on or after the cutoff.
   *
   * Stage B — parse and verify: parse files that pass Stage A and re-check
   * `startedAt >= cutoff`. This rejects long-running workflows that started
   * before the cutoff but were still being saved into after it (mtime > cutoff
   * but startedAt < cutoff).
   *
   * Backup-restore scenarios that scramble mtime cannot cause incorrect
   * inclusion — Stage B is the source of truth for inclusion. They can only
   * defeat the optimization (degrading to current `findAllGlobal()` cost),
   * which is acceptable.
   */
  async findAllGlobalSince(
    cutoff: Date,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    const results: { run: WorkflowRun; workflowId: WorkflowId }[] = [];
    const cutoffMs = cutoff.getTime();

    try {
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (!entry.isDirectory) continue;
        const workflowId = entry.name as WorkflowId;
        const runs = await this.findRunsSinceByWorkflowId(workflowId, cutoffMs);
        for (const run of runs) {
          results.push({ run, workflowId });
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return results.sort((a, b) => {
      const aTime = a.run.startedAt?.getTime() ?? 0;
      const bTime = b.run.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }

  private async findRunsSinceByWorkflowId(
    workflowId: WorkflowId,
    cutoffMs: number,
  ): Promise<WorkflowRun[]> {
    const dir = this.getRunsDir(workflowId);
    const runs: WorkflowRun[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          !entry.isFile || !entry.name.startsWith("workflow-run-") ||
          !entry.name.endsWith(".yaml")
        ) {
          continue;
        }
        const path = join(dir, entry.name);

        // Per-file try/catch closes the TOCTOU window: a concurrent
        // delete can remove the file between readDir and stat or between
        // stat and readTextFile. NotFound on a single file means "skip
        // it" — never "discard runs already collected for this workflow."
        try {
          // Stage A: mtime pre-filter
          const stat = await Deno.stat(path);
          const mtimeMs = stat.mtime?.getTime();
          if (mtimeMs !== undefined && mtimeMs < cutoffMs) continue;

          // Stage B: parse and verify
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as WorkflowRunData | null;
          if (!data) continue;
          if (data.logFile) {
            data.logFile = toAbsolutePath(this.repoDir, data.logFile);
          }
          const run = WorkflowRun.fromData(data);
          const startedAtMs = run.startedAt?.getTime();
          if (startedAtMs === undefined || startedAtMs < cutoffMs) continue;

          runs.push(run);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
      }
    } catch (error) {
      // Outer catch handles "directory itself doesn't exist." Per-file
      // NotFound is handled above.
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return runs;
  }

  async findGlobalByStatus(
    status: string | string[],
    since?: Date,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]> {
    const statuses = Array.isArray(status) ? status : [status];
    const statusSet = new Set(statuses);
    const sinceMs = since?.getTime();
    const results: { run: WorkflowRun; workflowId: WorkflowId }[] = [];

    try {
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (!entry.isDirectory) continue;
        const workflowId = entry.name as WorkflowId;
        const matchingIds = await this.findRunIdsByStatusFromIndex(
          workflowId,
          statusSet,
          sinceMs,
        );
        for (const runId of matchingIds) {
          const run = await this.findById(
            workflowId,
            runId as WorkflowRunId,
          );
          // The index named the run under a status its record no longer has.
          if (run && !statusSet.has(run.status)) {
            await this.repairIndexEntry(workflowId, run);
          }
          if (run && statusSet.has(run.status)) {
            if (sinceMs !== undefined) {
              const startedAtMs = run.startedAt?.getTime();
              if (startedAtMs === undefined || startedAtMs < sinceMs) continue;
            }
            results.push({ run, workflowId });
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return results.sort((a, b) => {
      const aTime = a.run.startedAt?.getTime() ?? 0;
      const bTime = b.run.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }

  private async findRunIdsByStatusFromIndex(
    workflowId: WorkflowId,
    statusSet: Set<string>,
    sinceMs: number | undefined,
  ): Promise<string[]> {
    const runsDir = this.getRunsDir(workflowId);
    const indexDir = this.getLocalIndexDir(workflowId);
    const index = await this.getValidatedIndex(runsDir, indexDir);

    if (index) {
      const ids: string[] = [];
      for (const [id, entry] of Object.entries(index)) {
        if (!statusSet.has(entry.status)) continue;
        if (sinceMs !== undefined) {
          const startedAtMs = entry.startedAt
            ? new Date(entry.startedAt).getTime()
            : undefined;
          if (startedAtMs === undefined || startedAtMs < sinceMs) continue;
        }
        ids.push(id);
      }
      return ids;
    }

    // Fallback: lightweight summary scan
    const summaries = await this.findAllSummariesByWorkflowId(workflowId);
    return summaries
      .filter((s) => {
        if (!statusSet.has(s.status)) return false;
        if (sinceMs !== undefined) {
          const startedAtMs = s.startedAt?.getTime();
          if (startedAtMs === undefined || startedAtMs < sinceMs) return false;
        }
        return true;
      })
      .map((s) => s.id);
  }

  async save(workflowId: WorkflowId, run: WorkflowRun): Promise<void> {
    const path = this.getPath(workflowId, run.id);
    await signalChange(this.markDirty, { kind: "write", path });

    const dir = this.getRunsDir(workflowId);
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    // Get the previous status to detect state changes
    let previousStatus: string | undefined;
    if (this.eventBus) {
      const existingRun = await this.findById(workflowId, run.id);
      previousStatus = existingRun?.status;
    }

    // The persisted form: sensitive values the run read through expressions
    // are written as the vault references they came from.
    const data = run.toPersistedData();
    // Convert logFile to relative path for storage
    if (data.logFile) {
      data.logFile = toRelativePath(this.repoDir, data.logFile);
    }
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(path, content);

    await this.updateIndexEntry(workflowId, run, path, content);

    // Emit events based on status changes
    if (this.eventBus) {
      const currentStatus = run.status;

      if (previousStatus !== currentStatus) {
        // Emit WorkflowRunStarted for new runs (previousStatus undefined) or
        // transitions from pending to running
        if (
          currentStatus === "running" &&
          (previousStatus === "pending" || previousStatus === undefined)
        ) {
          const event = createWorkflowRunStarted(
            workflowId,
            run.workflowName,
            run.id,
          );
          await this.eventBus.publish(event);
        } else if (currentStatus === "succeeded") {
          const event = createWorkflowRunCompleted(
            workflowId,
            run.workflowName,
            run.id,
          );
          await this.eventBus.publish(event);
        } else if (currentStatus === "failed") {
          const event = createWorkflowRunFailed(
            workflowId,
            run.workflowName,
            run.id,
          );
          await this.eventBus.publish(event);
        }
      }
    }
  }

  nextId(): WorkflowRunId {
    return createWorkflowRunId(crypto.randomUUID());
  }

  getPath(workflowId: WorkflowId, runId: WorkflowRunId): string {
    return join(
      this.getRunsDir(workflowId),
      `workflow-run-${runId}.yaml`,
    );
  }

  private getRunsDir(workflowId: WorkflowId): string {
    return join(this.baseDir, workflowId);
  }

  private getLocalIndexDir(workflowId: WorkflowId): string {
    return join(
      swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns),
      workflowId,
    );
  }

  async deleteAllByWorkflowId(workflowId: WorkflowId): Promise<number> {
    const dir = this.getRunsDir(workflowId);

    // Count the runs before deleting
    const runs = await this.findAllByWorkflowId(workflowId);
    const count = runs.length;

    if (count === 0) {
      return 0;
    }

    await signalChange(this.markDirty, { kind: "remove", path: dir });

    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    await deleteRunIndex(this.getLocalIndexDir(workflowId));

    return count;
  }

  async deleteOlderThan(
    cutoff: Date,
    options?: { dryRun?: boolean },
  ): Promise<
    { deleted: number; bytesReclaimed: number; deletedRunIds: string[] }
  > {
    const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
    // A finished nested run is kept while its parent still exists and has not
    // finished (interrupted counts as unfinished: it can be recovered), since
    // the parent's resume reads the child's outcome (swamp-club#2736). A
    // parent that no longer exists leaves the child collectible; one that
    // cannot be read keeps it, since the deletion cannot be undone.
    const parentStatuses = new Map<string, string | null>();
    const keepForParent = async (data: unknown): Promise<boolean> => {
      const link = ParentRunRefSchema.safeParse(
        (data as { parentRun?: unknown }).parentRun,
      );
      if (!link.success) return false;
      const key = link.data.runId.toLowerCase();
      let status = parentStatuses.get(key);
      if (status === undefined) {
        const parent = await this.findById(
          createWorkflowId(link.data.workflowId),
          createWorkflowRunId(link.data.runId),
        ).catch(() => undefined);
        status = parent === undefined ? "unreadable" : parent?.status ?? null;
        parentStatuses.set(key, status);
      }
      return status !== null && !TERMINAL_STATUSES.has(status);
    };
    const cutoffMs = cutoff.getTime();
    let deleted = 0;
    let bytesReclaimed = 0;
    const deletedRunIds: string[] = [];
    const affectedDirs = new Set<string>();

    try {
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (!entry.isDirectory) continue;
        const workflowId = entry.name as WorkflowId;
        const dir = this.getRunsDir(workflowId);

        try {
          for await (const fileEntry of Deno.readDir(dir)) {
            if (
              !fileEntry.isFile ||
              !fileEntry.name.startsWith("workflow-run-") ||
              !fileEntry.name.endsWith(".yaml")
            ) {
              continue;
            }
            const yamlPath = join(dir, fileEntry.name);

            try {
              const stat = await Deno.stat(yamlPath);
              const mtimeMs = stat.mtime?.getTime();
              if (mtimeMs !== undefined && mtimeMs >= cutoffMs) continue;

              const content = await Deno.readTextFile(yamlPath);
              const data = parseYaml(content) as WorkflowRunData | null;
              if (!data) {
                const logPath = yamlPath.replace(/\.yaml$/, ".log");
                let fileBytes = stat.size ?? 0;
                try {
                  const logStat = await Deno.stat(logPath);
                  fileBytes += logStat.size ?? 0;
                } catch {
                  // log file may not exist
                }
                if (!options?.dryRun) {
                  await signalChange(this.markDirty, {
                    kind: "remove",
                    path: yamlPath,
                  });
                  try {
                    await Deno.remove(yamlPath);
                  } catch (error) {
                    if (!(error instanceof Deno.errors.NotFound)) throw error;
                  }
                  try {
                    await Deno.remove(logPath);
                  } catch (error) {
                    if (!(error instanceof Deno.errors.NotFound)) throw error;
                  }
                  await cleanupEmptyParentDirs(yamlPath, this.baseDir);
                  affectedDirs.add(dir);
                }
                deleted++;
                bytesReclaimed += fileBytes;
                const fileRunId = runIdFromFileName(fileEntry.name);
                if (isSinglePathSegment(fileRunId)) {
                  deletedRunIds.push(fileRunId);
                }
                continue;
              }
              if (!TERMINAL_STATUSES.has(data.status)) continue;

              const completedAt = data.completedAt
                ? new Date(data.completedAt).getTime()
                : undefined;
              const startedAt = data.startedAt
                ? new Date(data.startedAt).getTime()
                : undefined;
              const timestamp = completedAt ?? startedAt;
              if (
                timestamp === undefined || Number.isNaN(timestamp) ||
                timestamp >= cutoffMs
              ) continue;
              // Read a parent only for a child old enough to collect.
              if (await keepForParent(data)) continue;

              const logPath = yamlPath.replace(/\.yaml$/, ".log");
              let fileBytes = stat.size ?? 0;
              try {
                const logStat = await Deno.stat(logPath);
                fileBytes += logStat.size ?? 0;
              } catch {
                // log file may not exist
              }

              if (!options?.dryRun) {
                await signalChange(this.markDirty, {
                  kind: "remove",
                  path: yamlPath,
                });
                try {
                  await Deno.remove(yamlPath);
                } catch (error) {
                  if (!(error instanceof Deno.errors.NotFound)) throw error;
                }
                try {
                  await Deno.remove(logPath);
                } catch (error) {
                  if (!(error instanceof Deno.errors.NotFound)) throw error;
                }
                await cleanupEmptyParentDirs(yamlPath, this.baseDir);
                affectedDirs.add(dir);
              }

              deleted++;
              bytesReclaimed += fileBytes;
              // Report the ID of the file actually deleted — its name, which
              // save() writes via getPath — not the body's `id`, which could
              // name a different (live) run. Only a single safe path segment
              // may name a snapshot directory.
              const runId = runIdFromFileName(fileEntry.name);
              if (isSinglePathSegment(runId)) deletedRunIds.push(runId);
            } catch (error) {
              if (error instanceof Deno.errors.NotFound) continue;
              throw error;
            }
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    for (const dir of affectedDirs) {
      await deleteRunIndex(dir);
      const workflowId = basename(dir) as WorkflowId;
      if (workflowId) {
        await deleteRunIndex(this.getLocalIndexDir(workflowId));
      }
    }

    return { deleted, bytesReclaimed, deletedRunIds };
  }

  /**
   * Returns the IDs of every stored run across all workflows, read from the
   * `workflow-run-{runId}.yaml` filenames without parsing any YAML.
   */
  async listRunIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (!entry.isDirectory) continue;
        for (
          const runId of await this.listRunIdsInDir(
            join(this.baseDir, entry.name),
          )
        ) {
          ids.add(runId);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return ids;
  }

  /**
   * Returns the IDs of the workflows that have a runs directory, whether or
   * not a workflow definition still exists for them. No run file is read.
   */
  async listWorkflowIds(): Promise<WorkflowId[]> {
    const ids: WorkflowId[] = [];
    try {
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (entry.isDirectory) ids.push(entry.name as WorkflowId);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return ids;
  }

  /**
   * Returns the IDs of a workflow's stored runs, read from the
   * `workflow-run-{runId}.yaml` filenames without parsing any YAML. Empty or
   * unparseable run files are included; a record body's `id` is never used.
   */
  async listRunIdsForWorkflow(workflowId: WorkflowId): Promise<string[]> {
    return await this.listRunIdsInDir(this.getRunsDir(workflowId));
  }

  private async listRunIdsInDir(dir: string): Promise<string[]> {
    const ids: string[] = [];
    try {
      for await (const fileEntry of Deno.readDir(dir)) {
        if (
          fileEntry.isFile &&
          fileEntry.name.startsWith("workflow-run-") &&
          fileEntry.name.endsWith(".yaml")
        ) {
          const runId = runIdFromFileName(fileEntry.name);
          if (isSinglePathSegment(runId)) ids.push(runId);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return ids;
  }

  async findAllSummariesFromIndex(
    workflowId: WorkflowId,
  ): Promise<WorkflowRunSummary[]> {
    const runsDir = this.getRunsDir(workflowId);
    const indexDir = this.getLocalIndexDir(workflowId);
    const index = await this.getValidatedIndex(runsDir, indexDir);
    if (!index) {
      return this.findAllSummariesByWorkflowId(workflowId);
    }
    return indexToSummaries(index);
  }

  async findSummariesByStatus(
    workflowId: WorkflowId,
    status: string,
  ): Promise<WorkflowRunSummary[]> {
    const runsDir = this.getRunsDir(workflowId);
    const indexDir = this.getLocalIndexDir(workflowId);
    const index = await this.getValidatedIndex(runsDir, indexDir);
    if (!index) {
      const all = await this.findAllSummariesByWorkflowId(workflowId);
      return all.filter((s) => s.status === status);
    }
    return indexToSummaries(index).filter((s) => s.status === status);
  }

  private async getValidatedIndex(
    runsDir: string,
    indexDir: string,
  ): Promise<WorkflowRunIndex | null> {
    const entries = await listDirEntries(runsDir);
    const yamlCount = countYamlRunFiles(entries);
    if (yamlCount === 0) return null;

    const result = await readRunIndex(indexDir);
    if (!result || isIndexStale(result, yamlCount)) {
      return await this.rebuildIndex(runsDir, indexDir);
    }

    return result.entries;
  }

  /**
   * Brings every workflow's run index in line with its run records. The index
   * is otherwise trusted while it lists as many runs as there are records, so
   * an entry left behind by a record another process or a datastore pull
   * replaced stays wrong until that run is read; this corrects them all.
   *
   * Each record is stat'ed and compared with the fingerprint its entry was
   * built from, and only records that differ, or have no entry, are read. An
   * index with nothing wrong is not written (swamp-club#3051). A workflow
   * whose changed records cannot all be read keeps the index it had.
   */
  async verifyIndexes(): Promise<void> {
    let workflowIds: WorkflowId[];
    try {
      workflowIds = [];
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (entry.isDirectory) workflowIds.push(entry.name as WorkflowId);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const workflowId of workflowIds) {
      // One workflow with a record that cannot be read must not stop the
      // rest from being checked: the caller is usually `run doctor`.
      try {
        await this.verifyIndex(
          this.getRunsDir(workflowId),
          this.getLocalIndexDir(workflowId),
        );
      } catch (error) {
        // The message only: a parser's stack trace says nothing to the
        // operator this reaches through `run doctor`.
        const reason = error instanceof Error ? error.message : String(error);
        logger
          .warn`Could not verify the run index of workflow ${workflowId}, which has a run record that cannot be read: ${reason}`;
      }
    }
  }

  private async verifyIndex(runsDir: string, indexDir: string): Promise<void> {
    const seen = await readRunIndex(indexDir);
    if (!seen || seen.version !== INDEX_SCHEMA_VERSION) {
      await this.rebuildIndex(runsDir, indexDir);
      return;
    }
    const suspects = await this.findSuspectRecords(runsDir, seen.entries);
    if (suspects.size === 0) return;
    await withIndexQueue(indexDir, async () => {
      // Decided again from the index as it is now: a save queued ahead of
      // this has already written its own entry, which must be kept.
      const result = await readRunIndex(indexDir);
      if (!result || result.version !== INDEX_SCHEMA_VERSION) {
        await this.rebuildIndexUnqueued(runsDir, indexDir);
        return;
      }
      const entries = result.entries;
      // Ids that a record names in its body under another file name, which
      // a rebuild indexes by the body id: their entries are not gone.
      const bodyIds = new Set<string>();
      let changed = false;
      for (const runId of suspects) {
        const path = join(runsDir, `workflow-run-${runId}.yaml`);
        const current = await statRecord(path);
        if (current === null) {
          if (runId in entries && !bodyIds.has(runId)) {
            delete entries[runId];
            changed = true;
          }
          continue;
        }
        if (current && fingerprintMatches(entries[runId]?.record, current)) {
          continue;
        }
        const read = await readIndexedRecord(path);
        if (read === null) {
          if (runId in entries) {
            delete entries[runId];
            changed = true;
          }
          continue;
        }
        // A record whose body names another run is indexed as a rebuild
        // would, by the id in its body; it has no entry under its file name,
        // so it is read on every verify, and written only when it changed.
        const id = read.summary.id;
        if (id !== runId) bodyIds.add(id);
        const next = indexEntryOf(read.summary, read.record);
        // An entry that cannot be fingerprinted is read every time; it is
        // written only when it says something new.
        if (JSON.stringify(entries[id]) === JSON.stringify(next)) continue;
        entries[id] = next;
        changed = true;
      }
      if (!changed) return;
      try {
        await writeRunIndex(indexDir, entries);
      } catch (error) {
        logger
          .warn`Failed to write verified index, will retry next read: ${error}`;
      }
    });
  }

  /**
   * The run ids whose index entry may not match their record: a record with
   * no entry, no fingerprint or another fingerprint, and an entry whose
   * record is gone. Stats every record; reads none.
   */
  private async findSuspectRecords(
    runsDir: string,
    entries: WorkflowRunIndex,
  ): Promise<Set<string>> {
    const suspects = new Set<string>();
    const onDisk = new Set<string>();
    try {
      for await (const entry of Deno.readDir(runsDir)) {
        if (
          !entry.isFile || !entry.name.startsWith("workflow-run-") ||
          !entry.name.endsWith(".yaml")
        ) {
          continue;
        }
        const runId = runIdFromFileName(entry.name);
        const current = await statRecord(join(runsDir, entry.name));
        if (current === null) continue;
        onDisk.add(runId);
        if (!current || !fingerprintMatches(entries[runId]?.record, current)) {
          suspects.add(runId);
        }
      }
    } catch (error) {
      // No runs directory: nothing to check, as a rebuild would leave it.
      if (error instanceof Deno.errors.NotFound) return suspects;
      throw error;
    }
    for (const runId of Object.keys(entries)) {
      if (!onDisk.has(runId)) suspects.add(runId);
    }
    return suspects;
  }

  /**
   * Queued with the index updates of the same workflow, so an entry a save
   * writes while the records are being read is applied after the rebuild
   * rather than overwritten by it.
   */
  private rebuildIndex(
    runsDir: string,
    indexDir: string,
  ): Promise<WorkflowRunIndex | null> {
    return withIndexQueue(
      indexDir,
      () => this.rebuildIndexUnqueued(runsDir, indexDir),
    );
  }

  private async rebuildIndexUnqueued(
    runsDir: string,
    indexDir: string,
  ): Promise<WorkflowRunIndex | null> {
    const index: WorkflowRunIndex = {};
    try {
      for await (const entry of Deno.readDir(runsDir)) {
        if (
          !entry.isFile || !entry.name.startsWith("workflow-run-") ||
          !entry.name.endsWith(".yaml")
        ) {
          continue;
        }
        const read = await readIndexedRecord(join(runsDir, entry.name));
        if (!read) continue;
        index[read.summary.id] = indexEntryOf(read.summary, read.record);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }

    try {
      await ensureDir(indexDir);
      await writeRunIndex(indexDir, index);
    } catch (error) {
      logger
        .warn`Failed to write rebuilt index, will retry next read: ${error}`;
    }

    return index;
  }

  /**
   * Writes the run's entry into its workflow's index. Queued per index file:
   * the index is read, changed and written back whole, so two saves of
   * different runs of one workflow would otherwise each write back the
   * other's old entry (swamp-club#2518).
   */
  private async updateIndexEntry(
    workflowId: WorkflowId,
    run: WorkflowRun,
    path: string,
    written: string,
  ): Promise<void> {
    const indexDir = this.getLocalIndexDir(workflowId);
    await withIndexQueue(indexDir, async () => {
      try {
        await ensureDir(indexDir);
        const result = await readRunIndex(indexDir);
        if (result && result.version !== INDEX_SCHEMA_VERSION) {
          // Stale schema — delete so the next read rebuilds from YAML.
          // Merging would promote old entries to the new version without
          // populating fields they're missing.
          await deleteRunIndex(indexDir);
          return;
        }
        const existing = result?.entries ?? {};
        const summary = parseWorkflowRunSummary(run.toPersistedData());
        // Fingerprinted only while the file still holds what this save
        // wrote: another writer may have replaced it since, and an entry
        // with no fingerprint is read and corrected by verifyIndexes.
        const record = await fingerprintIfContent(path, written);
        existing[run.id] = indexEntryOf(summary, record);
        await writeRunIndex(indexDir, existing);
      } catch (error) {
        logger
          .warn`Failed to update run index, deleting for rebuild: ${error}`;
        await deleteRunIndex(indexDir);
      }
    });
  }

  /**
   * Corrects the index entry of a run just read from its record when the two
   * disagree on status or on awaiting a resume: the record was replaced
   * without a save here, by another process or a datastore pull. Best effort;
   * a run the index does not list is left to the count check and rebuild.
   *
   * `run` only decides whether to look closer. The entry is written from the
   * record as read again inside the index queue, never from `run`: a save
   * that landed after the caller's read has already written its own entry,
   * and the caller's older copy must not replace it.
   */
  private async repairIndexEntry(
    workflowId: WorkflowId,
    run: WorkflowRun,
  ): Promise<void> {
    const indexDir = this.getLocalIndexDir(workflowId);
    try {
      const seen = await readRunIndex(indexDir);
      if (!seen || !indexEntryDiffers(seen, run)) return;
      await withIndexQueue(indexDir, async () => {
        // save() writes the record before it queues its entry, so this read
        // is at least as new as every entry already written.
        const path = this.getPath(workflowId, run.id);
        const before = await statRecord(path);
        const current = await this.findById(workflowId, run.id);
        const after = await statRecord(path);
        const result = await readRunIndex(indexDir);
        if (!current || !result || !indexEntryDiffers(result, current)) return;
        const summary = parseWorkflowRunSummary(current.toPersistedData());
        result.entries[current.id] = indexEntryOf(
          summary,
          sameFingerprint(before, after),
        );
        await writeRunIndex(indexDir, result.entries);
      });
    } catch (error) {
      logger.warn`Failed to repair run index entry for ${run.id}: ${error}`;
    }
  }
}

/**
 * Whether a current-schema index lists `run` under another status, or
 * disagrees on whether it awaits a resume. False for a run it does not list.
 */
function indexEntryDiffers(index: ReadIndexResult, run: WorkflowRun): boolean {
  const entry = index.entries[run.id];
  if (!entry || index.version !== INDEX_SCHEMA_VERSION) return false;
  return entry.status !== run.status ||
    (entry.awaitingResume ?? false) !== run.isAwaitingResume();
}

/**
 * Reads a run record for its index entry, with the fingerprint of the
 * version read when the file did not change while it was read. Null for a
 * record that is gone or empty; a record that does not parse throws.
 */
async function readIndexedRecord(
  path: string,
): Promise<{ summary: WorkflowRunSummary; record?: RecordFingerprint } | null> {
  const before = await statRecord(path);
  if (before === null) return null;
  let content: string;
  try {
    content = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  const after = await statRecord(path);
  const parsed = parseYaml(content);
  if (!parsed) return null;
  return {
    summary: parseWorkflowRunSummary(parsed),
    record: sameFingerprint(before, after),
  };
}

/**
 * The fingerprint of the file at `path` when it holds exactly `expected`
 * and did not change while it was read, else none. Never throws.
 */
async function fingerprintIfContent(
  path: string,
  expected: string,
): Promise<RecordFingerprint | undefined> {
  try {
    const before = await statRecord(path);
    const content = await Deno.readTextFile(path);
    const after = await statRecord(path);
    return content === expected ? sameFingerprint(before, after) : undefined;
  } catch {
    return undefined;
  }
}

/** The fingerprint when two stats of one file agree, else none. */
function sameFingerprint(
  before: RecordFingerprint | undefined | null,
  after: RecordFingerprint | undefined | null,
): RecordFingerprint | undefined {
  return before && after && fingerprintMatches(before, after)
    ? after
    : undefined;
}

function indexEntryOf(
  summary: WorkflowRunSummary,
  record: RecordFingerprint | undefined,
): WorkflowRunIndexEntry {
  const entry = summaryToIndexEntry(summary);
  return record ? { ...entry, record } : entry;
}

function summaryToIndexEntry(
  summary: WorkflowRunSummary,
): WorkflowRunIndexEntry {
  return {
    status: summary.status,
    workflowId: summary.workflowId,
    workflowName: summary.workflowName,
    startedAt: summary.startedAt?.toISOString(),
    completedAt: summary.completedAt?.toISOString(),
    tags: summary.tags,
    inputs: summary.inputs as Record<string, unknown>,
    instanceId: summary.instanceId,
    triggerSource: summary.triggerSource,
    failedStep: summary.failedStep,
    failureReason: summary.failureReason,
    stepProgress: summary.stepProgress,
    awaitingResume: summary.awaitingResume,
    parentRun: summary.parentRun,
    waitingOnRun: summary.waitingOnRun,
    waitsOnlyOnNestedRuns: summary.waitsOnlyOnNestedRuns,
  };
}

/** Reads an index entry's nested workflow links, dropping malformed ones. */
function indexEntryLinks(
  entry: WorkflowRunIndexEntry,
): Pick<
  WorkflowRunSummary,
  "parentRun" | "waitingOnRun" | "waitsOnlyOnNestedRuns"
> {
  const parentRun = entry.parentRun === undefined
    ? undefined
    : ParentRunRefSchema.safeParse(entry.parentRun);
  const waitingOnRun = entry.waitingOnRun === undefined
    ? undefined
    : z.array(NestedRunRefSchema).safeParse(entry.waitingOnRun);
  return {
    parentRun: parentRun?.success ? parentRun.data : undefined,
    waitingOnRun: waitingOnRun?.success && waitingOnRun.data.length > 0
      ? waitingOnRun.data
      : undefined,
    waitsOnlyOnNestedRuns: entry.waitsOnlyOnNestedRuns === true
      ? true
      : undefined,
  };
}

function indexToSummaries(index: WorkflowRunIndex): WorkflowRunSummary[] {
  const summaries: WorkflowRunSummary[] = [];
  for (const [id, entry] of Object.entries(index)) {
    summaries.push({
      id,
      workflowId: entry.workflowId,
      workflowName: entry.workflowName,
      status: entry.status,
      startedAt: entry.startedAt ? new Date(entry.startedAt) : undefined,
      completedAt: entry.completedAt ? new Date(entry.completedAt) : undefined,
      tags: entry.tags,
      inputs: entry.inputs,
      instanceId: entry.instanceId,
      triggerSource: entry.triggerSource,
      failedStep: entry.failedStep,
      failureReason: entry.failureReason,
      stepProgress: entry.stepProgress,
      awaitingResume: entry.awaitingResume,
      ...indexEntryLinks(entry),
    });
  }
  return summaries.sort((a, b) => {
    const aTime = a.startedAt?.getTime() ?? 0;
    const bTime = b.startedAt?.getTime() ?? 0;
    return bTime - aTime;
  });
}

/** Extracts the run ID from a `workflow-run-{runId}.yaml` filename. */
function runIdFromFileName(fileName: string): string {
  return fileName.slice("workflow-run-".length, -".yaml".length);
}
