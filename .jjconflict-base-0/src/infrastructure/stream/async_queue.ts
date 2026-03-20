// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Push-based producer to pull-based consumer bridge.
 * Producers call `push()` to enqueue items and `close()` to signal end-of-stream.
 * Consumers iterate with `for await...of`.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private closed = false;
  private waiting: ((value: IteratorResult<T>) => void) | null = null;

  /** Enqueue an item. Wakes the consumer if it's waiting. */
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

  /** Signal end-of-stream. Wakes the consumer if it's waiting. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  /**
   * Abort the queue with a reason. Closes the queue and resolves any
   * waiting consumer with `done: true`, causing `for await` to exit.
   */
  abort(_reason?: unknown): void {
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
