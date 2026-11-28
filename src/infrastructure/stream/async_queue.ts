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

/**
 * how long a drain or a producer runs before it gives the event loop a full
 * turn: a timer turn lets pending I/O, such as a lease renewal's reply, progress
 */
export const ASYNC_QUEUE_SLICE_MS = 20;

/** queued items past which belowHighWater() makes a producer wait */
export const ASYNC_QUEUE_HIGH_WATER = 4096;

const COMPACT_AFTER = 1024;

export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private head = 0;
  private closed = false;
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private belowMark: (() => void)[] = [];

  constructor(private readonly highWaterMark = ASYNC_QUEUE_HIGH_WATER) {}

  get size(): number {
    return this.buffer.length - this.head;
  }

  push(item: T): void {
    if (this.closed) {
      throw new Error("Cannot push to a closed AsyncQueue");
    }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /**
   * undefined while the queue is below its high-water mark; otherwise settles
   * once the consumer has taken it down to half the mark, or the queue closes
   */
  belowHighWater(): Promise<void> | undefined {
    if (this.closed || this.size < this.highWaterMark) return undefined;
    return new Promise<void>((resolve) => this.belowMark.push(resolve));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#releaseProducers();
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  abort(_reason?: unknown): void {
    this.close();
  }

  #releaseProducers(): void {
    const waiters = this.belowMark;
    this.belowMark = [];
    for (const resolve of waiters) resolve();
  }

  #take(): T {
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined as T;
    this.head++;
    if (this.head === this.buffer.length) {
      this.buffer = [];
      this.head = 0;
    } else if (
      this.head >= COMPACT_AFTER && this.head * 2 >= this.buffer.length
    ) {
      this.buffer = this.buffer.slice(this.head);
      this.head = 0;
    }
    if (
      this.belowMark.length > 0 && this.size * 2 <= this.highWaterMark
    ) {
      this.#releaseProducers();
    }
    return item;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let sliceStart = performance.now();
    while (true) {
      if (this.head < this.buffer.length) {
        yield this.#take();
        // a drain on microtasks alone would starve timers and I/O, a lease's renewal among them
        if (performance.now() - sliceStart >= ASYNC_QUEUE_SLICE_MS) {
          await yieldToEventLoop();
          sliceStart = performance.now();
        }
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
        sliceStart = performance.now();
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
