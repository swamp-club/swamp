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

import { getLogger } from "@logtape/logtape";
import type { Data } from "./data.ts";
import type { Lifetime } from "./data_metadata.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
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
  ) {}

  calculateExpiration(lifetime: Lifetime, createdAt: Date): Date | null {
    if (lifetime === "infinite") {
      return null; // Never expires
    }

    if (lifetime === "ephemeral") {
      // Not implemented yet - requires tracking execution context
      logger.warn("Ephemeral lifetime is not yet implemented");
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

      if (!dryRun) {
        // Calculate bytes to reclaim before deleting
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
        // Hard-delete all versions
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

    // Phase 2: Version-based garbage collection on all unique models
    // Reuses the allData result from the single findAllGlobal() call
    if (!dryRun) {
      const seen = new Set<string>();
      for (const { modelType, modelId } of allData) {
        const key = `${modelType.toDirectoryPath()}/${modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          const result = await this.dataRepo.collectGarbage(
            modelType,
            modelId,
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
