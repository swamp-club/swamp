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
import type {
  AuditCategory,
  AuditEvent,
  ChainedAuditEvent,
} from "./audit_event.ts";
import type { AuditSink } from "./audit_sink.ts";
import { AuditChainState } from "./audit_chain.ts";
import type { AuditPolicy } from "./audit_policy.ts";
import { RingBuffer } from "./ring_buffer.ts";

const logger = getSwampLogger(["serve", "audit", "emitter"]);

const DEFAULT_BUFFER_CAPACITY = 10_000;

export interface AuditEmitterOptions {
  readonly sinks: AuditSink[];
  readonly capacity?: number;
  readonly chainState?: AuditChainState;
  readonly policy?: AuditPolicy;
}

export class AuditEmitter {
  readonly #buffer: RingBuffer<AuditEvent>;
  readonly #sinks: AuditSink[];
  readonly #cursors: Map<string, number> = new Map();
  readonly #deniedRequests = new Set<string>();
  readonly #chainState: AuditChainState;
  readonly #policy: AuditPolicy | undefined;
  #drainPending = false;
  #drainPromise: Promise<void> | null = null;

  constructor(
    sinksOrOptions: AuditSink[] | AuditEmitterOptions,
    capacity?: number,
  ) {
    if (Array.isArray(sinksOrOptions)) {
      this.#buffer = new RingBuffer(capacity ?? DEFAULT_BUFFER_CAPACITY);
      this.#sinks = sinksOrOptions;
      this.#chainState = new AuditChainState();
    } else {
      this.#buffer = new RingBuffer(
        sinksOrOptions.capacity ?? DEFAULT_BUFFER_CAPACITY,
      );
      this.#sinks = sinksOrOptions.sinks;
      this.#chainState = sinksOrOptions.chainState ?? new AuditChainState();
      this.#policy = sinksOrOptions.policy;
    }
    if (this.#sinks.length > 1) {
      throw new Error(
        "AuditEmitter currently supports a single sink — multi-sink chain integrity requires per-sink chain state (planned for a future phase)",
      );
    }
    for (const sink of this.#sinks) {
      this.#cursors.set(sink.name, 0);
    }
  }

  get chainState(): AuditChainState {
    return this.#chainState;
  }

  emit(event: AuditEvent): void {
    if (this.#policy) {
      const level = this.#policy.evaluate(
        event.category as AuditCategory,
        event.action,
      );
      if (level === "none") return;
    }
    if (event.outcome === "denied") {
      this.#deniedRequests.add(event.requestId);
      if (this.#deniedRequests.size > 10_000) {
        const first = this.#deniedRequests.values().next().value!;
        this.#deniedRequests.delete(first);
      }
    } else if (
      event.outcome === "success" &&
      this.#deniedRequests.has(event.requestId)
    ) {
      return;
    }
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
    this.#drainPromise = this.#drain().then(() => {
      this.#drainPromise = null;
      if (this.#buffer.highSeq > this.#minCursor()) {
        this.#drainSerialized();
      }
    }, () => {
      this.#drainPromise = null;
    });
  }

  #minCursor(): number {
    let min = this.#buffer.highSeq;
    for (const cursor of this.#cursors.values()) {
      if (cursor < min) min = cursor;
    }
    return min;
  }

  async #drain(): Promise<void> {
    const minCursor = this.#minCursor();
    const { items, throughSeq } = this.#buffer.readFrom(minCursor);
    if (items.length === 0) return;

    const chainSnapshot = this.#chainState.snapshot();
    const chained: ChainedAuditEvent[] = [];
    for (const event of items) {
      chained.push(await this.#chainState.chain(event));
    }

    let anyWriteSucceeded = false;
    for (const sink of this.#sinks) {
      const sinkCursor = this.#cursors.get(sink.name) ?? 0;
      const offset = sinkCursor - minCursor;
      const sinkEvents = offset > 0 ? chained.slice(offset) : chained;
      if (sinkEvents.length === 0) continue;
      try {
        await sink.write(sinkEvents);
        this.#cursors.set(sink.name, throughSeq);
        anyWriteSucceeded = true;
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

    if (!anyWriteSucceeded) {
      this.#chainState.restore(chainSnapshot);
    }
  }

  async flush(): Promise<void> {
    if (this.#drainPromise) {
      await this.#drainPromise;
    }
    if (!this.#drainPromise) {
      this.#drainPromise = this.#drain().finally(() => {
        this.#drainPromise = null;
      });
    }
    await this.#drainPromise;
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
