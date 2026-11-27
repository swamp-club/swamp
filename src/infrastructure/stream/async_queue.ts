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

/** buffered items handed out before the iterator gives timers and I/O a turn */
export const ASYNC_QUEUE_YIELD_EVERY = 256;

const COMPACT_AFTER = 1024;

export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private head = 0;
  private closed = false;
  private waiting: ((value: IteratorResult<T>) => void) | null = null;

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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  abort(_reason?: unknown): void {
    this.close();
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
    return item;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let run = 0;
    while (true) {
      if (this.head < this.buffer.length) {
        yield this.#take();
        // a drain on microtasks alone would starve timers, a lease's renewal among them
        if (++run >= ASYNC_QUEUE_YIELD_EVERY) {
          run = 0;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      } else if (this.closed) {
        return;
      } else {
        run = 0;
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
