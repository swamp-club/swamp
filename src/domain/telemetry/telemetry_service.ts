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
  TelemetryFlushRecordRepository,
  TelemetryRepository,
} from "./repositories.ts";
import { applyFlushAttempt } from "./telemetry_flush_record.ts";
import type {
  TelemetryFlushResult,
  TelemetrySender,
} from "./telemetry_sender.ts";
import { TelemetryEntry } from "./telemetry_entry.ts";
import type { CommandInvocationData } from "./command_invocation.ts";
import type { InvocationContextData } from "./invocation_context.ts";
import { generateTelemetryId, type TelemetryId } from "./telemetry_id.ts";
import type { WorkflowContextData } from "./workflow_context.ts";
import {
  createErrorResult,
  createSuccessResult,
  type InvocationResultData,
} from "./invocation_result.ts";
import type { WorkflowTriggerSource } from "./trigger_source.ts";
import type { AuthMode } from "../auth/auth_gate_policy.ts";
import { UserError } from "../errors.ts";

const DEFAULT_FLUSH_BATCH_SIZE = 25;

export interface TelemetryFlushConfig {
  sender: TelemetrySender;
  distinctId: string;
  repoId?: string;
  authToken?: string;
  batchSize?: number;
  keepFlushed?: boolean;
  signal?: AbortSignal;
  /**
   * ids already sent but not marked flushed stay on disk, so skip them to avoid
   * sending the same invocation once per attempt
   */
  skipIds?: ReadonlySet<string>;
}

export interface TelemetrySingleFlushConfig {
  entry: TelemetryEntry;
  sender: TelemetrySender;
  distinctId: string;
  repoId?: string;
  authToken?: string;
  keepFlushed?: boolean;
  signal?: AbortSignal;
}

/**
 * distinct from TelemetryFlushResult, which is the sender's vocabulary; marking
 * is a persistence concern so it is reported here
 */
export interface TelemetryFlushOutcome {
  result: TelemetryFlushResult;
  unmarkedIds: string[];
  sentCount: number;
}

export interface TelemetryStats {
  totalInvocations: number;
  successCount: number;
  errorCount: number;
  userErrorCount: number;
  successRate: number;
  errorRate: number;
  commandFrequency: Record<string, number>;
  optionFrequency: Record<string, number>;
  averageDurationByCommand: Record<string, number>;
  platformDistribution: Record<string, number>;
  daysAnalyzed: number;
}

const DEFAULT_RETENTION_DAYS = 2;

const HARD_RETENTION_DAYS = 7;

/**
 * longer than flushed retention because a quarantined entry is evidence, but
 * bounded since it is not data we still expect to deliver
 */
const QUARANTINE_RETENTION_DAYS = 30;

/**
 * invocationContext is captured once as it does not change within an
 * invocation; invocationId is pre-allocated so child entries can use it as
 * parentInvocationId before the parent is recorded
 */
export class TelemetryService {
  readonly invocationId: TelemetryId;

  /**
   * serializes flushes so two callers cannot read the same batch before either
   * marks it and send it twice; forks do not share this lock, which is safe
   * only because forks are write-only
   */
  #flushChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repository: TelemetryRepository,
    private readonly swampVersion: string,
    private invocationContext?: InvocationContextData,
    invocationId?: TelemetryId,
    private readonly triggerSource?: WorkflowTriggerSource,
    private readonly initiatedBy?: string,
    /**
     * entries are stamped with the endpoint in effect and a flush drains only
     * entries stamped for it or unstamped, so an entry never goes to a
     * different endpoint
     */
    private readonly endpoint?: string,
    private readonly flushRecords?: TelemetryFlushRecordRepository,
  ) {
    this.invocationId = invocationId ?? generateTelemetryId();
  }

  /**
   * the auth gate runs after the service is built, so this is the one context
   * part set later; later entries and forks carry it
   */
  setAuthMode(authMode: AuthMode): void {
    if (!this.invocationContext) return;
    this.invocationContext = { ...this.invocationContext, authMode };
  }

  /**
   * a daemon's unit of invocation is a workflow run, so a fork gives each its
   * own id; forks are write-only and must never flush, as they do not share the
   * flush lock and could send a batch twice
   */
  forkForRun(
    triggerSource?: WorkflowTriggerSource,
    initiatedBy?: string,
  ): TelemetryService {
    return new TelemetryService(
      this.repository,
      this.swampVersion,
      this.invocationContext,
      generateTelemetryId(),
      triggerSource ?? this.triggerSource,
      initiatedBy,
      this.endpoint,
    );
  }

  async recordSuccess(
    invocation: CommandInvocationData,
    startedAt: Date,
  ): Promise<void> {
    const entry = TelemetryEntry.create({
      id: this.invocationId,
      invocation,
      result: createSuccessResult(),
      startedAt,
      completedAt: new Date(),
      swampVersion: this.swampVersion,
      denoVersion: Deno.version.deno,
      platform: Deno.build.os,
      invocationContext: this.invocationContext,
      triggerSource: this.triggerSource,
      initiatedBy: this.initiatedBy,
      endpoint: this.endpoint,
    });

    await this.repository.save(entry);
  }

  async recordError(
    invocation: CommandInvocationData,
    startedAt: Date,
    error: Error,
    knownValues: readonly string[] = [],
  ): Promise<void> {
    const isUserError = error instanceof UserError;
    const result: InvocationResultData = {
      ...createErrorResult(error, isUserError, knownValues),
    };

    const entry = TelemetryEntry.create({
      id: this.invocationId,
      invocation,
      result,
      startedAt,
      completedAt: new Date(),
      swampVersion: this.swampVersion,
      denoVersion: Deno.version.deno,
      platform: Deno.build.os,
      invocationContext: this.invocationContext,
      triggerSource: this.triggerSource,
      initiatedBy: this.initiatedBy,
      endpoint: this.endpoint,
    });

    await this.repository.save(entry);
  }

  /**
   * the caller supplies completedAt because the bridge may close invocations
   * after a deferred event; pre-method failures pass one instant for both,
   * giving durationMs 0 as the method never ran
   */
  async recordChildInvocation(
    invocation: CommandInvocationData,
    startedAt: Date,
    completedAt: Date,
    error: Error | null,
    parentInvocationId: string,
    workflowContext: WorkflowContextData,
  ): Promise<void> {
    const result: InvocationResultData = error === null
      ? { ...createSuccessResult() }
      : { ...createErrorResult(error, error instanceof UserError) };

    const entry = TelemetryEntry.create({
      invocation,
      result,
      startedAt,
      completedAt,
      swampVersion: this.swampVersion,
      denoVersion: Deno.version.deno,
      platform: Deno.build.os,
      invocationContext: this.invocationContext,
      parentInvocationId,
      workflowContext,
      triggerSource: this.triggerSource,
      initiatedBy: this.initiatedBy,
      endpoint: this.endpoint,
    });

    await this.repository.save(entry);
  }

  /**
   * flushed entries are cleaned after retentionDays; unflushed ones survive
   * until HARD_RETENTION_DAYS to allow retry, then are deleted to prevent
   * unbounded growth
   */
  async cleanupOldTelemetry(
    retentionDays: number = DEFAULT_RETENTION_DAYS,
  ): Promise<void> {
    const flushedCutoff = new Date();
    flushedCutoff.setDate(flushedCutoff.getDate() - retentionDays);

    const hardCutoff = new Date();
    hardCutoff.setDate(hardCutoff.getDate() - HARD_RETENTION_DAYS);

    try {
      await Promise.all([
        this.repository.deleteOlderThan(flushedCutoff),
        this.repository.deleteAllOlderThan(hardCutoff),
      ]);
    } catch (error) {
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Telemetry] Cleanup failed:", error);
      }
    }
  }

  /**
   * the only cleanup a daemon may run: cleanupOldTelemetry also deletes
   * unflushed entries, which would discard sendable telemetry while the
   * endpoint is unreachable, so the daemon keeps them
   */
  async pruneFlushedTelemetry(
    retentionDays: number = DEFAULT_RETENTION_DAYS,
  ): Promise<void> {
    const flushedCutoff = new Date();
    flushedCutoff.setDate(flushedCutoff.getDate() - retentionDays);

    const quarantineCutoff = new Date();
    quarantineCutoff.setDate(
      quarantineCutoff.getDate() - QUARANTINE_RETENTION_DAYS,
    );

    try {
      await Promise.all([
        this.repository.deleteOlderThan(flushedCutoff),
        this.repository.deleteQuarantinedOlderThan(quarantineCutoff),
      ]);
    } catch (error) {
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Telemetry] Prune failed:", error);
      }
    }
  }

  async quarantineEntry(entry: TelemetryEntry): Promise<void> {
    await this.repository.quarantine(entry);
  }

  /**
   * concurrent calls are serialized: a caller arriving mid-flush awaits it,
   * else two callers could read the same batch before either marks it and send
   * every entry twice
   */
  flushTelemetry(
    config: TelemetryFlushConfig,
  ): Promise<TelemetryFlushOutcome> {
    return this.#serialize(async () => {
      const batchSize = config.batchSize ?? DEFAULT_FLUSH_BATCH_SIZE;
      const keepFlushed = config.keepFlushed ?? false;

      try {
        return await this.doFlush(
          config.sender,
          config.distinctId,
          batchSize,
          keepFlushed,
          config.repoId,
          config.authToken,
          config.signal,
          config.skipIds,
        );
      } catch {
        return {
          result: { ok: false, reason: "unexpected error" },
          unmarkedIds: [],
          sentCount: 0,
        };
      }
    });
  }

  async findUnflushedForIsolation(
    limit: number,
    skipIds?: ReadonlySet<string>,
  ): Promise<TelemetryEntry[]> {
    const entries = await this.repository.findUnflushed(limit, this.endpoint);
    return skipIds?.size
      ? entries.filter((entry) => !skipIds.has(entry.id))
      : entries;
  }

  /**
   * a batch is all-or-nothing, so one bad entry hides behind the same failure
   * as its blameless neighbours until they are sent apart
   */
  flushEntry(
    config: TelemetrySingleFlushConfig,
  ): Promise<TelemetryFlushOutcome> {
    return this.#serialize(async () => {
      // Never send an entry recorded for another endpoint; it stays spooled
      // for a run that resolves that endpoint.
      if (
        this.endpoint !== undefined &&
        !config.entry.isFlushableTo(this.endpoint)
      ) {
        return { result: { ok: true }, unmarkedIds: [], sentCount: 0 };
      }
      try {
        const result = await config.sender.sendBatch(
          [config.entry],
          config.distinctId,
          config.repoId,
          config.authToken,
          config.signal,
        );
        await this.#recordFlushAttempt(result, 1);
        const unmarkedIds: string[] = [];
        if (result.ok) {
          const marked = await this.repository.markFlushed(
            config.entry,
            config.keepFlushed ?? false,
          );
          if (!marked) unmarkedIds.push(config.entry.id);
        }
        return { result, unmarkedIds, sentCount: result.ok ? 1 : 0 };
      } catch {
        return {
          result: { ok: false, reason: "unexpected error" },
          unmarkedIds: [],
          sentCount: 0,
        };
      }
    });
  }

  /** best-effort: the record is advisory, so it never changes a flush outcome */
  async #recordFlushAttempt(
    result: TelemetryFlushResult,
    attempted: number,
  ): Promise<void> {
    if (!this.flushRecords) return;
    try {
      const previous = await this.flushRecords.read();
      await this.flushRecords.write(
        applyFlushAttempt(previous, {
          at: new Date(),
          ok: result.ok,
          reason: result.reason,
          sentCount: result.ok ? attempted : 0,
        }),
      );
    } catch {
      // A failed record write must not turn a delivered batch into a failure.
    }
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#flushChain.then(fn, fn);
    // Swallow on the chain only — the caller still sees the real outcome.
    this.#flushChain = run.then(() => {}, () => {});
    return run;
  }

  private async doFlush(
    sender: TelemetrySender,
    distinctId: string,
    batchSize: number,
    keepFlushed: boolean,
    repoId?: string,
    authToken?: string,
    signal?: AbortSignal,
    skipIds?: ReadonlySet<string>,
  ): Promise<TelemetryFlushOutcome> {
    const found = await this.repository.findUnflushed(
      batchSize,
      this.endpoint,
    );
    // Entries the caller already delivered but could not mark are still on
    // disk. Re-sending them would count the same invocation twice.
    const entries = skipIds?.size
      ? found.filter((entry) => !skipIds.has(entry.id))
      : found;
    if (entries.length === 0) {
      return { result: { ok: true }, unmarkedIds: [], sentCount: 0 };
    }

    const result = await sender.sendBatch(
      entries,
      distinctId,
      repoId,
      authToken,
      signal,
    );
    await this.#recordFlushAttempt(result, entries.length);
    const unmarkedIds: string[] = [];
    if (result.ok) {
      for (const entry of entries) {
        const marked = await this.repository.markFlushed(entry, keepFlushed);
        if (!marked) unmarkedIds.push(entry.id);
      }
    }
    return { result, unmarkedIds, sentCount: result.ok ? entries.length : 0 };
  }

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

    const durationsByCommand: Record<string, number[]> = {};

    for (const entry of entries) {
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

      const commandKey = entry.invocation.subcommand
        ? `${entry.invocation.command} ${entry.invocation.subcommand}`
        : entry.invocation.command;
      stats.commandFrequency[commandKey] =
        (stats.commandFrequency[commandKey] || 0) + 1;

      if (!durationsByCommand[commandKey]) {
        durationsByCommand[commandKey] = [];
      }
      durationsByCommand[commandKey].push(entry.durationMs);

      for (const option of entry.invocation.optionKeys) {
        stats.optionFrequency[option] = (stats.optionFrequency[option] || 0) +
          1;
      }
      for (const option of entry.invocation.globalOptions) {
        stats.optionFrequency[option] = (stats.optionFrequency[option] || 0) +
          1;
      }

      stats.platformDistribution[entry.platform] =
        (stats.platformDistribution[entry.platform] || 0) + 1;
    }

    stats.successRate = (stats.successCount / stats.totalInvocations) * 100;
    stats.errorRate =
      ((stats.errorCount + stats.userErrorCount) / stats.totalInvocations) *
      100;

    for (const [command, durations] of Object.entries(durationsByCommand)) {
      const sum = durations.reduce((a, b) => a + b, 0);
      stats.averageDurationByCommand[command] = Math.round(
        sum / durations.length,
      );
    }

    return stats;
  }
}
