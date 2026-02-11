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

import type { TelemetryRepository } from "./repositories.ts";
import type { TelemetrySender } from "./telemetry_sender.ts";
import { TelemetryEntry } from "./telemetry_entry.ts";
import type { CommandInvocationData } from "./command_invocation.ts";
import {
  createErrorResult,
  createSuccessResult,
  type InvocationResultData,
} from "./invocation_result.ts";
import { UserError } from "../errors.ts";

/** Default flush batch size */
const DEFAULT_FLUSH_BATCH_SIZE = 25;

/**
 * Configuration for flushing telemetry to a remote endpoint.
 */
export interface TelemetryFlushConfig {
  sender: TelemetrySender;
  distinctId: string;
  batchSize?: number;
  keepFlushed?: boolean;
}

/**
 * Aggregated telemetry statistics.
 */
export interface TelemetryStats {
  /** Total number of invocations */
  totalInvocations: number;
  /** Number of successful invocations */
  successCount: number;
  /** Number of error invocations */
  errorCount: number;
  /** Number of user error invocations */
  userErrorCount: number;
  /** Success rate as a percentage */
  successRate: number;
  /** Error rate as a percentage */
  errorRate: number;
  /** Command frequency map (command -> count) */
  commandFrequency: Record<string, number>;
  /** Option frequency map (option -> count) */
  optionFrequency: Record<string, number>;
  /** Average duration by command (command -> average ms) */
  averageDurationByCommand: Record<string, number>;
  /** Platform distribution (platform -> count) */
  platformDistribution: Record<string, number>;
  /** Number of days analyzed */
  daysAnalyzed: number;
}

/** Default retention period in days */
const DEFAULT_RETENTION_DAYS = 2;

/**
 * Service for recording and analyzing CLI telemetry.
 */
export class TelemetryService {
  constructor(
    private readonly repository: TelemetryRepository,
    private readonly swampVersion: string,
  ) {}

  /**
   * Records a successful CLI invocation.
   *
   * @param invocation - The command invocation data
   * @param startedAt - When the command started
   */
  async recordSuccess(
    invocation: CommandInvocationData,
    startedAt: Date,
  ): Promise<void> {
    const entry = TelemetryEntry.create({
      invocation,
      result: createSuccessResult(),
      startedAt,
      completedAt: new Date(),
      swampVersion: this.swampVersion,
      denoVersion: Deno.version.deno,
      platform: Deno.build.os,
    });

    await this.repository.save(entry);
  }

  /**
   * Records a failed CLI invocation.
   *
   * @param invocation - The command invocation data
   * @param startedAt - When the command started
   * @param error - The error that occurred
   */
  async recordError(
    invocation: CommandInvocationData,
    startedAt: Date,
    error: Error,
  ): Promise<void> {
    const isUserError = error instanceof UserError;
    const result: InvocationResultData = {
      ...createErrorResult(error, isUserError),
    };

    const entry = TelemetryEntry.create({
      invocation,
      result,
      startedAt,
      completedAt: new Date(),
      swampVersion: this.swampVersion,
      denoVersion: Deno.version.deno,
      platform: Deno.build.os,
    });

    await this.repository.save(entry);
  }

  /**
   * Cleans up telemetry entries older than the retention period.
   * This method is fire-and-forget and does not block.
   *
   * @param retentionDays - Number of days to retain (default: 2)
   */
  cleanupOldTelemetry(retentionDays: number = DEFAULT_RETENTION_DAYS): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // Fire-and-forget: don't await, don't let errors propagate
    this.repository.deleteOlderThan(cutoffDate).catch((error) => {
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Telemetry] Cleanup failed:", error);
      }
    });
  }

  /**
   * Flushes unflushed telemetry entries to a remote endpoint.
   * Fire-and-forget: errors are logged but never propagated.
   *
   * @param config - Flush configuration with sender and distinctId
   */
  flushTelemetry(config: TelemetryFlushConfig): void {
    const batchSize = config.batchSize ?? DEFAULT_FLUSH_BATCH_SIZE;
    const keepFlushed = config.keepFlushed ?? false;

    // Fire-and-forget: don't await, don't let errors propagate
    this.doFlush(config.sender, config.distinctId, batchSize, keepFlushed)
      .catch(
        (error) => {
          if (Deno.env.get("SWAMP_DEBUG")) {
            console.error("[Telemetry] Flush failed:", error);
          }
        },
      );
  }

  private async doFlush(
    sender: TelemetrySender,
    distinctId: string,
    batchSize: number,
    keepFlushed: boolean,
  ): Promise<void> {
    const entries = await this.repository.findUnflushed(batchSize);
    if (entries.length === 0) return;

    const success = await sender.sendBatch(entries, distinctId);
    if (success) {
      for (const entry of entries) {
        await this.repository.markFlushed(entry, keepFlushed);
      }
    }
  }

  /**
   * Gets aggregated statistics from recent telemetry.
   *
   * @param days - Number of days to analyze (default: 2)
   * @returns Aggregated statistics
   */
  async getStats(
    days: number = DEFAULT_RETENTION_DAYS,
  ): Promise<TelemetryStats> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const entries = await this.repository.findByDateRange(startDate, endDate);

    const stats: TelemetryStats = {
      totalInvocations: entries.length,
      successCount: 0,
      errorCount: 0,
      userErrorCount: 0,
      successRate: 0,
      errorRate: 0,
      commandFrequency: {},
      optionFrequency: {},
      averageDurationByCommand: {},
      platformDistribution: {},
      daysAnalyzed: days,
    };

    if (entries.length === 0) {
      return stats;
    }

    // Track durations for averaging
    const durationsByCommand: Record<string, number[]> = {};

    for (const entry of entries) {
      // Count statuses
      switch (entry.result.status) {
        case "success":
          stats.successCount++;
          break;
        case "error":
          stats.errorCount++;
          break;
        case "user_error":
          stats.userErrorCount++;
          break;
      }

      // Count commands
      const commandKey = entry.invocation.subcommand
        ? `${entry.invocation.command} ${entry.invocation.subcommand}`
        : entry.invocation.command;
      stats.commandFrequency[commandKey] =
        (stats.commandFrequency[commandKey] || 0) + 1;

      // Track duration for averaging
      if (!durationsByCommand[commandKey]) {
        durationsByCommand[commandKey] = [];
      }
      durationsByCommand[commandKey].push(entry.durationMs);

      // Count options
      for (const option of entry.invocation.optionKeys) {
        stats.optionFrequency[option] = (stats.optionFrequency[option] || 0) +
          1;
      }
      for (const option of entry.invocation.globalOptions) {
        stats.optionFrequency[option] = (stats.optionFrequency[option] || 0) +
          1;
      }

      // Count platforms
      stats.platformDistribution[entry.platform] =
        (stats.platformDistribution[entry.platform] || 0) + 1;
    }

    // Calculate rates
    stats.successRate = (stats.successCount / stats.totalInvocations) * 100;
    stats.errorRate =
      ((stats.errorCount + stats.userErrorCount) / stats.totalInvocations) *
      100;

    // Calculate average durations
    for (const [command, durations] of Object.entries(durationsByCommand)) {
      const sum = durations.reduce((a, b) => a + b, 0);
      stats.averageDurationByCommand[command] = Math.round(
        sum / durations.length,
      );
    }

    return stats;
  }
}
