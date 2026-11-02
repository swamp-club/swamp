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

export type ScanKind = "search" | "lookup" | "bulk";

export type ReleaseScanPermit = () => void;

interface Waiter {
  readonly kind: ScanKind;
  grant(release: ReleaseScanPermit): void;
}

/**
 * searches and bulk scans together hold at most searchLimit so lookups always
 * have the rest, and bulk scans at most bulkLimit of that; a released permit
 * goes to the first waiter that may take it, so a blocked waiter does not hold
 * up a later one of another kind
 */
export class ScanPermits {
  #held = 0;
  #searchesHeld = 0;
  #bulkHeld = 0;
  readonly #waiters: Waiter[] = [];

  constructor(
    readonly limit: number,
    readonly searchLimit: number,
    readonly bulkLimit: number = searchLimit,
  ) {
    if (searchLimit < 1 || searchLimit >= limit) {
      throw new Error(
        "ScanPermits searchLimit must be at least 1 and less than limit",
      );
    }
    if (bulkLimit < 1 || bulkLimit > searchLimit) {
      throw new Error(
        "ScanPermits bulkLimit must be at least 1 and at most searchLimit",
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
    if (this.#held >= this.limit) return false;
    if (kind === "lookup") return true;
    if (this.#searchesHeld >= this.searchLimit) return false;
    return kind === "search" || this.#bulkHeld < this.bulkLimit;
  }

  #take(kind: ScanKind): ReleaseScanPermit {
    this.#held++;
    if (kind !== "lookup") this.#searchesHeld++;
    if (kind === "bulk") this.#bulkHeld++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held--;
      if (kind !== "lookup") this.#searchesHeld--;
      if (kind === "bulk") this.#bulkHeld--;
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

/**
 * long output scans take at most this much of the search share, so another
 * request's scan can still start
 */
export const BULK_SCAN_SHARE = 6;

const scanPermits = new ScanPermits(
  SCAN_CONCURRENCY,
  SEARCH_SCAN_SHARE,
  BULK_SCAN_SHARE,
);

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
 * inTimeSlices that runs the first slice before it returns, and returns nothing
 * to await when that slice finished the work, so short work adds no microtask
 * turn: callers made together still reach a shared scan before it starts
 */
export function inTimeSlicesFromNow(
  more: () => boolean,
  slice: (until: number) => void,
  signal?: AbortSignal,
): Promise<void> | undefined {
  if (!more()) return undefined;
  slice(performance.now() + SCAN_SLICE_MS);
  if (!more()) return undefined;
  return (async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    await inTimeSlices(more, slice, signal);
  })();
}

/**
 * for loops that await per item: awaiting a settled promise runs only
 * microtasks, so a long loop never lets a timer or socket in; checking `over`
 * first keeps a loop that fits in its slice free of extra microtask turns
 */
export class TimeSlice {
  #end = performance.now() + SCAN_SLICE_MS;

  constructor(private readonly signal?: AbortSignal) {}

  get over(): boolean {
    return performance.now() >= this.#end;
  }

  async next(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.signal?.throwIfAborted();
    this.#end = performance.now() + SCAN_SLICE_MS;
  }
}

/** native sort within a run bounds each block; merging the runs is what slices */
const SORT_RUN = 1024;

const MERGE_STEP = 512;

/**
 * stable, and sorts a copy: ties keep the order of `items`; one slice deadline
 * spans every pass, so finishing a pass never starts a fresh slice
 */
export async function sortInTimeSlices<T>(
  items: readonly T[],
  compare: (a: T, b: T) => number,
  signal?: AbortSignal,
): Promise<T[]> {
  let from = items.slice();
  let to = new Array<T>(from.length);
  let sorted = 0;
  let width = SORT_RUN;
  let out = 0;
  let left = 0;
  let mid = 0;
  let right = 0;
  let end = 0;
  const done = () => sorted >= from.length && width >= from.length;
  await inTimeSlices(
    () => !done(),
    (until) => {
      do {
        if (sorted < from.length) {
          const runEnd = Math.min(sorted + SORT_RUN, from.length);
          const run = from.slice(sorted, runEnd).sort(compare);
          for (let i = 0; i < run.length; i++) from[sorted + i] = run[i];
          sorted = runEnd;
          continue;
        }
        if (out === from.length) {
          [from, to] = [to, from];
          width *= 2;
          out = 0;
          end = 0;
          continue;
        }
        if (out === end) {
          left = out;
          mid = Math.min(out + width, from.length);
          right = mid;
          end = Math.min(out + 2 * width, from.length);
        }
        const stop = Math.min(end, out + MERGE_STEP);
        while (out < stop) {
          to[out++] = left < mid &&
              (right >= end || compare(from[left], from[right]) <= 0)
            ? from[left++]
            : from[right++];
        }
      } while (!done() && performance.now() < until);
    },
    signal,
  );
  return from;
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
