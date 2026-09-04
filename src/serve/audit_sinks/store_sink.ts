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
import type { AuditStore } from "../../domain/serve_audit/audit_store.ts";

const logger = getSwampLogger(["serve", "audit", "store-sink"]);

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

export interface StoreSinkOptions {
  readonly stores: readonly AuditStore[];
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export class StoreSink implements AuditSink {
  readonly name = "store";
  readonly #stores: readonly AuditStore[];
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  #batch: AuditEvent[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #encoder = new TextEncoder();

  constructor(options: StoreSinkOptions) {
    this.#stores = options.stores;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#flushIntervalMs = options.flushIntervalMs ??
      DEFAULT_FLUSH_INTERVAL_MS;

    this.#timer = setInterval(() => {
      this.flush().catch((error: unknown) => {
        logger.warn("Periodic flush failed: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#flushIntervalMs);
    Deno.unrefTimer(this.#timer);

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
    this.#batch.push(...events);
    if (this.#batch.length >= this.#batchSize) {
      await this.#writeBatch();
    }
  }

  async flush(): Promise<void> {
    if (this.#batch.length > 0) {
      await this.#writeBatch();
    }
  }

  async close(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }

  async #writeBatch(): Promise<void> {
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

    for (const [dateKey, partitionEvents] of partitions) {
      const jsonl = partitionEvents.map((e) => JSON.stringify(e)).join("\n") +
        "\n";
      const data = this.#encoder.encode(jsonl);
      const key = `events/${dateKey}/${crypto.randomUUID()}.jsonl`;

      for (const store of this.#stores) {
        try {
          await store.put(key, data);
        } catch (error: unknown) {
          logger.warn(
            "Failed to write audit batch to store for {date}: {error}",
            {
              date: dateKey,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }
  }
}
