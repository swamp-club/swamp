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
const DEFAULT_SINK_BACKOFF_BASE_MS = 1_000;
const DEFAULT_SINK_BACKOFF_MAX_MS = 60_000;
const DEFAULT_DURABLE_RETRY_MS = 1_000;
const STUCK_SINK_LOG_INTERVAL_MS = 60_000;

export interface AuditEmitterOptions {
  readonly sinks: AuditSink[];
  readonly capacity?: number;
  readonly chainState?: AuditChainState;
  readonly policy?: AuditPolicy;
  readonly hmacContext?: HmacContext;
  readonly hmacKeyRegistry?: HmacKeyRegistry;
  readonly alertEngine?: AlertRuleEngine;
  readonly sinkTimeoutMs?: number;
  /** First retry delay for a failing non-durable sink; doubles per failure. */
  readonly sinkBackoffBaseMs?: number;
  readonly sinkBackoffMaxMs?: number;
  /** Fixed delay before retrying a failed durable write. */
  readonly durableRetryMs?: number;
  readonly now?: () => number;
}

class SinkTimeoutError extends Error {}

/** Delivery state for one sink object. */
interface SinkDelivery {
  /** The delivery loop, while one is running. */
  pump: Promise<void> | null;
  /** The sink's own write, until it settles — which a timeout does not do. */
  inFlight: Promise<void> | null;
  failures: number;
  retryAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the outstanding write timed out, until it settles. */
  stuckSince: number | null;
  stuckLoggedAt: number;
  /** The last sequence in the outstanding write. */
  inFlightThroughSeq: number;
}

/**
 * Gives each sink the key its cursor and drop count are kept under: its name,
 * or for a later sink with the same name, the name with its position among
 * them (`webhook:siem.example.com#2`). Keys follow sink order, so hot-reload
 * hands each sink's cursor to its replacement.
 */
function deliveryKeys(sinks: readonly AuditSink[]): Map<AuditSink, string> {
  const keys = new Map<AuditSink, string>();
  const seen = new Map<string, number>();
  for (const sink of sinks) {
    const count = (seen.get(sink.name) ?? 0) + 1;
    seen.set(sink.name, count);
    keys.set(sink, count === 1 ? sink.name : `${sink.name}#${count}`);
  }
  for (const [name, count] of seen) {
    if (count < 2) continue;
    logger.warn(
      "{count} audit sinks share the name {sink}; the later ones are reported as {later} onwards, and delivery state follows their order, so removing or reordering them on hot-reload moves it",
      { count, sink: name, later: `${name}#2` },
    );
  }
  return keys;
}

export class AuditEmitter {
  readonly #buffer: RingBuffer<AuditEvent>;
  #sinks: AuditSink[];
  #keys: Map<AuditSink, string> = new Map();
  readonly #cursors: Map<string, number> = new Map();
  readonly #deniedRequests = new Set<string>();
  readonly #chainState: AuditChainState;
  readonly #policy: AuditPolicy | undefined;
  readonly #hmacContext: HmacContext | undefined;
  readonly #hmacKeyRegistry: HmacKeyRegistry | undefined;
  #alertEngine: AlertRuleEngine | undefined;
  readonly #sinkTimeoutMs: number;
  readonly #sinkBackoffBaseMs: number;
  readonly #sinkBackoffMaxMs: number;
  readonly #durableRetryMs: number;
  readonly #now: () => number;
  // Events are chained once, in buffer order, and kept here by buffer
  // sequence so every sink — including one replaying after a failure — is
  // handed the same sequence and digest.
  readonly #chained: Map<number, ChainedAuditEvent> = new Map();
  #chainedThroughSeq = 0;
  readonly #deliveries: Map<AuditSink, SinkDelivery> = new Map();
  readonly #dropped: Map<string, number> = new Map();
  #durableRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #drainPending = false;
  #drainPromise: Promise<void> | null = null;
  #drainAgain = false;

  constructor(
    sinksOrOptions: AuditSink[] | AuditEmitterOptions,
    capacity?: number,
  ) {
    if (Array.isArray(sinksOrOptions)) {
      this.#buffer = new RingBuffer(capacity ?? DEFAULT_BUFFER_CAPACITY);
      this.#sinks = sinksOrOptions;
      this.#chainState = new AuditChainState();
      this.#sinkTimeoutMs = DEFAULT_SINK_TIMEOUT_MS;
      this.#sinkBackoffBaseMs = DEFAULT_SINK_BACKOFF_BASE_MS;
      this.#sinkBackoffMaxMs = DEFAULT_SINK_BACKOFF_MAX_MS;
      this.#durableRetryMs = DEFAULT_DURABLE_RETRY_MS;
      this.#now = () => Date.now();
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
      this.#sinkBackoffBaseMs = sinksOrOptions.sinkBackoffBaseMs ??
        DEFAULT_SINK_BACKOFF_BASE_MS;
      this.#sinkBackoffMaxMs = sinksOrOptions.sinkBackoffMaxMs ??
        DEFAULT_SINK_BACKOFF_MAX_MS;
      this.#durableRetryMs = sinksOrOptions.durableRetryMs ??
        DEFAULT_DURABLE_RETRY_MS;
      this.#now = sinksOrOptions.now ?? (() => Date.now());
    }
    this.#keys = deliveryKeys(this.#sinks);
    for (const key of this.#keys.values()) {
      this.#cursors.set(key, 0);
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

  /**
   * Events a sink never received because it fell further behind than the
   * buffer holds. Takes the sink's name, or `name#2` onwards for a later sink
   * with the same name.
   */
  droppedEvents(sinkName: string): number {
    return this.#dropped.get(sinkName) ?? 0;
  }

  /**
   * True while a durable sink has a write outstanding past the sink timeout.
   * Nothing new reaches that sink until the write settles.
   */
  get durableStalled(): boolean {
    return this.#sinks.some((sink) =>
      sink.durable && (this.#deliveries.get(sink)?.stuckSince ?? null) !== null
    );
  }

  replaceSinks(newSinks: AuditSink[]): void {
    const oldKeys = new Set(this.#keys.values());
    this.#sinks = newSinks;
    this.#keys = deliveryKeys(newSinks);
    for (const [sink, delivery] of this.#deliveries) {
      if (newSinks.includes(sink)) continue;
      if (delivery.timer !== null) clearTimeout(delivery.timer);
      this.#deliveries.delete(sink);
    }
    const newKeys = new Set(this.#keys.values());
    for (const key of newKeys) {
      if (!this.#cursors.has(key)) {
        this.#cursors.set(key, this.#buffer.highSeq);
      }
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) {
        this.#cursors.delete(key);
        this.#dropped.delete(key);
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
    if (this.#drainPromise) {
      // A drain asked for while one runs is run after it, so a durable write
      // that settles mid-drain is not left waiting for the next event.
      this.#drainAgain = true;
      return;
    }
    this.#drainAgain = false;
    this.#drainPromise = this.#drain().then(() => {
      this.#drainPromise = null;
      if (
        this.#drainAgain || this.#buffer.highSeq > this.#chainedThroughSeq
      ) {
        this.#drainSerialized();
      }
    }, () => {
      this.#drainPromise = null;
      if (this.#drainAgain) this.#drainSerialized();
    });
  }

  #resolveHmacContext(): HmacContext | undefined {
    if (this.#hmacKeyRegistry) {
      return this.#hmacKeyRegistry.currentContext();
    }
    return this.#hmacContext;
  }

  /**
   * Chains the buffered events that have not been chained yet. Each event
   * passes through here exactly once, so HMAC, the chain and the alert rules
   * see it once however many times a sink has to be retried.
   */
  async #chainNewEvents(): Promise<ChainedAuditEvent[]> {
    const { items, startSeq } = this.#buffer.readFrom(this.#chainedThroughSeq);
    if (items.length === 0) return [];

    const caughtUp = this.#chainedThroughSeq;
    if (startSeq > caughtUp + 1) {
      logger.warn(
        "Audit buffer overflowed, {count} event(s) lost before reaching any sink",
        { count: startSeq - caughtUp - 1 },
      );
      // Every sink moves past the gap. Only what a sink was already behind
      // on counts as its own drop; the gap itself reached no sink.
      for (const [key, cursor] of this.#cursors) {
        if (cursor >= startSeq - 1) continue;
        if (cursor < caughtUp) this.#recordDropped(key, caughtUp - cursor);
        this.#cursors.set(key, startSeq - 1);
      }
      this.#chained.clear();
      this.#chainedThroughSeq = startSeq - 1;
    }

    const hmacCtx = this.#resolveHmacContext();
    const chained: ChainedAuditEvent[] = [];
    for (let i = 0; i < items.length; i++) {
      const event = hmacCtx && this.#shouldHmac(items[i])
        ? await applyHmac(hmacCtx, items[i])
        : items[i];
      const chainedEvent = await this.#chainState.chain(event);
      this.#chained.set(startSeq + i, chainedEvent);
      this.#chainedThroughSeq = startSeq + i;
      chained.push(chainedEvent);
    }
    return chained;
  }

  #recordDropped(key: string, count: number): void {
    this.#dropped.set(key, this.droppedEvents(key) + count);
    logger.warn(
      "Audit sink {sink} fell behind the audit buffer, {count} event(s) dropped for this sink",
      { sink: key, count },
    );
  }

  /** The delivery key of a current sink; a sink hot-reload removed has none. */
  #keyOf(sink: AuditSink): string | undefined {
    return this.#keys.get(sink);
  }

  /**
   * Moves a sink that has fallen behind what is still held up to the oldest
   * held event, counting the events it missed against that sink alone.
   */
  #clampCursor(sink: AuditSink): number {
    const key = this.#keyOf(sink);
    if (key === undefined) return this.#chainedThroughSeq;
    const cursor = this.#cursors.get(key) ?? 0;
    const oldestHeld: number = this.#chained.keys().next().value ??
      this.#chainedThroughSeq + 1;
    if (cursor + 1 >= oldestHeld) return cursor;
    this.#recordDropped(key, oldestHeld - 1 - cursor);
    this.#cursors.set(key, oldestHeld - 1);
    return oldestHeld - 1;
  }

  /** The chained events a sink has not received yet. */
  #batchFor(
    sink: AuditSink,
  ): { events: ChainedAuditEvent[]; throughSeq: number } {
    const throughSeq = this.#chainedThroughSeq;
    const cursor = this.#clampCursor(sink);
    const events: ChainedAuditEvent[] = [];
    for (let seq = cursor + 1; seq <= throughSeq; seq++) {
      const event = this.#chained.get(seq);
      if (event) events.push(event);
    }
    return { events, throughSeq };
  }

  #advanceCursor(sink: AuditSink, throughSeq: number): void {
    if (!this.#sinks.includes(sink)) return;
    const key = this.#keyOf(sink);
    if (key === undefined) return;
    if (throughSeq > (this.#cursors.get(key) ?? 0)) {
      this.#cursors.set(key, throughSeq);
    }
  }

  /** Forgets chained events every sink has received or the buffer has lost. */
  #pruneChained(): void {
    let keepFrom = this.#chainedThroughSeq + 1;
    for (const key of this.#keys.values()) {
      const next = (this.#cursors.get(key) ?? 0) + 1;
      if (next < keepFrom) keepFrom = next;
    }
    if (this.#buffer.oldestSeq > keepFrom) keepFrom = this.#buffer.oldestSeq;
    for (const seq of this.#chained.keys()) {
      if (seq >= keepFrom) break;
      this.#chained.delete(seq);
    }
  }

  async #drain(): Promise<void> {
    const chained = await this.#chainNewEvents();

    const webhookPromises: Promise<void>[] = [];
    if (this.#alertEngine) {
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
    }

    // Durable sinks are written first and awaited; non-durable sinks deliver
    // on their own, so a slow or failing one never holds the durable path.
    let durableFailed = false;
    const sinks = this.#sinks;
    for (const sink of sinks) {
      if (!sink.durable) continue;
      const delivery = this.#deliveryFor(sink);
      // A durable write that timed out is not sent again until it settles,
      // or the same events would be written twice.
      if (delivery.stuckSince !== null) {
        this.#reportStuck(sink, delivery);
        continue;
      }
      const { events, throughSeq } = this.#batchFor(sink);
      if (events.length === 0) continue;

      const write = (async () => {
        await sink.write(events);
      })();
      let outcome: boolean | null = null;
      const settled: Promise<void> = write.then(() => true, () => false).then(
        (succeeded) => {
          outcome = succeeded;
          if (delivery.inFlight !== settled) return;
          delivery.inFlight = null;
          if (delivery.stuckSince !== null) {
            this.#resumeDurableAfterLateSettle(
              sink,
              delivery,
              succeeded,
              throughSeq,
            );
          }
        },
      );
      delivery.inFlight = settled;
      delivery.inFlightThroughSeq = throughSeq;
      try {
        await this.#withSinkTimeout(sink, write);
        delivery.inFlight = null;
        this.#advanceCursor(sink, throughSeq);
      } catch (error: unknown) {
        if (error instanceof SinkTimeoutError && outcome === true) {
          // The write succeeded just as the timeout fired: it is delivered,
          // and retrying it would store the batch twice.
          delivery.inFlight = null;
          this.#advanceCursor(sink, throughSeq);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (
          error instanceof SinkTimeoutError && delivery.inFlight === settled
        ) {
          // Settling starts the next drain; no retry until then.
          delivery.stuckSince = this.#now();
          delivery.stuckLoggedAt = delivery.stuckSince;
          logger.warn(
            "Audit sink {sink} write timed out, it is not written again until the outstanding write settles: {error}",
            { sink: this.#keyOf(sink) ?? sink.name, error: message },
          );
          continue;
        }
        delivery.inFlight = null;
        durableFailed = true;
        logger.warn(
          "Audit sink {sink} write failed, will retry: {error}",
          { sink: this.#keyOf(sink) ?? sink.name, error: message },
        );
      }
    }
    this.#scheduleDurableRetry(durableFailed);

    this.#pruneChained();
    for (const sink of sinks) {
      if (!sink.durable) this.#pump(sink);
    }

    if (webhookPromises.length > 0) {
      await Promise.allSettled(webhookPromises);
    }
  }

  #scheduleDurableRetry(durableFailed: boolean): void {
    if (this.#durableRetryTimer !== null) {
      clearTimeout(this.#durableRetryTimer);
      this.#durableRetryTimer = null;
    }
    if (!durableFailed || this.#closed) return;
    const timer = runDetached(() =>
      setTimeout(() => {
        this.#durableRetryTimer = null;
        this.#drainSerialized();
      }, this.#durableRetryMs)
    );
    Deno.unrefTimer(timer);
    this.#durableRetryTimer = timer;
  }

  #deliveryFor(sink: AuditSink): SinkDelivery {
    let delivery = this.#deliveries.get(sink);
    if (!delivery) {
      delivery = {
        pump: null,
        inFlight: null,
        failures: 0,
        retryAt: 0,
        timer: null,
        stuckSince: null,
        stuckLoggedAt: 0,
        inFlightThroughSeq: 0,
      };
      this.#deliveries.set(sink, delivery);
    }
    return delivery;
  }

  /**
   * Starts delivery to a non-durable sink unless it is already delivering,
   * still has a write outstanding, or is backing off after a failure.
   */
  #pump(sink: AuditSink): void {
    if (!this.#sinks.includes(sink)) return;
    const delivery = this.#deliveryFor(sink);
    if (delivery.pump) return;
    if (delivery.inFlight) {
      this.#reportStuck(sink, delivery);
      return;
    }
    if (this.#now() < delivery.retryAt) return;
    const pump: Promise<void> = this.#runPump(sink, delivery).catch(
      (error: unknown) => {
        logger.warn("Audit sink {sink} delivery stopped: {error}", {
          sink: this.#keyOf(sink) ?? sink.name,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    ).finally(() => {
      if (delivery.pump === pump) delivery.pump = null;
    });
    delivery.pump = pump;
  }

  /**
   * A sink whose write timed out and has still not settled receives nothing.
   * Keeps its drop count moving and says so, at most once a minute.
   */
  #reportStuck(sink: AuditSink, delivery: SinkDelivery): void {
    if (delivery.stuckSince === null) return;
    this.#clampCursor(sink);
    const now = this.#now();
    if (now - delivery.stuckLoggedAt < STUCK_SINK_LOG_INTERVAL_MS) return;
    delivery.stuckLoggedAt = now;
    const fields = {
      sink: this.#keyOf(sink) ?? sink.name,
      seconds: Math.round((now - delivery.stuckSince) / 1000),
    };
    if (sink.durable) {
      logger.warn(
        "Audit sink {sink} has had a durable write outstanding for {seconds}s, nothing is being delivered to it; with fail-open false, serve rejects requests until it settles",
        fields,
      );
    } else {
      logger.warn(
        "Audit sink {sink} has had a write outstanding for {seconds}s, nothing is being delivered to it",
        fields,
      );
    }
  }

  /**
   * A durable write that outlived its timeout has settled: take a late
   * success as delivered, then drain again so the sink catches up, or the
   * failed batch is retried, without waiting for a new event.
   */
  #resumeDurableAfterLateSettle(
    sink: AuditSink,
    delivery: SinkDelivery,
    succeeded: boolean,
    throughSeq: number,
  ): void {
    delivery.stuckSince = null;
    if (succeeded) {
      this.#advanceCursor(sink, throughSeq);
      this.#pruneChained();
    }
    if (this.#closed || !this.#sinks.includes(sink)) return;
    this.#drainSerialized();
  }

  /**
   * A write that outlived its timeout has settled: take a late success as
   * delivered, then pick delivery back up without waiting for a new event.
   */
  #resumeAfterLateSettle(
    sink: AuditSink,
    delivery: SinkDelivery,
    succeeded: boolean,
    throughSeq: number,
  ): void {
    delivery.stuckSince = null;
    if (succeeded) {
      delivery.failures = 0;
      delivery.retryAt = 0;
      this.#advanceCursor(sink, throughSeq);
      this.#pruneChained();
    } else {
      // The sink has only now answered, so its backoff starts here.
      delivery.retryAt = this.#now() + this.#backoffDelay(delivery.failures);
    }
    if (this.#closed) return;
    const wait = delivery.retryAt - this.#now();
    if (wait <= 0) {
      this.#pump(sink);
    } else if (!succeeded || delivery.timer === null) {
      this.#scheduleSinkRetry(sink, delivery, wait);
    }
  }

  #backoffDelay(failures: number): number {
    return Math.min(
      this.#sinkBackoffMaxMs,
      this.#sinkBackoffBaseMs * 2 ** (failures - 1),
    );
  }

  async #runPump(sink: AuditSink, delivery: SinkDelivery): Promise<void> {
    while (this.#sinks.includes(sink)) {
      const { events, throughSeq } = this.#batchFor(sink);
      if (events.length === 0) return;

      const write = (async () => {
        await sink.write(events);
      })();
      const settled: Promise<void> = write.then(() => true, () => false).then(
        (succeeded) => {
          if (delivery.inFlight !== settled) return;
          delivery.inFlight = null;
          if (delivery.stuckSince !== null) {
            this.#resumeAfterLateSettle(sink, delivery, succeeded, throughSeq);
          }
        },
      );
      delivery.inFlight = settled;
      delivery.stuckSince = null;

      try {
        await this.#withSinkTimeout(sink, write);
      } catch (error: unknown) {
        delivery.failures++;
        const delay = this.#backoffDelay(delivery.failures);
        delivery.retryAt = this.#now() + delay;
        if (
          error instanceof SinkTimeoutError && delivery.inFlight === settled
        ) {
          delivery.stuckSince = this.#now();
          delivery.stuckLoggedAt = delivery.stuckSince;
        }
        logger.warn(
          "Audit sink {sink} write failed, retrying in {delay}ms: {error}",
          {
            sink: this.#keyOf(sink) ?? sink.name,
            delay,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        this.#scheduleSinkRetry(sink, delivery, delay);
        return;
      }
      delivery.failures = 0;
      delivery.retryAt = 0;
      this.#advanceCursor(sink, throughSeq);
      this.#pruneChained();
    }
  }

  #scheduleSinkRetry(
    sink: AuditSink,
    delivery: SinkDelivery,
    delay: number,
  ): void {
    if (delivery.timer !== null) clearTimeout(delivery.timer);
    delivery.timer = null;
    if (this.#closed || !this.#sinks.includes(sink)) return;
    const timer = runDetached(() =>
      setTimeout(() => {
        delivery.timer = null;
        // The timer is the backoff; a wall clock that moved must not undo it.
        delivery.retryAt = 0;
        this.#pump(sink);
      }, delay)
    );
    Deno.unrefTimer(timer);
    delivery.timer = timer;
  }

  async #withSinkTimeout(
    sink: AuditSink,
    write: Promise<void>,
  ): Promise<void> {
    if (this.#sinkTimeoutMs <= 0) {
      await write;
      return;
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#sinkTimeoutMs,
    );
    try {
      await Promise.race([
        write,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(
              new SinkTimeoutError(
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
        if (this.#drainAgain && !this.#closed) this.#drainSerialized();
      });
    }
    await this.#drainPromise;
    // Each delivery loop ends on its own: on success, failure or timeout.
    await Promise.all(
      [...this.#deliveries.values()].map((delivery) => delivery.pump),
    );
    for (const sink of this.#sinks) {
      try {
        await sink.flush();
      } catch (error: unknown) {
        logger.warn("Audit sink {sink} flush failed: {error}", {
          sink: this.#keyOf(sink) ?? sink.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * At shutdown, a durable sink whose write is stalled is given up to the sink
   * timeout to settle; if it does, one more drain delivers what it missed. If
   * it does not, the events after the stalled batch are written on their own,
   * so they still reach the WAL without the stalled batch being sent twice.
   */
  async #finishStalledDurableWrites(stalled: AuditSink[]): Promise<void> {
    let settledLate = false;
    for (const sink of stalled) {
      const delivery = this.#deliveries.get(sink);
      if (!delivery) continue;
      if (
        delivery.stuckSince === null || !delivery.inFlight ||
        await this.#settlesWithin(delivery.inFlight, this.#sinkTimeoutMs)
      ) {
        settledLate = true;
        continue;
      }
      const events: ChainedAuditEvent[] = [];
      for (
        let seq = delivery.inFlightThroughSeq + 1;
        seq <= this.#chainedThroughSeq;
        seq++
      ) {
        const event = this.#chained.get(seq);
        if (event) events.push(event);
      }
      const key = this.#keyOf(sink) ?? sink.name;
      if (events.length > 0) {
        try {
          await this.#withSinkTimeout(sink, sink.write(events));
        } catch (error: unknown) {
          logger.warn(
            "Audit sink {sink} could not write {count} event(s) at shutdown: {error}",
            {
              sink: key,
              count: events.length,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
      logger.warn(
        "Audit sink {sink} still had a durable write outstanding at shutdown; events through sequence {seq} are not confirmed stored",
        { sink: key, seq: delivery.inFlightThroughSeq },
      );
    }
    if (settledLate) await this.flush();
  }

  /** Whether a promise that never rejects settles within the given time. */
  async #settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    // Stop the retry timers before the last flush: one firing while the
    // sinks flush would start a drain that writes to sinks being closed.
    this.#closed = true;
    if (this.#durableRetryTimer !== null) {
      clearTimeout(this.#durableRetryTimer);
      this.#durableRetryTimer = null;
    }
    for (const delivery of this.#deliveries.values()) {
      if (delivery.timer !== null) clearTimeout(delivery.timer);
      delivery.timer = null;
    }
    const stalled = this.#sinks.filter((sink) =>
      sink.durable && (this.#deliveries.get(sink)?.stuckSince ?? null) !== null
    );
    await this.flush();
    await this.#finishStalledDurableWrites(stalled);
    for (const sink of this.#sinks) {
      try {
        await sink.close();
      } catch (error: unknown) {
        logger.warn("Audit sink {sink} close failed: {error}", {
          sink: this.#keyOf(sink) ?? sink.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
