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
import type { AuditEvent } from "./audit_event.ts";
import type { AuditSink } from "./audit_sink.ts";
import { RingBuffer } from "./ring_buffer.ts";

const logger = getSwampLogger(["serve", "audit", "emitter"]);

const DEFAULT_BUFFER_CAPACITY = 10_000;

export class AuditEmitter {
  readonly #buffer: RingBuffer<AuditEvent>;
  readonly #sinks: AuditSink[];
  readonly #cursors: Map<string, number> = new Map();
  #drainPending = false;
  #drainPromise: Promise<void> | null = null;

  constructor(
    sinks: AuditSink[],
    capacity: number = DEFAULT_BUFFER_CAPACITY,
  ) {
    this.#buffer = new RingBuffer(capacity);
    this.#sinks = sinks;
    for (const sink of sinks) {
      this.#cursors.set(sink.name, 0);
    }
  }

  emit(event: AuditEvent): void {
    this.#buffer.push(event);
    if (!this.#drainPending) {
      this.#drainPending = true;
      queueMicrotask(() => {
        this.#drainPending = false;
        this.#drainSerialized();
      });
    }
  }

  #drainSerialized(): void {
    if (this.#drainPromise) return;
    this.#drainPromise = this.#drain().finally(() => {
      this.#drainPromise = null;
    });
  }

  async #drain(): Promise<void> {
    for (const sink of this.#sinks) {
      const cursor = this.#cursors.get(sink.name) ?? 0;
      const { items, throughSeq } = this.#buffer.readFrom(cursor);
      if (items.length === 0) continue;
      try {
        await sink.write(items);
        this.#cursors.set(sink.name, throughSeq);
      } catch (error: unknown) {
        logger.warn(
          "Audit sink {sink} failed, events dropped: {error}",
          {
            sink: sink.name,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  async flush(): Promise<void> {
    if (this.#drainPromise) {
      await this.#drainPromise;
    }
    await this.#drain();
    for (const sink of this.#sinks) {
      try {
        await sink.flush();
      } catch (error: unknown) {
        logger.warn("Audit sink {sink} flush failed: {error}", {
          sink: sink.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async close(): Promise<void> {
    await this.flush();
    for (const sink of this.#sinks) {
      try {
        await sink.close();
      } catch (error: unknown) {
        logger.warn("Audit sink {sink} close failed: {error}", {
          sink: sink.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
