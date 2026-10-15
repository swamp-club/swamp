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

import { maxOf } from "../array_extrema.ts";
import { getLogger } from "@logtape/logtape";
import type { Data } from "./data.ts";
import type { Lifetime } from "./data_metadata.ts";
import { parseDataDuration } from "./duration.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { WorkflowRunRepository } from "../workflows/repositories.ts";
import type { ModelType } from "../models/model_type.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../workflows/workflow_id.ts";

const logger = getLogger(["swamp", "domain", "data", "lifecycle"]);

/**
 * Information about data that has expired.
 */
export interface ExpiredDataInfo {
  type: ModelType;
  modelId: string;
  dataName: string;
  data: Data;
  reason: "duration-expired" | "workflow-deleted" | "job-deleted";
}

/**
 * A (modelType, modelId) pair that would have versions pruned by version GC,
 * with the counts computed via a dry-run against the repository.
 */
export interface VersionGcPreviewInfo {
  type: ModelType;
  modelId: string;
  versionsWouldBeRemoved: number;
  bytesWouldBeReclaimed: number;
}

/**
 * Result of garbage collection operation.
 */
export interface LifecycleGCResult {
  /** Number of expired data entries hard-deleted */
  dataEntriesExpired: number;
  /** Number of versions hard-deleted (expired + GC) */
  versionsDeleted: number;
  /** Bytes reclaimed from hard-deleting expired data and version GC */
  bytesReclaimed: number;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** List of data marked as expired */
  expiredEntries: Array<{
    type: string;
    modelId: string;
    dataName: string;
    reason: string;
    versionCount: number;
  }>;
}

/**
 * Result of {@link DataLifecycleService.deleteDataOlderThan}.
 */
export interface DataRetentionResult {
  /** Data names deleted whole: every version was older than the cutoff. */
  entriesDeleted: number;
  /** Versions deleted, counting those of whole names. */
  versionsDeleted: number;
  /** Bytes the deleted versions held, as recorded when they were written. */
  bytesReclaimed: number;
  /** True when the run stopped at its limit with candidates left. */
  more: boolean;
  /**
   * Names whose deletion failed and were skipped (logged). Retention left
   * them in place, so a caller must not report the cutoff as applied.
   */
  failed: number;
  /** Whether this was a dry run. */
  dryRun: boolean;
}

/** Options for {@link DataLifecycleService.deleteDataOlderThan}. */
export interface DeleteDataOlderThanOptions {
  dryRun: boolean;
  /**
   * Most versions to delete in this call. A name deleted whole counts all
   * its versions and is never split, so a call can go past the limit by the
   * versions of its last name.
   */
  limit?: number;
  /**
   * Whether data of a (normalized) model type is never deleted by
   * retention. Injected so the data context stays independent of the
   * retention context, which owns the exemption list.
   */
  isExempt: (modelType: string) => boolean;
  /**
   * The exempt model types, when the caller can list them: the repository
   * then leaves them out of its candidates. `isExempt` is still checked.
   */
  exemptTypes?: readonly string[];
  /**
   * Keep each name's latest version even when it is past the cutoff, so a
   * name is never emptied. Set where nothing keeps a deleted name's version
   * numbers from being reused (a v3 datastore, until its partition
   * high-water mark reaches version allocation).
   */
  keepLatestVersion?: boolean;
}

/** Versions read from the repository per page of retention candidates. */
const RETENTION_PAGE_SIZE = 500;

/**
 * Predicate answering whether a model definition still exists for the given
 * (type, modelId). Injected as a port so the lifecycle service stays decoupled
 * from the definition repository — the libswamp layer wires this using the same
 * definition lookup that `swamp model get` uses (covering both `models/` and
 * `.swamp/auto-definitions/`).
 */
export type IsModelLive = (
  type: ModelType,
  modelId: string,
) => Promise<boolean>;

/**
 * A model's orphaned data — data whose owning model definition no longer exists
 * in its namespace. Aggregated per (type, modelId); every data name under an
 * orphaned model is orphaned together.
 */
export interface OrphanedDataInfo {
  type: ModelType;
  modelId: string;
  /** Human-readable model name, from the data tags (may be absent on old data). */
  modelName?: string;
  /** Distinct data names owned by the orphaned model. */
  dataNames: string[];
  /** Total versions across all data names. */
  versionCount: number;
  /** Bytes on disk across all versions. */
  bytesReclaimed: number;
}

/**
 * Result of orphaned-data reclamation.
 */
export interface OrphanReclamationResult {
  /** Number of orphaned models whose data was reclaimed. */
  modelsReclaimed: number;
  /** Number of data entries (distinct data names) reclaimed. */
  dataEntriesReclaimed: number;
  /** Number of versions hard-deleted. */
  versionsDeleted: number;
  /** Bytes reclaimed. */
  bytesReclaimed: number;
  /** Whether this was a dry run. */
  dryRun: boolean;
  /** The orphaned models that were (or would be) reclaimed. */
  reclaimedModels: Array<{
    type: string;
    modelId: string;
    modelName?: string;
    dataNames: string[];
    versionCount: number;
    bytesReclaimed: number;
  }>;
}

/**
 * Service for managing data lifecycle and garbage collection.
 */
export interface DataLifecycleService {
  /**
   * Finds all expired data entries.
   */
  findExpiredData(): Promise<ExpiredDataInfo[]>;

  /**
   * Previews version-based garbage collection across all unique models without
   * deleting anything. Returns one entry per (modelType, modelId) that has
   * versions to prune.
   */
  previewVersionGarbage(): Promise<VersionGcPreviewInfo[]>;

  /**
   * Deletes expired data and applies version garbage collection.
   *
   * @param options - Options for the operation
   * @returns Statistics about the operation
   */
  deleteExpiredData(options?: {
    dryRun?: boolean;
  }): Promise<LifecycleGCResult>;

  /**
   * Deletes every version of model data created before `cutoff`, including
   * a data name's latest version (strict retention). A name whose latest
   * version is older than the cutoff is deleted whole; otherwise only its
   * older versions go. Model types exempt from retention, and names with an
   * in-flight deferred write, are left alone.
   */
  deleteDataOlderThan(
    cutoff: Date,
    options: DeleteDataOlderThanOptions,
  ): Promise<DataRetentionResult>;

  /**
   * Finds all orphaned data — data whose owning model definition no longer
   * exists, per the injected `isModelLive` predicate. Results are aggregated
   * per (type, modelId).
   */
  findOrphanedData(isModelLive: IsModelLive): Promise<OrphanedDataInfo[]>;

  /**
   * Reclaims orphaned data (all versions of every data name owned by a model
   * with no live definition).
   *
   * @param options - The `isModelLive` predicate and an optional `dryRun` flag
   * @returns Statistics about the operation
   */
  deleteOrphanedData(options: {
    isModelLive: IsModelLive;
    dryRun?: boolean;
  }): Promise<OrphanReclamationResult>;

  /**
   * Checks if a data entry has expired.
   *
   * @param data - The data to check
   * @returns True if the data has expired
   */
  isExpired(data: Data): Promise<boolean>;

  /**
   * Calculates the expiration date for a lifetime.
   *
   * @param lifetime - The lifetime configuration
   * @param createdAt - When the data was created
   * @returns The expiration date, or null if it doesn't expire
   */
  calculateExpiration(lifetime: Lifetime, createdAt: Date): Date | null;
}

/**
 * Default implementation of DataLifecycleService.
 */
export class DefaultDataLifecycleService implements DataLifecycleService {
  constructor(
    private readonly dataRepo: UnifiedDataRepository,
    private readonly workflowRunRepo: WorkflowRunRepository,
  ) {}

  calculateExpiration(lifetime: Lifetime, createdAt: Date): Date | null {
    if (lifetime === "infinite") {
      return null; // Never expires
    }

    if (lifetime === "ephemeral") {
      // Ephemeral data is routed to the in-memory repository by
      // CompositeUnifiedDataRepository and never reaches persistent storage.
      return null;
    }

    if (lifetime === "job" || lifetime === "workflow") {
      // These are handled separately via dependency tracking
      return null;
    }

    // Duration-based lifetime
    try {
      const durationMs = parseDataDuration(lifetime);
      return new Date(createdAt.getTime() + durationMs);
    } catch (error) {
      logger.error("Failed to parse lifetime duration: {lifetime}", {
        lifetime,
        error,
      });
      return null;
    }
  }

  async isExpired(data: Data): Promise<boolean> {
    const expiration = this.calculateExpiration(
      data.lifetime,
      new Date(data.createdAt),
    );

    if (data.lifetime === "workflow" || data.lifetime === "job") {
      // Check if the workflow run still exists
      const workflowId = data.ownerDefinition.workflowId;
      const workflowRunId = data.ownerDefinition.workflowRunId;

      if (!workflowId || !workflowRunId) {
        logger.warn(
          "Data '{dataName}' has {lifetime} lifetime but missing workflowId or workflowRunId",
          { dataName: data.name, lifetime: data.lifetime },
        );
        return false;
      }

      try {
        const workflowRun = await this.workflowRunRepo.findById(
          createWorkflowId(workflowId),
          createWorkflowRunId(workflowRunId),
        );
        return workflowRun === null; // Expired if workflow run is deleted
      } catch (error) {
        logger.error(
          "Error checking workflow run {workflowId}/{workflowRunId}",
          { workflowId, workflowRunId, error },
        );
        return false; // Don't delete on error
      }
    }

    if (expiration === null) {
      return false; // No expiration
    }

    return Date.now() > expiration.getTime();
  }

  async findExpiredData(): Promise<ExpiredDataInfo[]> {
    const expired: ExpiredDataInfo[] = [];

    const allData = await this.dataRepo.findAllGlobal();
    for (const { data, modelType, modelId } of allData) {
      // Skip deletion markers — they are tombstones and should not be auto-expired
      if (data.isDeleted) {
        continue;
      }
      try {
        const isExpired = await this.isExpired(data);
        if (isExpired) {
          let reason: ExpiredDataInfo["reason"];
          if (data.lifetime === "workflow" || data.lifetime === "job") {
            reason = data.lifetime === "workflow"
              ? "workflow-deleted"
              : "job-deleted";
          } else {
            reason = "duration-expired";
          }

          expired.push({
            type: modelType,
            modelId,
            dataName: data.name,
            data,
            reason,
          });
        }
      } catch (error) {
        logger.error(
          "Error checking data {path}",
          {
            path: `${modelType.toDirectoryPath()}/${modelId}/${data.name}`,
            error,
          },
        );
        // Continue with other data
      }
    }

    return expired;
  }

  async previewVersionGarbage(): Promise<VersionGcPreviewInfo[]> {
    const previews: VersionGcPreviewInfo[] = [];
    const allData = await this.dataRepo.findAllGlobal();
    const seen = new Set<string>();
    for (const { modelType, modelId } of allData) {
      const key = `${modelType.toDirectoryPath()}/${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const result = await this.dataRepo.collectGarbage(
          modelType,
          modelId,
          { dryRun: true },
        );
        if (result.versionsRemoved > 0) {
          previews.push({
            type: modelType,
            modelId,
            versionsWouldBeRemoved: result.versionsRemoved,
            bytesWouldBeReclaimed: result.bytesReclaimed,
          });
        }
      } catch (error) {
        logger.error(
          "Error previewing version GC on {path}",
          { path: key, error },
        );
      }
    }
    return previews;
  }

  async deleteExpiredData(options?: {
    dryRun?: boolean;
  }): Promise<LifecycleGCResult> {
    const dryRun = options?.dryRun ?? false;

    // Single findAllGlobal() scan — reused for both expired-data detection
    // and version GC's unique-model iteration
    const allData = await this.dataRepo.findAllGlobal();

    // Phase 1: Detect expired data (inline logic from findExpiredData)
    const expiredData: ExpiredDataInfo[] = [];
    for (const { data, modelType, modelId } of allData) {
      if (data.isDeleted) continue;
      try {
        const isExpired = await this.isExpired(data);
        if (isExpired) {
          let reason: ExpiredDataInfo["reason"];
          if (data.lifetime === "workflow" || data.lifetime === "job") {
            reason = data.lifetime === "workflow"
              ? "workflow-deleted"
              : "job-deleted";
          } else {
            reason = "duration-expired";
          }
          expiredData.push({
            type: modelType,
            modelId,
            dataName: data.name,
            data,
            reason,
          });
        }
      } catch (error) {
        console.error(
          `Error checking data ${modelType.toDirectoryPath()}/${modelId}/${data.name}:`,
          error,
        );
      }
    }

    let versionsDeleted = 0;
    let bytesReclaimed = 0;
    const expiredEntries: LifecycleGCResult["expiredEntries"] = [];

    for (const expired of expiredData) {
      const { type, modelId, dataName } = expired;

      // Count versions before GC
      const versions = await this.dataRepo.listVersions(
        type,
        modelId,
        dataName,
      );

      for (const version of versions) {
        const contentPath = this.dataRepo.getContentPath(
          type,
          modelId,
          dataName,
          version,
        );
        try {
          const stat = await Deno.stat(contentPath);
          bytesReclaimed += stat.size;
        } catch {
          // Ignore stat errors for missing files
        }
      }
      versionsDeleted += versions.length;

      if (!dryRun) {
        await this.dataRepo.delete(type, modelId, dataName);
      }

      expiredEntries.push({
        type: type.toDirectoryPath(),
        modelId,
        dataName,
        reason: expired.reason,
        versionCount: versions.length,
      });
    }

    // Phase 2: Version-based garbage collection on all unique models.
    // Reuses the allData result from the single findAllGlobal() call. Runs in
    // both dry-run and real mode — the repository computes would-be counts
    // without deleting when dryRun is true.
    const seen = new Set<string>();
    for (const { modelType, modelId } of allData) {
      const key = `${modelType.toDirectoryPath()}/${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const result = await this.dataRepo.collectGarbage(
          modelType,
          modelId,
          { dryRun },
        );
        versionsDeleted += result.versionsRemoved;
        bytesReclaimed += result.bytesReclaimed;
      } catch (error) {
        logger.error(
          "Error running GC on {path}",
          { path: `${modelType.toDirectoryPath()}/${modelId}`, error },
        );
      }
    }

    return {
      dataEntriesExpired: expiredEntries.length,
      versionsDeleted,
      bytesReclaimed,
      dryRun,
      expiredEntries,
    };
  }

  async deleteDataOlderThan(
    cutoff: Date,
    options: DeleteDataOlderThanOptions,
  ): Promise<DataRetentionResult> {
    const { dryRun, limit, isExempt } = options;
    const result: DataRetentionResult = {
      entriesDeleted: 0,
      versionsDeleted: 0,
      bytesReclaimed: 0,
      more: false,
      failed: 0,
      dryRun,
    };
    const repo = this.dataRepo;
    if (!repo.findVersionsCreatedBefore) return result;

    // Names already settled (deleted whole, or skipped) and versions already
    // counted. A dry run deletes nothing, so later pages list them again.
    const settledNames = new Set<string>();
    const countedVersions = new Set<string>();
    const atLimit = () =>
      limit !== undefined && result.versionsDeleted >= limit;

    let cursor: string | undefined;
    do {
      const page = await repo.findVersionsCreatedBefore(cutoff, {
        limit: RETENTION_PAGE_SIZE,
        cursor,
        excludeTypes: options.exemptTypes,
      });
      cursor = page.cursor;

      // Group the page's versions by data name, oldest name first.
      const groups = new Map<string, typeof page.versions>();
      for (const aged of page.versions) {
        const key = [aged.type.normalized, aged.modelId, aged.dataName].join(
          "\0",
        );
        const group = groups.get(key);
        if (group) group.push(aged);
        else groups.set(key, [aged]);
      }

      for (const [nameKey, group] of groups) {
        if (settledNames.has(nameKey)) continue;
        const { type, modelId, dataName } = group[0];
        if (isExempt(type.normalized)) {
          settledNames.add(nameKey);
          continue;
        }
        if (atLimit()) {
          result.more = true;
          return result;
        }
        try {
          // An in-flight deferred write would be lost with its name, and
          // which version will be latest is not known until it settles.
          if (await repo.hasPendingVersions?.(type, modelId, dataName)) {
            settledNames.add(nameKey);
            continue;
          }
          const latestVersion = repo.getLatestVersionSync(
            type,
            modelId,
            dataName,
          );
          if (latestVersion === null) {
            // No promoted latest to judge the name by; leave it.
            settledNames.add(nameKey);
            continue;
          }
          // Read the latest version itself, not a rename's target.
          const latest = await repo.findByName(
            type,
            modelId,
            dataName,
            latestVersion,
          );

          if (
            !options.keepLatestVersion && latest &&
            latest.createdAt.getTime() < cutoff.getTime()
          ) {
            const sizes = new Map(group.map((v) => [v.version, v.size]));
            const versions = await repo.listVersions(type, modelId, dataName);
            // Version by version, never the name's directory: a writer
            // without the global lock (a serve run) may add a version
            // after this read, and the per-version path keeps whatever
            // was not listed here, re-pointing latest at it.
            const listed = versions.filter((v) => v <= latestVersion)
              .sort((a, b) => a - b);
            let bytes = 0;
            for (const version of listed) {
              bytes += sizes.get(version) ??
                (await repo.findByName(type, modelId, dataName, version))
                  ?.size ??
                0;
            }
            if (!dryRun) {
              // Recorded first: a write after the name is emptied continues
              // above its last number, never reusing one another clone may
              // still hold.
              const newest = maxOf(listed);
              if (newest !== undefined) {
                await repo.raiseVersionFloor?.(
                  type,
                  modelId,
                  dataName,
                  newest,
                );
              }
              for (const version of listed) {
                await repo.delete(type, modelId, dataName, version);
              }
            }
            settledNames.add(nameKey);
            result.entriesDeleted++;
            result.versionsDeleted += listed.length;
            result.bytesReclaimed += bytes;
            continue;
          }

          // The latest version is within retention: trim only the older
          // versions, through the per-version path that keeps the latest
          // marker and catalog flags consistent.
          for (const aged of group) {
            if (aged.version >= latestVersion) continue;
            const versionKey = `${nameKey}\0${aged.version}`;
            if (countedVersions.has(versionKey)) continue;
            if (atLimit()) {
              result.more = true;
              return result;
            }
            if (!dryRun) {
              await repo.delete(type, modelId, dataName, aged.version);
            }
            countedVersions.add(versionKey);
            result.versionsDeleted++;
            result.bytesReclaimed += aged.size;
          }
        } catch (error) {
          logger.error(
            "Error applying data retention to {path}",
            {
              path: `${type.toDirectoryPath()}/${modelId}/${dataName}`,
              error,
            },
          );
          settledNames.add(nameKey);
          result.failed++;
        }
      }
    } while (cursor !== undefined);

    return result;
  }

  async findOrphanedData(
    isModelLive: IsModelLive,
  ): Promise<OrphanedDataInfo[]> {
    const allData = await this.dataRepo.findAllGlobal();

    // Group by (type, modelId) — the consistency boundary for a model's data.
    const groups = new Map<
      string,
      { type: ModelType; modelId: string; items: Data[] }
    >();
    for (const { data, modelType, modelId } of allData) {
      if (data.isDeleted) continue;
      const key = `${modelType.toDirectoryPath()}/${modelId}`;
      let group = groups.get(key);
      if (!group) {
        group = { type: modelType, modelId, items: [] };
        groups.set(key, group);
      }
      group.items.push(data);
    }

    const orphans: OrphanedDataInfo[] = [];
    for (const group of groups.values()) {
      // A model is orphaned iff its definition no longer exists. This check
      // matches `swamp model get` semantics (models/ AND auto-definitions/).
      if (await isModelLive(group.type, group.modelId)) continue;

      const dataNames = [...new Set(group.items.map((d) => d.name))];
      let versionCount = 0;
      let bytesReclaimed = 0;
      for (const name of dataNames) {
        const versions = await this.dataRepo.listVersions(
          group.type,
          group.modelId,
          name,
        );
        versionCount += versions.length;
        for (const version of versions) {
          const contentPath = this.dataRepo.getContentPath(
            group.type,
            group.modelId,
            name,
            version,
          );
          try {
            const stat = await Deno.stat(contentPath);
            bytesReclaimed += stat.size;
          } catch {
            // Ignore stat errors for missing files
          }
        }
      }

      orphans.push({
        type: group.type,
        modelId: group.modelId,
        // Report entries carry no modelName tag — take it from whichever
        // item has a non-empty one.
        modelName: group.items
          .map((d) => d.tags["modelName"])
          .find((n) => n !== undefined && n !== ""),
        dataNames,
        versionCount,
        bytesReclaimed,
      });
    }

    return orphans;
  }

  async deleteOrphanedData(options: {
    isModelLive: IsModelLive;
    dryRun?: boolean;
  }): Promise<OrphanReclamationResult> {
    const dryRun = options.dryRun ?? false;
    const orphans = await this.findOrphanedData(options.isModelLive);

    let versionsDeleted = 0;
    let bytesReclaimed = 0;
    let dataEntriesReclaimed = 0;
    const reclaimedModels: OrphanReclamationResult["reclaimedModels"] = [];

    for (const orphan of orphans) {
      versionsDeleted += orphan.versionCount;
      bytesReclaimed += orphan.bytesReclaimed;
      dataEntriesReclaimed += orphan.dataNames.length;

      if (!dryRun) {
        for (const name of orphan.dataNames) {
          await this.dataRepo.delete(orphan.type, orphan.modelId, name);
        }
      }

      reclaimedModels.push({
        type: orphan.type.toDirectoryPath(),
        modelId: orphan.modelId,
        modelName: orphan.modelName,
        dataNames: orphan.dataNames,
        versionCount: orphan.versionCount,
        bytesReclaimed: orphan.bytesReclaimed,
      });
    }

    return {
      modelsReclaimed: orphans.length,
      dataEntriesReclaimed,
      versionsDeleted,
      bytesReclaimed,
      dryRun,
      reclaimedModels,
    };
  }
}
