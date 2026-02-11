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

import { join } from "@std/path";
import type { Data } from "./data.ts";
import type { Lifetime } from "./data_metadata.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { WorkflowRunRepository } from "../workflows/repositories.ts";
import { ModelType } from "../models/model_type.ts";
import {
  createWorkflowId,
  createWorkflowRunId,
} from "../workflows/workflow_id.ts";

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
 * Result of garbage collection operation.
 */
export interface LifecycleGCResult {
  /** Number of data entries marked as expired (symlink removed) */
  dataEntriesExpired: number;
  /** Number of old versions hard deleted by version GC */
  versionsDeleted: number;
  /** Bytes reclaimed from version GC (not from soft delete) */
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
 * Service for managing data lifecycle and garbage collection.
 */
export interface DataLifecycleService {
  /**
   * Finds all expired data entries.
   */
  findExpiredData(): Promise<ExpiredDataInfo[]>;

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
    private readonly repoDir: string,
  ) {}

  calculateExpiration(lifetime: Lifetime, createdAt: Date): Date | null {
    if (lifetime === "infinite") {
      return null; // Never expires
    }

    if (lifetime === "ephemeral") {
      // Not implemented yet - requires tracking execution context
      console.warn("Ephemeral lifetime is not yet implemented");
      return null;
    }

    if (lifetime === "job" || lifetime === "workflow") {
      // These are handled separately via dependency tracking
      return null;
    }

    // Duration-based lifetime
    try {
      const durationMs = this.parseDuration(lifetime);
      return new Date(createdAt.getTime() + durationMs);
    } catch (error) {
      console.error(`Failed to parse lifetime duration: ${lifetime}`, error);
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
        console.warn(
          `Data "${data.name}" has ${data.lifetime} lifetime but missing workflowId or workflowRunId`,
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
        console.error(
          `Error checking workflow run ${workflowId}/${workflowRunId}:`,
          error,
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
    const dataDir = swampPath(this.repoDir, SWAMP_SUBDIRS.data);

    try {
      // Scan model types
      for await (const typeEntry of Deno.readDir(dataDir)) {
        if (!typeEntry.isDirectory) continue;
        const type = ModelType.create(typeEntry.name);

        const typeDir = join(dataDir, type.toDirectoryPath());

        // Scan model IDs
        for await (const modelEntry of Deno.readDir(typeDir)) {
          if (!modelEntry.isDirectory) continue;
          const modelId = modelEntry.name;

          const modelDir = join(typeDir, modelId);

          // Scan data names
          for await (const dataEntry of Deno.readDir(modelDir)) {
            if (!dataEntry.isDirectory) continue;
            const dataName = dataEntry.name;

            // Load the latest version metadata
            try {
              const data = await this.dataRepo.findByName(
                type,
                modelId,
                dataName,
              );
              if (!data) continue;

              const isExpired = await this.isExpired(data);
              if (isExpired) {
                let reason: ExpiredDataInfo["reason"];
                if (
                  data.lifetime === "workflow" ||
                  data.lifetime === "job"
                ) {
                  reason = data.lifetime === "workflow"
                    ? "workflow-deleted"
                    : "job-deleted";
                } else {
                  reason = "duration-expired";
                }

                expired.push({
                  type,
                  modelId,
                  dataName,
                  data,
                  reason,
                });
              }
            } catch (error) {
              console.error(
                `Error checking data ${type}/${modelId}/${dataName}:`,
                error,
              );
              // Continue with other data
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Data directory doesn't exist yet
        return [];
      }
      throw error;
    }

    return expired;
  }

  async deleteExpiredData(options?: {
    dryRun?: boolean;
  }): Promise<LifecycleGCResult> {
    const dryRun = options?.dryRun ?? false;
    const expiredData = await this.findExpiredData();

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

      if (!dryRun) {
        // Soft delete: remove latest symlink
        await this.dataRepo.removeLatestSymlink(type, modelId, dataName);
      }

      expiredEntries.push({
        type: type.toDirectoryPath(),
        modelId,
        dataName,
        reason: expired.reason,
        versionCount: versions.length,
      });
    }

    // Now run version-based garbage collection on all models
    // This hard-deletes old versions based on garbageCollection policy
    if (!dryRun) {
      const dataDir = swampPath(this.repoDir, SWAMP_SUBDIRS.data);
      try {
        for await (const typeEntry of Deno.readDir(dataDir)) {
          if (!typeEntry.isDirectory) continue;
          const type = ModelType.create(typeEntry.name);
          const typeDir = join(dataDir, type.toDirectoryPath());

          for await (const modelEntry of Deno.readDir(typeDir)) {
            if (!modelEntry.isDirectory) continue;
            const modelId = modelEntry.name;

            try {
              const result = await this.dataRepo.collectGarbage(
                type,
                modelId,
              );
              versionsDeleted += result.versionsRemoved;
              bytesReclaimed += result.bytesReclaimed;
            } catch (error) {
              console.error(
                `Error running GC on ${type.toDirectoryPath()}/${modelId}:`,
                error,
              );
            }
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          console.error("Error during version GC:", error);
        }
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

  private parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)(mo|y|h|m|d|w)$/);
    if (!match) {
      throw new Error(`Invalid duration format: ${duration}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case "mo":
        return value * 30 * 24 * 60 * 60 * 1000;
      case "y":
        return value * 365 * 24 * 60 * 60 * 1000;
      case "h":
        return value * 60 * 60 * 1000;
      case "m":
        return value * 60 * 1000;
      case "d":
        return value * 24 * 60 * 60 * 1000;
      case "w":
        return value * 7 * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Unknown duration unit: ${unit}`);
    }
  }
}
