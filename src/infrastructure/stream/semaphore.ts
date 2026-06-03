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
 * Counting semaphore for limiting concurrent async operations.
 *
 * Acquire a permit before starting work, release it when done.
 * When all permits are taken, `acquire()` blocks until one is released.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: {
    resolve: () => void;
    reject: (reason: unknown) => void;
  }[] = [];

  constructor(readonly limit: number) {
    if (limit < 1) {
      throw new Error("Semaphore limit must be at least 1");
    }
    this.available = limit;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }

    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);

      if (signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) {
            this.waiters.splice(idx, 1);
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });

        const origResolve = waiter.resolve;
        waiter.resolve = () => {
          signal.removeEventListener("abort", onAbort);
          origResolve();
        };
      }
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
    } else {
      this.available++;
    }
  }
}
