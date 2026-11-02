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

export type ScanKind = "search" | "lookup";

export type ReleaseScanPermit = () => void;

interface Waiter {
  readonly kind: ScanKind;
  grant(release: ReleaseScanPermit): void;
}

/**
 * searches may hold at most searchLimit so lookups always have the rest; a
 * released permit goes to the first waiter that may take it, so a blocked
 * search does not hold up a later lookup
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

/**
 * shared by all scans, not per scan, so concurrent scans cannot exhaust
 * descriptors under a low open-file limit; searches hold at most
 * SEARCH_SCAN_SHARE so method-run lookups always keep permits
 */
export const SCAN_CONCURRENCY = 16;

export const SEARCH_SCAN_SHARE = 12;

const scanPermits = new ScanPermits(SCAN_CONCURRENCY, SEARCH_SCAN_SHARE);

/** open never waits for another permit, so scans cannot deadlock on each other */
export async function withScanPermit<T>(
  kind: ScanKind,
  open: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await scanPermits.acquire(kind, signal);
  try {
    // Inside the try: an abort that lands after a release handed this scan
    // its permit, but before this runs, must still give the permit back.
    signal?.throwIfAborted();
    return await open();
  } finally {
    release();
  }
}

/**
 * how long synchronous scan work holds the event loop before yielding, so a
 * request running beside it waits about this long at worst
 */
const SCAN_SLICE_MS = 4;

/**
 * slice does at least one item whatever the deadline says, so the work always
 * ends
 */
export async function inTimeSlices(
  more: () => boolean,
  slice: (until: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  while (more()) {
    slice(performance.now() + SCAN_SLICE_MS);
    if (more()) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
  }
}

/**
 * after a failure or abort no further item starts, and the failure is raised
 * only after every started call has settled, so none is left running
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          signal?.throwIfAborted();
          results[index] = await fn(items[index]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    },
  );
  for (const outcome of await Promise.allSettled(workers)) {
    if (outcome.status === "rejected") {
      signal?.throwIfAborted();
      throw outcome.reason;
    }
  }
  return results;
}
