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

import { runDetached } from "../../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import {
  type AuditSink,
  UnconfirmedEventsError,
} from "../../domain/serve_audit/audit_sink.ts";
import type { AuditStore } from "../../domain/serve_audit/audit_store.ts";

const logger = getSwampLogger(["serve", "audit", "store-sink"]);

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

const DEFAULT_GC_INTERVAL_MS = 60 * 60 * 1000;

export interface AuditStoreWithRetention {
  readonly store: AuditStore;
  readonly retentionDays?: number;
}

interface PendingPut {
  readonly store: AuditStore;
  readonly key: string;
  readonly data: Uint8Array;
}

const DEFAULT_MAX_RETRY_BYTES = 32 * 1024 * 1024;

export interface StoreSinkOptions {
  readonly stores: readonly (AuditStore | AuditStoreWithRetention)[];
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly gcIntervalMs?: number;
  /** Most bytes of failed per-store puts held for retry. Default 32MB. */
  readonly maxRetryBytes?: number;
}

function unwrapStore(
  s: AuditStore | AuditStoreWithRetention,
): { store: AuditStore; retentionDays?: number } {
  if ("store" in s && "put" in (s as AuditStoreWithRetention).store) {
    const swr = s as AuditStoreWithRetention;
    return { store: swr.store, retentionDays: swr.retentionDays };
  }
  return { store: s as AuditStore };
}

export class StoreSink implements AuditSink {
  readonly name = "store";
  readonly durable = true;
  readonly #stores: readonly { store: AuditStore; retentionDays?: number }[];
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  #batch: AuditEvent[] = [];
  // Batch writes still running, so flush can wait for them.
  readonly #writing = new Set<Promise<void>>();
  // Sequences of events in batches that reached no store, reported and
  // cleared by flush; unknownUnstored when such an event had no sequence.
  #unstored = new Set<number>();
  #unknownUnstored = false;
  // Puts that failed for some stores of a batch others stored.
  #retries: PendingPut[] = [];
  // Keys of retried date objects no store has yet, with their sequences.
  readonly #unheld = new Map<string, readonly number[] | null>();
  #retryBytes = 0;
  readonly #maxRetryBytes: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #gcTimer: ReturnType<typeof setInterval> | null = null;
  readonly #encoder = new TextEncoder();

  constructor(options: StoreSinkOptions) {
    this.#stores = options.stores.map(unwrapStore);
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#flushIntervalMs = options.flushIntervalMs ??
      DEFAULT_FLUSH_INTERVAL_MS;
    this.#maxRetryBytes = options.maxRetryBytes ?? DEFAULT_MAX_RETRY_BYTES;

    this.#timer = runDetached(() =>
      setInterval(() => {
        // Not flush(): a failure stays recorded for the next flush call.
        if (this.#batch.length === 0) return;
        this.#writeBatch().catch((error: unknown) => {
          logger.warn("Periodic flush failed: {error}", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.#flushIntervalMs)
    );
    Deno.unrefTimer(this.#timer);

    const hasRetention = this.#stores.some((s) =>
      s.retentionDays !== undefined
    );
    if (hasRetention) {
      const gcInterval = options.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
      this.#gcTimer = runDetached(() =>
        setInterval(() => {
          this.#runGc().catch((error: unknown) => {
            logger.warn("Audit GC failed: {error}", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, gcInterval)
      );
      Deno.unrefTimer(this.#gcTimer);
    }

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        this.close().catch((error: unknown) => {
          logger.warn("Shutdown flush failed: {error}", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, { once: true });
    }
  }

  async write(events: readonly AuditEvent[]): Promise<void> {
    for (const event of events) this.#batch.push(event);
    if (this.#batch.length >= this.#batchSize) {
      await this.#writeBatch();
    }
  }

  /**
   * Writes the pending batch, waits for batch writes already running, and
   * retries puts that failed for some stores. Rejects when a batch since the
   * previous flush reached no store at all, including one the interval timer
   * wrote, so a caller holding the events elsewhere (the WAL) keeps them.
   */
  async flush(): Promise<void> {
    if (this.#batch.length > 0) {
      await this.#writeBatch();
    }
    await Promise.all([...this.#writing]);
    await this.#retryFailedPuts();
    let pending: Set<number> | null = new Set();
    for (const sequences of this.#unheld.values()) {
      if (sequences === null) pending = null;
      else if (pending !== null) {
        for (const seq of sequences) pending.add(seq);
      }
    }
    if (
      this.#unstored.size > 0 || this.#unknownUnstored ||
      pending === null || pending.size > 0
    ) {
      const sequences = this.#unknownUnstored ? null : this.#unstored;
      this.#unstored = new Set();
      this.#unknownUnstored = false;
      throw new UnconfirmedEventsError(
        "Audit events are not yet in any store",
        sequences,
        pending,
      );
    }
  }

  async close(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#gcTimer !== null) {
      clearInterval(this.#gcTimer);
      this.#gcTimer = null;
    }
    try {
      await this.flush();
    } catch (error: unknown) {
      // Shutting down while a store is failing: the caller (the WAL) keeps
      // what is unconfirmed, so this is reported rather than thrown.
      logger.warn(
        "Audit store sink closed with events not yet in any store; the WAL keeps them for replay: {error}",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  async #runGc(): Promise<void> {
    for (const { store, retentionDays } of this.#stores) {
      if (retentionDays === undefined) continue;

      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
      const cutoffDate = cutoff.toISOString().slice(0, 10);

      try {
        const keys = await store.list("events/");
        const partitions = new Set<string>();
        for (const key of keys) {
          const parts = key.split("/");
          if (parts.length >= 2) {
            partitions.add(parts[1]);
          }
        }

        for (const partition of partitions) {
          if (partition < cutoffDate) {
            const partitionKeys = keys.filter((k) =>
              k.startsWith(`events/${partition}/`)
            );
            for (const key of partitionKeys) {
              try {
                await store.delete(key);
              } catch {
                // best-effort deletion
              }
            }
            logger.info("Deleted expired audit partition {partition}", {
              partition,
            });
          }
        }
      } catch (error: unknown) {
        logger.warn("Audit GC failed for store: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #writeBatch(): Promise<void> {
    const write = this.#putBatch();
    this.#writing.add(write);
    try {
      await write;
    } finally {
      this.#writing.delete(write);
    }
  }

  async #putBatch(): Promise<void> {
    const events = this.#batch;
    this.#batch = [];

    const partitions = new Map<string, AuditEvent[]>();
    for (const event of events) {
      const dateKey = event.timestamp.slice(0, 10);
      let partition = partitions.get(dateKey);
      if (!partition) {
        partition = [];
        partitions.set(dateKey, partition);
      }
      partition.push(event);
    }

    // One put per date partition. A batch counts as stored once any part of
    // it reached a store: parts that missed a store are retried here under
    // their own key, so re-sending the batch can never store a part twice.
    // Only a batch no part of which reached any store is reported.
    let anyStored = false;
    const missed: PendingPut[] = [];
    const unheld = new Map<string, number[] | null>();
    for (const [dateKey, partitionEvents] of partitions) {
      const jsonl = partitionEvents.map((e) => JSON.stringify(e)).join("\n") +
        "\n";
      const data = this.#encoder.encode(jsonl);
      const key = `events/${dateKey}/${crypto.randomUUID()}.jsonl`;

      let partitionStored = false;
      for (const { store } of this.#stores) {
        try {
          await store.put(key, data);
          anyStored = true;
          partitionStored = true;
        } catch (error: unknown) {
          missed.push({ store, key, data });
          logger.warn(
            "Failed to write audit batch to store for {date}: {error}",
            {
              date: dateKey,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      if (!partitionStored) unheld.set(key, sequencesOf(partitionEvents));
    }
    if (anyStored) {
      // A date object no store took is retried here; until it lands, flush
      // reports its events as pending so the caller keeps them.
      for (const [key, sequences] of unheld) this.#unheld.set(key, sequences);
      for (const retry of missed) this.#queueRetry(retry);
      return;
    }
    // No store has any of it: the caller still holds it (the WAL) and is told.
    for (const event of events) {
      const sequence = (event as { sequence?: unknown }).sequence;
      if (typeof sequence === "number") this.#unstored.add(sequence);
      else this.#unknownUnstored = true;
    }
  }

  /**
   * A batch that reached some stores but not this one is retried on flush,
   * under the same key, so a retry that lands never stores it twice.
   */
  #queueRetry(retry: PendingPut): void {
    this.#retries.push(retry);
    this.#retryBytes += retry.data.byteLength;
    while (this.#retryBytes > this.#maxRetryBytes && this.#retries.length > 1) {
      const dropped = this.#retries.shift()!;
      this.#retryBytes -= dropped.data.byteLength;
      const unheld = this.#unheld.get(dropped.key);
      if (unheld === undefined) {
        logger.warn(
          "Audit store retry queue is full; batch {key} is dropped for one store, the others have it",
          { key: dropped.key },
        );
        continue;
      }
      if (this.#retries.some((retry) => retry.key === dropped.key)) {
        logger.warn(
          "Audit store retry queue is full; batch {key}, which no store has yet, is dropped for one store and still retried for another",
          { key: dropped.key },
        );
        continue;
      }
      // No store has it and it is no longer retried: report it as lost, so
      // the caller sends it again.
      this.#unheld.delete(dropped.key);
      if (unheld === null) this.#unknownUnstored = true;
      else for (const sequence of unheld) this.#unstored.add(sequence);
      logger.warn(
        "Audit store retry queue is full; batch {key}, which no store has, is handed back to be sent again",
        { key: dropped.key },
      );
    }
  }

  async #retryFailedPuts(): Promise<void> {
    const retries = this.#retries.splice(0);
    this.#retryBytes = 0;
    let stillFailing = 0;
    for (const retry of retries) {
      try {
        await retry.store.put(retry.key, retry.data);
        this.#unheld.delete(retry.key);
      } catch {
        stillFailing++;
        this.#queueRetry(retry);
      }
    }
    if (stillFailing > 0) {
      logger.warn(
        "{count} audit batch put(s) are still waiting to reach a store that failed",
        { count: stillFailing },
      );
    }
  }
}

/** The chain sequences of some events, or null when any event lacks one. */
function sequencesOf(events: readonly AuditEvent[]): number[] | null {
  const sequences: number[] = [];
  for (const event of events) {
    const sequence = (event as { sequence?: unknown }).sequence;
    if (typeof sequence !== "number") return null;
    sequences.push(sequence);
  }
  return sequences;
}
