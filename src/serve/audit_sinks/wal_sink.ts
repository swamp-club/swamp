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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { runDetached } from "../../infrastructure/tracing/mod.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../../domain/serve_audit/audit_sink.ts";
import type { AuditWal } from "../../domain/serve_audit/audit_wal.ts";

const logger = getSwampLogger(["serve", "audit", "wal-sink"]);

export interface WalSinkOptions {
  readonly wal: AuditWal;
  readonly downstream: AuditSink;
  /**
   * How long flush waits for queued deliveries to the downstream sink before
   * leaving the rest in the WAL. Default 30s.
   */
  readonly deliveryWaitMs?: number;
  /**
   * How often delivered segments are checkpointed: the downstream sink is
   * flushed and the segments it confirmed are deleted from the WAL. 0 turns
   * the timer off, leaving it to flush. Default 5s.
   */
  readonly checkpointIntervalMs?: number;
}

const DEFAULT_DELIVERY_WAIT_MS = 30_000;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;

export class WalSink implements AuditSink {
  readonly name = "wal";
  readonly durable = true;
  readonly #wal: AuditWal;
  readonly #downstream: AuditSink;
  readonly #delivered = new Set<string>();
  readonly #deliveryWaitMs: number;
  // Deliveries to the downstream sink run one at a time, in WAL order, on
  // this chain. It never rejects; flush and close wait on it.
  #deliveries: Promise<void> = Promise.resolve();
  #queued = 0;
  // Deliveries and checkpoints finished so far, and the chain and count a
  // wait last gave up at: waiting again on a chain that has not moved since
  // only delays shutdown.
  #completed = 0;
  #gaveUpAt: { chain: Promise<void>; completed: number } | null = null;
  #checkpointQueued = false;
  #checkpointTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WalSinkOptions) {
    this.#wal = options.wal;
    this.#downstream = options.downstream;
    this.#deliveryWaitMs = options.deliveryWaitMs ?? DEFAULT_DELIVERY_WAIT_MS;
    const checkpointMs = options.checkpointIntervalMs ??
      DEFAULT_CHECKPOINT_INTERVAL_MS;
    if (checkpointMs > 0) {
      this.#checkpointTimer = runDetached(() =>
        setInterval(() => {
          if (this.#delivered.size > 0) this.#queueCheckpoint();
        }, checkpointMs)
      );
      Deno.unrefTimer(this.#checkpointTimer);
    }
  }

  get wal(): AuditWal {
    return this.#wal;
  }

  /**
   * Resolves once the events are appended to the WAL. Delivery downstream
   * follows on its own, so a slow or hung store never holds the audit
   * pipeline; while it is outstanding, later writes still reach the WAL and
   * queue behind it.
   */
  async write(events: readonly AuditEvent[]): Promise<void> {
    if (events.length === 0) return;

    const segmentName = await this.#wal.append(events);

    this.#queued++;
    this.#deliveries = this.#deliveries.then(() => this.#deliver(segmentName));
  }

  /** Delivers one segment downstream; never rejects. */
  async #deliver(segmentName: string): Promise<void> {
    try {
      // Read back from disk, so a long queue holds segment names, not events.
      let events: AuditEvent[];
      try {
        events = await this.#wal.readSegment(segmentName);
      } catch (error: unknown) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      if (events.length === 0) return;
      await this.#downstream.write(events);
      this.#delivered.add(segmentName);
    } catch (error: unknown) {
      logger.warn(
        "Downstream sink failed, events persisted to WAL segment {segment}: {error}",
        {
          segment: segmentName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    } finally {
      this.#queued--;
      this.#completed++;
    }
  }

  /** Waits for queued deliveries, up to the delivery wait. */
  async #awaitDeliveries(): Promise<void> {
    const deliveries = this.#deliveries;
    if (
      this.#gaveUpAt?.chain === deliveries &&
      this.#gaveUpAt.completed === this.#completed
    ) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = await Promise.race([
        deliveries.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#deliveryWaitMs);
        }),
      ]);
      if (!done) {
        this.#gaveUpAt = { chain: deliveries, completed: this.#completed };
        logger.warn(
          "Downstream sink still has {count} WAL segment(s) to deliver after {seconds}s; they stay in the WAL and are replayed on the next start",
          {
            count: this.#queued,
            seconds: Math.round(this.#deliveryWaitMs / 1000),
          },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Waits, up to the delivery wait, for queued deliveries and a checkpoint
   * that removes the segments the store has confirmed.
   */
  async flush(): Promise<void> {
    this.#queueCheckpoint();
    await this.#awaitDeliveries();
  }

  #queueCheckpoint(): void {
    if (this.#checkpointQueued) return;
    this.#checkpointQueued = true;
    this.#deliveries = this.#deliveries.then(() => this.#checkpoint());
  }

  /**
   * Flushes the downstream sink, then deletes the segments delivered before
   * the flush began: only then are their events in the store. Runs on the
   * delivery chain, so never alongside a delivery; never rejects.
   */
  async #checkpoint(): Promise<void> {
    this.#checkpointQueued = false;
    try {
      await this.#removeConfirmedSegments();
    } finally {
      this.#completed++;
    }
  }

  async #removeConfirmedSegments(): Promise<void> {
    const delivered = [...this.#delivered];
    if (delivered.length === 0) return;
    try {
      await this.#downstream.flush();
    } catch (error: unknown) {
      // The store did not confirm these. They stay in the WAL for replay on
      // the next start, and are no longer tracked as delivered, so a later
      // checkpoint cannot delete them.
      for (const segmentName of delivered) this.#delivered.delete(segmentName);
      logger.warn(
        "Downstream flush failed, {count} WAL segment(s) kept for replay on the next start: {error}",
        {
          count: delivered.length,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return;
    }
    for (const segmentName of delivered) {
      try {
        await this.#wal.deleteSegment(segmentName);
        this.#delivered.delete(segmentName);
      } catch (error: unknown) {
        logger.warn(
          "Failed to delete delivered WAL segment {segment}: {error}",
          {
            segment: segmentName,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  async replay(): Promise<number> {
    const segments = this.#wal.listSegments();
    let replayedCount = 0;

    for (const segmentName of segments) {
      try {
        const events = await this.#wal.readSegment(segmentName);
        if (events.length === 0) {
          await this.#wal.deleteSegment(segmentName);
          continue;
        }

        await this.#downstream.write(events);
        await this.#wal.deleteSegment(segmentName);
        replayedCount += events.length;
      } catch (error: unknown) {
        logger.warn(
          "Failed to replay WAL segment {segment}, will retry later: {error}",
          {
            segment: segmentName,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        break;
      }
    }

    return replayedCount;
  }

  async close(): Promise<void> {
    if (this.#checkpointTimer !== null) {
      clearInterval(this.#checkpointTimer);
      this.#checkpointTimer = null;
    }
    await this.flush();
    await this.#downstream.close();
  }
}
