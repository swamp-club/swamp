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
 * Simple async iterable queue for bridging push-based WebSocket events
 * into a pull-based AsyncGenerator.
 */
export class AsyncIterableQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiter: {
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: Error) => void;
  } | null = null;
  private finished = false;
  private err: Error | null = null;

  push(value: T): void {
    if (this.finished) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  done(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve({ value: undefined as unknown as T, done: true });
    }
  }

  // Stored, not rejected, without a reader: a rejected promise nobody awaits is
  // an unhandled rejection.
  error(err: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.err = err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.err) return Promise.reject(this.err);
        if (this.finished) {
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true,
          });
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}
