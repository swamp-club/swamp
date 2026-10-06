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
import {
  type AuditSink,
  UnconfirmedEventsError,
} from "../../domain/serve_audit/audit_sink.ts";
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
  readonly #deliveryWaitMs: number;
  // Segments handed downstream since the last checkpoint, with the
  // sequences they hold, so a checkpoint can tell which ones the store
  // confirmed.
  readonly #delivered = new Map<string, DeliveredSegment>();
  // Segments to send again: their delivery failed, or the store reported
  // their events unconfirmed at a checkpoint.
  #redeliver: string[] = [];
  // Work for the delivery loop, in WAL order: segment names to deliver and
  // checkpoints. One loop drains it, so downstream sees one call at a time.
  #queue: (string | typeof CHECKPOINT)[] = [];
  // Set and cleared in the same turn the loop starts and exits, so work
  // queued as it finishes always starts a new loop.
  #looping = false;
  #draining: Promise<void> = Promise.resolve();
  // Items the loop has finished, and where a wait last gave up: waiting again
  // on a loop that has not moved since only delays shutdown.
  #completed = 0;
  #gaveUpAt: number | null = null;
  #checkpointQueued = false;
  // Set once close has stopped waiting: anything the loop still runs after
  // that may race the downstream sink's own close for its failure report, so
  // it deletes nothing and the segments stay in the WAL for replay.
  #closed = false;
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
          if (this.#delivered.size > 0 || this.#redeliver.length > 0) {
            this.#queueCheckpoint();
          }
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
    this.#enqueue(segmentName);
  }

  #enqueue(item: string | typeof CHECKPOINT): void {
    this.#queue.push(item);
    // While downstream hangs the queue only grows; names the WAL size limit
    // has already dropped are pruned, so it stays bounded by the WAL.
    if (this.#queue.length > 2 * this.#wal.segmentCount + 16) {
      const held = new Set(this.#wal.listSegments());
      this.#queue = this.#queue.filter((entry) =>
        entry === CHECKPOINT || held.has(entry)
      );
    }
    if (!this.#looping) {
      this.#looping = true;
      this.#draining = this.#drain();
    }
  }

  /** Runs queued work one item at a time until the queue is empty. */
  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift()!;
        try {
          if (item === CHECKPOINT) {
            this.#checkpointQueued = false;
            await this.#removeConfirmedSegments();
          } else {
            await this.#deliverSegment(item);
          }
        } finally {
          this.#completed++;
        }
      }
    } finally {
      this.#looping = false;
    }
  }

  /**
   * Sends one segment downstream, reading it back from disk so the queue
   * holds segment names, not events. A segment the size limit has dropped is
   * skipped; one that fails is delivered again at the next checkpoint.
   */
  async #deliverSegment(segmentName: string): Promise<void> {
    try {
      let events: AuditEvent[];
      try {
        events = await this.#wal.readSegment(segmentName);
      } catch (error: unknown) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      if (events.length === 0) return;
      await this.#downstream.write(events);
      this.#delivered.set(segmentName, describe(events));
    } catch (error: unknown) {
      this.#redeliver.push(segmentName);
      logger.warn(
        "Downstream sink failed, events persisted to WAL segment {segment}: {error}",
        {
          segment: segmentName,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /** Waits for queued work, up to the delivery wait. */
  async #awaitDeliveries(): Promise<void> {
    if (!this.#looping) return;
    const draining = this.#draining;
    if (this.#gaveUpAt === this.#completed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = await Promise.race([
        draining.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#deliveryWaitMs);
        }),
      ]);
      if (!done) {
        this.#gaveUpAt = this.#completed;
        logger.warn(
          "Downstream sink still has {count} WAL segment(s) to deliver after {seconds}s; they stay in the WAL and are replayed on the next start",
          {
            count: this.#queue.filter((entry) => entry !== CHECKPOINT).length,
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
    this.#enqueue(CHECKPOINT);
  }

  /**
   * Delivers segments waiting to be sent again, flushes the downstream sink,
   * then deletes the delivered segments the store confirmed. A segment whose
   * events the flush reports unconfirmed is kept and delivered again at the
   * next checkpoint; the rest are in the store and are deleted.
   */
  async #removeConfirmedSegments(): Promise<void> {
    for (const segmentName of this.#redeliver.splice(0)) {
      await this.#deliverSegment(segmentName);
    }
    const delivered = [...this.#delivered];
    if (delivered.length === 0) return;
    for (const [segmentName] of delivered) this.#delivered.delete(segmentName);

    type Check = (segment: DeliveredSegment) => boolean;
    let unconfirmed: Check = () => false;
    let stillPending: Check = () => false;
    try {
      await this.#downstream.flush();
    } catch (error: unknown) {
      if (error instanceof UnconfirmedEventsError) {
        const { sequences, pending } = error;
        unconfirmed = ({ sequences: held }) =>
          sequences === null || held === null ||
          held.some((seq) => sequences.has(seq));
        stillPending = ({ sequences: held }) =>
          pending === null || held === null ||
          held.some((seq) => pending.has(seq));
      } else {
        // An error that names nothing: send everything again, except what
        // the sink last said it is still retrying itself, which would then
        // be stored twice.
        unconfirmed = (segment) => !segment.pending;
        stillPending = (segment) => segment.pending;
      }
      logger.warn(
        "Downstream flush failed; WAL segments it did not confirm will be delivered again at the next checkpoint: {error}",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    if (this.#closed) return;
    const confirmed: string[] = [];
    let last: ChainPosition | null = null;
    for (const [segmentName, segment] of delivered) {
      if (unconfirmed(segment)) {
        this.#redeliver.push(segmentName);
        continue;
      }
      if (stillPending(segment)) {
        // The downstream sink is still retrying these: keep the segment,
        // without sending it again, and check it at the next checkpoint.
        this.#delivered.set(segmentName, { ...segment, pending: true });
        continue;
      }
      confirmed.push(segmentName);
      if (segment.last && (!last || segment.last.sequence > last.sequence)) {
        last = segment.last;
      }
    }
    if (confirmed.length === 0) return;

    // Startup finds the chain position from the segments on disk, or failing
    // that chain-state.json. Record it before deleting the segments that hold
    // it, or a crash would restart the chain from an older position.
    if (last) {
      try {
        const saved = await this.#wal.loadChainState();
        if (!saved || saved.sequence < last.sequence) {
          await this.#wal.saveChainState({
            sequence: last.sequence,
            previousDigest: last.digest,
          });
        }
      } catch (error: unknown) {
        const segments = new Map(delivered);
        for (const segmentName of confirmed) {
          this.#delivered.set(segmentName, segments.get(segmentName)!);
        }
        logger.warn(
          "Could not save the audit chain position, keeping confirmed WAL segments: {error}",
          { error: error instanceof Error ? error.message : String(error) },
        );
        return;
      }
    }
    for (const segmentName of confirmed) {
      try {
        await this.#wal.deleteSegment(segmentName);
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
    this.#closed = true;
    await this.#downstream.close();
  }
}

const CHECKPOINT = Symbol("checkpoint");

interface ChainPosition {
  readonly sequence: number;
  readonly digest: string;
}

interface DeliveredSegment {
  /** The chain sequences in the segment, or null when any event lacks one. */
  readonly sequences: readonly number[] | null;
  /** The segment's last chain position, when its events carry one. */
  readonly last: ChainPosition | null;
  /** The downstream sink has said it is still retrying these events. */
  readonly pending: boolean;
}

function describe(events: readonly AuditEvent[]): DeliveredSegment {
  let sequences: number[] | null = [];
  let last: ChainPosition | null = null;
  for (const event of events) {
    const { sequence, digest } = event as {
      sequence?: unknown;
      digest?: unknown;
    };
    if (typeof sequence !== "number") {
      sequences = null;
      continue;
    }
    sequences?.push(sequence);
    if (typeof digest === "string" && (!last || sequence > last.sequence)) {
      last = { sequence, digest };
    }
  }
  return { sequences, last, pending: false };
}
