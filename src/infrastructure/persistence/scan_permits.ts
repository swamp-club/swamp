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
 * Which share of the scan permits a listing or read draws on: `"search"` for
 * the history and search listings serve requests run, `"lookup"` for the
 * per-type reads a method run makes.
 */
export type ScanKind = "search" | "lookup";

/** Gives back the permit {@link ScanPermits.acquire} took; later calls do nothing. */
export type ReleaseScanPermit = () => void;

interface Waiter {
  readonly kind: ScanKind;
  grant(release: ReleaseScanPermit): void;
}

/**
 * A counting semaphore of `limit` permits of which searches may hold at most
 * `searchLimit`, so lookups always have `limit - searchLimit` that no search
 * can take (swamp-club#4073). A released permit goes to the first waiter, in
 * arrival order, that may take it: a search waiting while searches hold
 * their whole share does not hold up a lookup that asked after it.
 */
export class ScanPermits {
  #held = 0;
  #searchesHeld = 0;
  readonly #waiters: Waiter[] = [];

  constructor(readonly limit: number, readonly searchLimit: number) {
    if (searchLimit < 1 || searchLimit >= limit) {
      throw new Error(
        "ScanPermits searchLimit must be at least 1 and less than limit",
      );
    }
  }

  /**
   * A permit of `kind`, resolved with the function that gives it back. Once
   * `signal` aborts, a caller still waiting leaves the queue without a permit
   * and the promise rejects with the abort reason.
   */
  acquire(kind: ScanKind, signal?: AbortSignal): Promise<ReleaseScanPermit> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }
    // A free permit this kind may take means no waiter could take it either:
    // every release hands out what it frees before anyone else asks.
    if (this.#mayTake(kind)) return Promise.resolve(this.#take(kind));

    return new Promise<ReleaseScanPermit>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) {
          this.#waiters.splice(index, 1);
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        }
      };
      const waiter: Waiter = {
        kind,
        grant: (release) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release);
        },
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #mayTake(kind: ScanKind): boolean {
    return this.#held < this.limit &&
      (kind === "lookup" || this.#searchesHeld < this.searchLimit);
  }

  #take(kind: ScanKind): ReleaseScanPermit {
    this.#held++;
    if (kind === "search") this.#searchesHeld++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held--;
      if (kind === "search") this.#searchesHeld--;
      this.#grantWaiters();
    };
  }

  #grantWaiters(): void {
    let index = 0;
    while (index < this.#waiters.length && this.#held < this.limit) {
      const waiter = this.#waiters[index];
      if (this.#mayTake(waiter.kind)) {
        this.#waiters.splice(index, 1);
        waiter.grant(this.#take(waiter.kind));
      } else {
        index++;
      }
    }
  }
}
