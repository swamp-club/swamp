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
import {
  applyHmac,
  type HmacContext,
  type HmacKeyRegistry,
} from "./audit_hmac.ts";
import type { AlertRuleEngine } from "./audit_alerts.ts";

const logger = getSwampLogger(["serve", "audit", "emitter"]);

const DEFAULT_BUFFER_CAPACITY = 10_000;
const DEFAULT_SINK_TIMEOUT_MS = 30_000;

export interface AuditEmitterOptions {
  readonly sinks: AuditSink[];
  readonly capacity?: number;
  readonly chainState?: AuditChainState;
  readonly policy?: AuditPolicy;
  readonly hmacContext?: HmacContext;
  readonly hmacKeyRegistry?: HmacKeyRegistry;
  readonly alertEngine?: AlertRuleEngine;
  readonly sinkTimeoutMs?: number;
}

export class AuditEmitter {
  readonly #buffer: RingBuffer<AuditEvent>;
  #sinks: AuditSink[];
  readonly #cursors: Map<string, number> = new Map();
  readonly #deniedRequests = new Set<string>();
  readonly #chainState: AuditChainState;
  readonly #policy: AuditPolicy | undefined;
  readonly #hmacContext: HmacContext | undefined;
  readonly #hmacKeyRegistry: HmacKeyRegistry | undefined;
  #alertEngine: AlertRuleEngine | undefined;
  readonly #sinkTimeoutMs: number;
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
      this.#sinkTimeoutMs = DEFAULT_SINK_TIMEOUT_MS;
    } else {
      this.#buffer = new RingBuffer(
        sinksOrOptions.capacity ?? DEFAULT_BUFFER_CAPACITY,
      );
      this.#sinks = sinksOrOptions.sinks;
      this.#chainState = sinksOrOptions.chainState ?? new AuditChainState();
      this.#policy = sinksOrOptions.policy;
      this.#hmacContext = sinksOrOptions.hmacContext;
      this.#hmacKeyRegistry = sinksOrOptions.hmacKeyRegistry;
      this.#alertEngine = sinksOrOptions.alertEngine;
      this.#sinkTimeoutMs = sinksOrOptions.sinkTimeoutMs ??
        DEFAULT_SINK_TIMEOUT_MS;
    }
    for (const sink of this.#sinks) {
      this.#cursors.set(sink.name, 0);
    }
  }

  get chainState(): AuditChainState {
    return this.#chainState;
  }

  get hmacKeyRegistry(): HmacKeyRegistry | undefined {
    return this.#hmacKeyRegistry;
  }

  get alertEngine(): AlertRuleEngine | undefined {
    return this.#alertEngine;
  }

  set alertEngine(engine: AlertRuleEngine | undefined) {
    this.#alertEngine = engine;
  }

  replaceSinks(newSinks: AuditSink[]): void {
    const oldNames = new Set(this.#sinks.map((s) => s.name));
    this.#sinks = newSinks;
    for (const sink of newSinks) {
      if (!this.#cursors.has(sink.name)) {
        this.#cursors.set(sink.name, this.#buffer.highSeq);
      }
    }
    for (const name of oldNames) {
      if (!newSinks.some((s) => s.name === name)) {
        this.#cursors.delete(name);
      }
    }
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

  #shouldHmac(event: AuditEvent): boolean {
    if (!this.#policy) return true;
    return this.#policy.shouldHmac(
      event.category as AuditCategory,
      event.action,
    );
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

  #resolveHmacContext(): HmacContext | undefined {
    if (this.#hmacKeyRegistry) {
      return this.#hmacKeyRegistry.currentContext();
    }
    return this.#hmacContext;
  }

  async #drain(): Promise<void> {
    const minCursor = this.#minCursor();
    const { items, throughSeq } = this.#buffer.readFrom(minCursor);
    if (items.length === 0) return;

    const hmacCtx = this.#resolveHmacContext();

    const processed: AuditEvent[] = [];
    for (const event of items) {
      if (hmacCtx && this.#shouldHmac(event)) {
        processed.push(await applyHmac(hmacCtx, event));
      } else {
        processed.push(event);
      }
    }

    const chainSnapshot = this.#chainState.snapshot();
    const chained: ChainedAuditEvent[] = [];
    for (const event of processed) {
      chained.push(await this.#chainState.chain(event));
    }

    if (this.#alertEngine) {
      const webhookPromises: Promise<void>[] = [];
      for (const event of chained) {
        const fired = this.#alertEngine.evaluate(event);
        for (const alert of fired) {
          if (alert.action.type === "log") {
            this.emit({
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              instanceId: event.instanceId,
              category: "system",
              stage: "response",
              outcome: "success",
              action: "alert.fired",
              resourceKind: "alert-rule",
              resourceName: alert.ruleName,
              principalKind: "system",
              principalId: "audit-engine",
              initiatedBy: "audit-engine",
              sourceIp: "127.0.0.1",
              requestId: crypto.randomUUID(),
              detail:
                `Alert "${alert.ruleName}" fired: ${alert.windowCount} events in window (matched event ${alert.matchedEventId})`,
            });
          } else if (alert.action.type === "webhook") {
            const body = JSON.stringify({
              type: "alert.fired",
              rule: alert.ruleName,
              description: alert.ruleDescription,
              matchedEventId: alert.matchedEventId,
              windowCount: alert.windowCount,
              timestamp: new Date().toISOString(),
            });
            webhookPromises.push(
              fetch(alert.action.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: AbortSignal.timeout(5000),
              }).then(() => {}).catch((err: unknown) => {
                logger.warn(
                  "Alert webhook delivery failed for rule {rule}: {error}",
                  {
                    rule: alert.ruleName,
                    error: err instanceof Error ? err.message : String(err),
                  },
                );
              }),
            );
          }
        }
      }
      if (webhookPromises.length > 0) {
        await Promise.allSettled(webhookPromises);
      }
    }

    let anyDurableWriteSucceeded = false;
    const sinks = this.#sinks;
    for (const sink of sinks) {
      const sinkCursor = this.#cursors.get(sink.name) ?? 0;
      const offset = sinkCursor - minCursor;
      const sinkEvents = offset > 0 ? chained.slice(offset) : chained;
      if (sinkEvents.length === 0) continue;
      try {
        await this.#writeSinkWithTimeout(sink, sinkEvents);
        if (this.#sinks.includes(sink)) {
          this.#cursors.set(sink.name, throughSeq);
        }
        if (sink.durable) anyDurableWriteSucceeded = true;
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

    if (!anyDurableWriteSucceeded) {
      this.#chainState.restore(chainSnapshot);
    }
  }

  async #writeSinkWithTimeout(
    sink: AuditSink,
    events: readonly ChainedAuditEvent[],
  ): Promise<void> {
    if (this.#sinkTimeoutMs <= 0) {
      await sink.write(events);
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#sinkTimeoutMs,
    );
    try {
      await Promise.race([
        sink.write(events),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(
              new Error(
                `Audit sink "${sink.name}" timed out after ${this.#sinkTimeoutMs}ms`,
              ),
            );
          });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
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
