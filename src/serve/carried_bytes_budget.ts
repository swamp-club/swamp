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
 * Bytes of carried chunks serve has read but not yet stored, across every
 * request. A read waits for room rather than being refused; a request larger
 * than the whole budget waits until nothing else holds any.
 */
export class CarriedBytesBudget {
  readonly total: number;
  #used = 0;
  readonly #waiters: {
    readonly bytes: number;
    readonly grant: () => void;
  }[] = [];

  constructor(total: number) {
    if (!Number.isSafeInteger(total) || total <= 0) {
      throw new RangeError(`A byte budget must be positive, not ${total}`);
    }
    this.total = total;
  }

  get used(): number {
    return this.#used;
  }

  /** resolves with a release that is safe to call more than once */
  acquire(bytes: number, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const wanted = Math.max(0, bytes);
    if (this.#waiters.length === 0 && this.#fits(wanted)) {
      return Promise.resolve(this.#take(wanted));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        bytes: wanted,
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve(this.#take(wanted));
        },
      };
      const onAbort = () => {
        const at = this.#waiters.indexOf(waiter);
        if (at >= 0) this.#waiters.splice(at, 1);
        reject(signal.reason);
        this.#grantWaiting();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #fits(bytes: number): boolean {
    return this.#used === 0 || this.#used + bytes <= this.total;
  }

  #take(bytes: number): () => void {
    this.#used += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#used -= bytes;
      this.#grantWaiting();
    };
  }

  // first come, first served: a large waiter is not passed by smaller ones
  #grantWaiting(): void {
    while (this.#waiters.length > 0 && this.#fits(this.#waiters[0].bytes)) {
      this.#waiters.shift()!.grant();
    }
  }
}
