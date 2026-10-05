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
}

const DEFAULT_DELIVERY_WAIT_MS = 30_000;

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
  // The chain a wait last gave up on; waiting on it again only delays
  // shutdown, since nothing has been queued or settled since.
  #gaveUpOn: Promise<void> | null = null;

  constructor(options: WalSinkOptions) {
    this.#wal = options.wal;
    this.#downstream = options.downstream;
    this.#deliveryWaitMs = options.deliveryWaitMs ?? DEFAULT_DELIVERY_WAIT_MS;
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
    }
  }

  /** Waits for queued deliveries, up to the delivery wait. */
  async #awaitDeliveries(): Promise<void> {
    const deliveries = this.#deliveries;
    if (deliveries === this.#gaveUpOn) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = await Promise.race([
        deliveries.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.#deliveryWaitMs);
        }),
      ]);
      if (!done) {
        this.#gaveUpOn = deliveries;
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

  async flush(): Promise<void> {
    await this.#awaitDeliveries();
    let flushSucceeded = false;
    try {
      await this.#downstream.flush();
      flushSucceeded = true;
    } catch (error: unknown) {
      logger.warn("Downstream flush failed: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!flushSucceeded) return;

    const deleted: string[] = [];
    for (const segmentName of this.#delivered) {
      try {
        await this.#wal.deleteSegment(segmentName);
        deleted.push(segmentName);
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
    for (const name of deleted) {
      this.#delivered.delete(name);
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
    await this.flush();
    await this.#downstream.close();
  }
}
