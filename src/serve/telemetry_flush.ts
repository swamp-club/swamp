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

/**
 * Periodic telemetry flushing for `swamp serve`.
 *
 * The CLI records and flushes in its teardown, after `cli.parse` returns.
 * For a daemon that instant is process exit, so a `swamp serve` that runs
 * for weeks never flushes anything it spooled. This service gives the daemon
 * its own flush cadence, modelled on InstanceHeartbeatService.
 */

import type {
  TelemetryFlushOutcome,
  TelemetryService,
} from "../domain/telemetry/telemetry_service.ts";
import type { TelemetrySender } from "../domain/telemetry/telemetry_sender.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["serve", "telemetry"]);

/** How often the daemon attempts a flush. */
export const DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS = 60_000;

/**
 * Maximum batches sent per tick. `flushTelemetry` sends at most one batch per
 * call, so draining a backlog needs several — but not without bound, or a
 * large spool would hold the tick open indefinitely.
 */
const MAX_BATCHES_PER_TICK = 20;

/** Ticks between prunes of already-flushed entries (~1 hour at the default). */
const PRUNE_EVERY_N_TICKS = 60;

/**
 * Consecutive failures of the same batch before its entries are retried
 * individually to find the one the endpoint refuses. High enough that an
 * ordinary outage — a laptop asleep, an endpoint restart — never triggers
 * isolation.
 */
const FAILURES_BEFORE_ISOLATION = 5;

/**
 * Individual send failures before an entry is quarantined. Applied only
 * after isolation has already proven the batch is stuck.
 */
const FAILURES_BEFORE_QUARANTINE = 3;

/** Timeout for a single flush attempt. */
const FLUSH_TIMEOUT_MS = 10_000;

export interface TelemetryFlushCredentials {
  sender: TelemetrySender;
  distinctId: string;
  repoId?: string;
  authToken?: string;
  keepFlushed: boolean;
}

/**
 * Flushes the telemetry spool on a timer for the lifetime of a daemon.
 */
export class DaemonTelemetryFlushService {
  readonly #service: TelemetryService;
  readonly #credentials: TelemetryFlushCredentials;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #drainPromise: Promise<void> | null = null;
  #stopped = false;
  #tickCount = 0;
  #consecutiveFailures = 0;
  /**
   * Entries the endpoint accepted but that could not be removed from the
   * spool. `findUnflushed` keeps returning them, so without this they would
   * be re-sent on every tick — a duplicate event every interval, forever.
   */
  readonly #sentButUnmarked = new Set<string>();

  constructor(
    service: TelemetryService,
    credentials: TelemetryFlushCredentials,
    options?: { intervalMs?: number },
  ) {
    this.#service = service;
    this.#credentials = credentials;
    this.#intervalMs = options?.intervalMs ??
      DEFAULT_TELEMETRY_FLUSH_INTERVAL_MS;
  }

  /**
   * Starts the flush loop. The timer is unref'd so it never holds the
   * process open on its own.
   */
  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#intervalMs);
    Deno.unrefTimer(this.#timer);
  }

  /**
   * Stops the loop and performs one final flush, so a draining daemon does
   * not strand the runs it just finished.
   */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#stopped = true;
    if (this.#drainPromise) await this.#drainPromise;
    await this.#drain();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    this.#tickCount++;
    await this.#drain();

    if (this.#tickCount % PRUNE_EVERY_N_TICKS === 0) {
      // Prunes delivered and quarantined entries only. Never the hard
      // retention cap: a daemon that has been unable to reach the endpoint
      // for a week must keep that telemetry, not destroy it.
      await this.#service.pruneFlushedTelemetry();
    }
  }

  /**
   * Sends batches until the spool is empty, a send fails, or the per-tick cap
   * is reached. Only one drain runs at a time — concurrent callers return
   * immediately. {@link stop} awaits {@link #drainPromise} so it never misses
   * an in-flight drain started by the timer.
   */
  async #drain(): Promise<void> {
    if (this.#drainPromise) return;

    this.#drainPromise = (async () => {
      try {
        for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
          const outcome = await this.#flushOnce();
          if (!outcome.result.ok) {
            this.#consecutiveFailures++;
            logger.warn(
              "Telemetry flush failed ({reason}) — {failures} consecutive; entries stay queued",
              {
                reason: outcome.result.reason ?? "unknown",
                failures: this.#consecutiveFailures,
              },
            );
            if (this.#consecutiveFailures >= FAILURES_BEFORE_ISOLATION) {
              await this.#isolateStuckBatch();
            }
            return;
          }
          this.#consecutiveFailures = 0;
          if (outcome.sentCount === 0) return;
        }
      } catch (error) {
        logger.warn("Telemetry flush loop error: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    try {
      await this.#drainPromise;
    } finally {
      this.#drainPromise = null;
    }
  }

  #flushOnce(): Promise<TelemetryFlushOutcome> {
    return this.#service.flushTelemetry({
      sender: this.#credentials.sender,
      distinctId: this.#credentials.distinctId,
      repoId: this.#credentials.repoId,
      authToken: this.#credentials.authToken ?? undefined,
      keepFlushed: this.#credentials.keepFlushed,
      signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      skipIds: this.#sentButUnmarked,
    }).then((outcome) => {
      for (const id of outcome.unmarkedIds) {
        this.#sentButUnmarked.add(id);
        logger.warn(
          "Telemetry entry {id} was delivered but could not be removed from the spool; it will not be re-sent by this process",
          { id },
        );
      }
      return outcome;
    });
  }

  /**
   * Retries a persistently-failing batch one entry at a time and quarantines
   * the ones that fail on their own.
   *
   * `findUnflushed` returns the oldest entries first and a batch is only
   * marked after the whole batch sends, so a single entry the endpoint always
   * rejects blocks every newer entry behind it indefinitely — the daemon
   * would keep flushing on schedule and still deliver nothing. Isolating lets
   * the queue advance at the cost of the one entry that cannot go.
   */
  async #isolateStuckBatch(): Promise<void> {
    const entries = await this.#service.findUnflushedForIsolation(
      MAX_BATCHES_PER_TICK,
      this.#sentButUnmarked,
    );
    if (entries.length === 0) return;

    for (const entry of entries) {
      let failures = 0;
      let delivered = false;
      for (let attempt = 0; attempt < FAILURES_BEFORE_QUARANTINE; attempt++) {
        const outcome = await this.#service.flushEntry({
          entry,
          sender: this.#credentials.sender,
          distinctId: this.#credentials.distinctId,
          repoId: this.#credentials.repoId,
          authToken: this.#credentials.authToken ?? undefined,
          keepFlushed: this.#credentials.keepFlushed,
          signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
        });
        if (outcome.result.ok) {
          delivered = true;
          for (const id of outcome.unmarkedIds) this.#sentButUnmarked.add(id);
          break;
        }
        failures++;
      }

      if (!delivered && failures >= FAILURES_BEFORE_QUARANTINE) {
        await this.#service.quarantineEntry(entry);
        logger.warn(
          "Telemetry entry {id} was rejected repeatedly and has been quarantined so newer entries can be sent",
          { id: entry.id },
        );
        // One offender is enough for this pass — the rest of the queue gets
        // a normal drain on the next tick.
        break;
      }
    }
    this.#consecutiveFailures = 0;
  }
}
