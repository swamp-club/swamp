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

export const DEFAULT_MAX_BATCH = 512;
export const DEFAULT_MAX_QUEUE = 2048;
/** how long an exit waits on every OTLP signal together before giving up */
export const EXIT_DRAIN_MS = 1_000;

export type ExportOutcome =
  | "attempted"
  | "acknowledged"
  | "failed"
  | "dropped";

export interface ExportQueueLimits {
  readonly maxBatch?: number;
  readonly maxQueue?: number;
  readonly drainMs?: number;
}

export interface OtlpExportQueueOptions<T> extends ExportQueueLimits {
  /** rejects when the collector did not accept every item */
  readonly send: (items: readonly T[], signal: AbortSignal) => Promise<void>;
  readonly timeoutMs: number;
  readonly onOutcome?: (count: number, outcome: ExportOutcome) => void;
}

interface Pending<T> {
  readonly seq: number;
  readonly items: readonly T[];
  readonly done: (ok: boolean) => void;
}

interface FlushWaiter {
  readonly through: number;
  readonly resolve: () => void;
}

/**
 * one send in flight at a time: items that end meanwhile ride the next
 * request, so a slow collector costs one connection rather than one per item
 */
export class OtlpExportQueue<T> {
  readonly #options: OtlpExportQueueOptions<T>;
  readonly #maxBatch: number;
  readonly #maxQueue: number;
  readonly #drainMs: number;
  #queue: Pending<T>[] = [];
  #queued = 0;
  #sending: Promise<void> | undefined;
  #controller: AbortController | undefined;
  #idle: (() => void)[] = [];
  #flushes: FlushWaiter[] = [];
  #enqueued = 0;
  #settled = 0;
  #closed = false;

  constructor(options: OtlpExportQueueOptions<T>) {
    this.#options = options;
    this.#maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
    this.#maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.#drainMs = options.drainMs ?? EXIT_DRAIN_MS;
  }

  /** never blocks: past the queue limit the items are dropped and fail */
  enqueue(items: readonly T[], done: (ok: boolean) => void): void {
    if (this.#closed) {
      finish(done, false);
      return;
    }
    this.#report(items.length, "attempted");
    if (this.#queued + items.length > this.#maxQueue) {
      this.#report(items.length, "dropped");
      finish(done, false);
      return;
    }
    this.#queue.push({ seq: ++this.#enqueued, items, done });
    this.#queued += items.length;
    this.#pump();
  }

  /** unbounded, unlike shutdown: each send still gives up at its timeout */
  forceFlush(): Promise<void> {
    const through = this.#enqueued;
    if (this.#settled >= through) return Promise.resolve();
    return new Promise((resolve) => this.#flushes.push({ through, resolve }));
  }

  /** drains within the bound, then fails what is queued and aborts the send */
  async shutdown(): Promise<void> {
    this.#closed = true;
    if (await this.#drain()) return;
    const left = this.#queue.splice(0);
    this.#queued = 0;
    for (const pending of left) {
      this.#report(pending.items.length, "dropped");
      finish(pending.done, false);
    }
    this.#controller?.abort();
    await this.#sending;
    // only now: the aborted batch holds lower sequence numbers than left
    this.#markSettled(left);
  }

  #pump(): void {
    if (this.#sending) return;
    if (this.#queue.length === 0) {
      for (const resolve of this.#idle.splice(0)) resolve();
      return;
    }
    const batch: Pending<T>[] = [];
    let count = 0;
    while (
      this.#queue.length > 0 &&
      (batch.length === 0 ||
        count + this.#queue[0].items.length <= this.#maxBatch)
    ) {
      const pending = this.#queue.shift()!;
      batch.push(pending);
      count += pending.items.length;
    }
    this.#queued -= count;
    const controller = new AbortController();
    this.#controller = controller;
    this.#sending = this.#sendBatch(batch, controller).then((ok) => {
      this.#sending = undefined;
      this.#controller = undefined;
      this.#report(count, ok ? "acknowledged" : "failed");
      for (const pending of batch) finish(pending.done, ok);
      this.#markSettled(batch);
      this.#pump();
    });
  }

  async #sendBatch(
    batch: readonly Pending<T>[],
    controller: AbortController,
  ): Promise<boolean> {
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    try {
      await this.#options.send(
        batch.flatMap((pending) => pending.items),
        controller.signal,
      );
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** true when the queue went idle within the drain bound */
  async #drain(): Promise<boolean> {
    if (!this.#sending && this.#queue.length === 0) return true;
    let wake!: () => void;
    const idle = new Promise<void>((resolve) => {
      wake = resolve;
      this.#idle.push(resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#drainMs);
    });
    try {
      return await Promise.race([
        idle.then(() => true),
        bound.then(() => false),
      ]);
    } finally {
      clearTimeout(timer);
      this.#idle = this.#idle.filter((resolve) => resolve !== wake);
    }
  }

  #markSettled(pendings: readonly Pending<T>[]): void {
    for (const pending of pendings) {
      this.#settled = Math.max(this.#settled, pending.seq);
    }
    const ready = this.#flushes.filter((w) => w.through <= this.#settled);
    this.#flushes = this.#flushes.filter((w) => w.through > this.#settled);
    for (const waiter of ready) waiter.resolve();
  }

  #report(count: number, outcome: ExportOutcome): void {
    try {
      this.#options.onOutcome?.(count, outcome);
    } catch {
      // Accounting must never surface into the traced command.
    }
  }
}

function finish(done: (ok: boolean) => void, ok: boolean): void {
  try {
    done(ok);
  } catch {
    // A processor callback that throws must not stop the queue.
  }
}

export function exitDeadline(now: () => number = Date.now): number {
  return now() + EXIT_DRAIN_MS;
}

/** a rejection counts as settled: exit must never fail on telemetry */
export async function untilDeadline(
  work: Promise<unknown>,
  deadline: number,
  now: () => number = Date.now,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - now()));
  });
  try {
    await Promise.race([work.then(() => {}, () => {}), bound]);
  } finally {
    clearTimeout(timer);
  }
}
