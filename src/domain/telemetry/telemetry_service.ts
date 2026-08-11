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

import type { TelemetryRepository } from "./repositories.ts";
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
import { UserError } from "../errors.ts";

/** Default flush batch size */
const DEFAULT_FLUSH_BATCH_SIZE = 25;

/**
 * Configuration for flushing telemetry to a remote endpoint.
 */
export interface TelemetryFlushConfig {
  sender: TelemetrySender;
  distinctId: string;
  repoId?: string;
  authToken?: string;
  batchSize?: number;
  keepFlushed?: boolean;
  signal?: AbortSignal;
  /**
   * Entry ids the caller has already sent successfully but could not mark
   * as flushed. They are still on disk, so `findUnflushed` keeps returning
   * them; skipping them here prevents a repeatedly-flushing caller from
   * sending the same invocation once per attempt.
   */
  skipIds?: ReadonlySet<string>;
}

/**
 * Configuration for sending one specific entry, bypassing batch selection.
 */
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
 * Result of a flush, from the service's point of view.
 *
 * Distinct from {@link TelemetryFlushResult}, which is the *sender's*
 * vocabulary and knows nothing about the local spool. Marking is a
 * persistence concern, so it is reported here rather than being folded into
 * the sender's contract.
 */
export interface TelemetryFlushOutcome {
  /** The sender's verdict for the batch it attempted. */
  result: TelemetryFlushResult;
  /** Ids that were accepted by the endpoint but could not be marked flushed. */
  unmarkedIds: string[];
  /** Entries sent in this flush. Zero means the spool was already drained. */
  sentCount: number;
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

/** Default retention period for flushed entries in days */
const DEFAULT_RETENTION_DAYS = 2;

/** Hard retention cap for all entries (including unflushed) in days */
const HARD_RETENTION_DAYS = 7;

/**
 * Retention for quarantined entries in days. Longer than the flushed
 * retention because a quarantined entry is evidence — the reason an endpoint
 * refuses a payload is usually only visible in the payload — but bounded,
 * since unlike unflushed entries it is not data we still expect to deliver.
 */
const QUARANTINE_RETENTION_DAYS = 30;

/**
 * Service for recording and analyzing CLI telemetry.
 *
 * The optional `invocationContext` is captured once at construction time —
 * the runtime conditions of one CLI invocation (configured AI tools,
 * detected harness, stdin tty state) do not change between recording a
 * success and recording an error, so a single context applies to every
 * entry the service writes.
 *
 * The `invocationId` is pre-allocated at construction time so the same id
 * can be referenced as `parentInvocationId` by child entries written
 * during the invocation (e.g. workflow-internal method invocations) before
 * the parent entry itself is recorded at the end of the CLI lifecycle.
 */
export class TelemetryService {
  readonly invocationId: TelemetryId;

  /**
   * Tail of the serialized flush chain. Every operation that reads
   * unflushed entries and marks them queues behind this, so two callers
   * holding this same service can never both read the same batch before
   * either marks it — which would send every entry in it twice. `swamp
   * serve` has exactly that shape at shutdown, when its daemon flush loop
   * and the CLI teardown flush overlap.
   *
   * The lock protects one service over one spool. Services produced by
   * {@link forkForRun} share the spool but not this field, which is safe
   * only because forks are write-only — see forkForRun.
   */
  #flushChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repository: TelemetryRepository,
    private readonly swampVersion: string,
    private readonly invocationContext?: InvocationContextData,
    invocationId?: TelemetryId,
    private readonly triggerSource?: WorkflowTriggerSource,
  ) {
    this.invocationId = invocationId ?? generateTelemetryId();
  }

  /**
   * Creates a sibling service for one workflow run executed by a daemon.
   *
   * The CLI assumes one process is one invocation, so `invocationId` is
   * allocated once per process. A long-lived `swamp serve` breaks that
   * assumption: its unit of invocation is a workflow run, and its own
   * process-level entry is not written until exit — possibly weeks later.
   * A fork gives each run its own identity to parent its child method
   * invocations to, sharing this service's repository, version, and
   * invocation context.
   *
   * IMPORTANT: forks are WRITE-ONLY. They record entries; they must never
   * flush. Flushing is serialized by a per-instance mutex (see
   * {@link #flushChain}), and a fork does not share it — so a fork that
   * flushed could race the root service over the same spool and send a batch
   * twice. If a fork ever needs to flush, move the lock down to the
   * repository first.
   */
  forkForRun(triggerSource?: WorkflowTriggerSource): TelemetryService {
    return new TelemetryService(
      this.repository,
      this.swampVersion,
      this.invocationContext,
      generateTelemetryId(),
      triggerSource ?? this.triggerSource,
    );
  }

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
    });

    await this.repository.save(entry);
  }

  /**
   * Records a child invocation that happened inside a workflow run.
   *
   * Produces the same wire shape as recordSuccess/recordError plus a
   * `parentInvocationId` pointer to the outer CLI invocation and a
   * `workflowContext` block describing the surrounding workflow/job/step.
   *
   * The caller supplies `completedAt` rather than letting the service
   * stamp `new Date()` because workflow-internal invocations finalize via
   * a bridge that may close them after a deferred event arrives. For
   * pre-method-executing failures the caller passes the same instant for
   * `startedAt` and `completedAt`, producing `durationMs = 0` — the
   * method was never actually invoked.
   *
   * @param invocation - The command invocation data shaped like a direct
   *   `model method run <name> <method>` invocation, with the same
   *   redactions
   * @param startedAt - When the method invocation started (or `now` for
   *   pre-method-executing failures)
   * @param completedAt - When the method invocation ended (or `now` for
   *   pre-method-executing failures)
   * @param error - The error that occurred, or `null` for success. Caller
   *   classifies UserError vs Error via instanceof — this method mirrors
   *   recordError's classification.
   * @param parentInvocationId - Id of the parent CLI invocation
   * @param workflowContext - Workflow/job/step/modelType context
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
    });

    await this.repository.save(entry);
  }

  /**
   * Cleans up telemetry entries older than the retention period.
   * Flushed entries are cleaned after `retentionDays` (default 2).
   * Unflushed entries survive until the hard cap (`HARD_RETENTION_DAYS`,
   * 7 days) to allow retry, then are deleted to prevent unbounded growth.
   *
   * @param retentionDays - Number of days to retain flushed entries (default: 2)
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
   * Removes flushed telemetry entries older than the retention period, and
   * quarantined entries past their (longer) retention. Never touches
   * unflushed entries.
   *
   * This is the only cleanup a long-lived daemon may run.
   * {@link cleanupOldTelemetry} also applies `HARD_RETENTION_DAYS`, which
   * deletes UNFLUSHED entries — safe for a CLI process that will be started
   * again shortly, and destructive for a daemon that has been unable to reach
   * the endpoint for a week, since it would discard telemetry that is still
   * perfectly sendable. Undelivered data on disk beats silently discarded
   * data, so the daemon keeps unflushed entries indefinitely.
   *
   * @param retentionDays - Number of days to retain flushed entries (default: 2)
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

  /**
   * Sets an entry aside as undeliverable so it stops blocking newer entries.
   */
  async quarantineEntry(entry: TelemetryEntry): Promise<void> {
    await this.repository.quarantine(entry);
  }

  /**
   * Flushes unflushed telemetry entries to a remote endpoint.
   * Returns the sender's verdict plus any entries that were accepted but
   * could not be marked flushed. Never throws.
   *
   * Concurrent calls on the same service are serialized: a caller arriving
   * while a flush is running awaits that flush rather than starting a second
   * one. Without this, two callers can both read the same unflushed batch
   * before either marks it and send every entry twice — the shape `swamp
   * serve` produces at shutdown, when its daemon flush loop and the CLI
   * teardown flush overlap.
   *
   * @param config - Flush configuration with sender and distinctId
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

  /**
   * Returns unflushed entries excluding ones the caller has already
   * delivered, for callers that need to retry a stuck batch entry by entry.
   */
  async findUnflushedForIsolation(
    limit: number,
    skipIds?: ReadonlySet<string>,
  ): Promise<TelemetryEntry[]> {
    const entries = await this.repository.findUnflushed(limit);
    return skipIds?.size
      ? entries.filter((entry) => !skipIds.has(entry.id))
      : entries;
  }

  /**
   * Sends a single entry, marking it flushed on success.
   *
   * Used to find the offender in a batch the endpoint keeps rejecting: a
   * batch is all-or-nothing, so one bad entry hides behind the same failure
   * as its blameless neighbours until they are sent apart.
   */
  flushEntry(
    config: TelemetrySingleFlushConfig,
  ): Promise<TelemetryFlushOutcome> {
    return this.#serialize(async () => {
      try {
        const result = await config.sender.sendBatch(
          [config.entry],
          config.distinctId,
          config.repoId,
          config.authToken,
          config.signal,
        );
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

  /**
   * Runs `fn` after every previously-queued flush operation has settled.
   */
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
    const found = await this.repository.findUnflushed(batchSize);
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
    const unmarkedIds: string[] = [];
    if (result.ok) {
      for (const entry of entries) {
        const marked = await this.repository.markFlushed(entry, keepFlushed);
        if (!marked) unmarkedIds.push(entry.id);
      }
    }
    return { result, unmarkedIds, sentCount: result.ok ? entries.length : 0 };
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
