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

import { type ScanKind, ScanPermits } from "./scan_permits.ts";

/**
 * How many directories the output scans (swamp-club#4056, swamp-club#4058)
 * and the workflow-run scans (`YamlWorkflowRunRepository.findAllGlobalSince`
 * and `findGlobalByStatus`, swamp-club#4076) list, or files they stat or
 * read, at once, between all of those scans in the process. An async listing
 * of a large directory takes dozens of event-loop turns, and a read one more,
 * so awaiting them one at a time made a busy serve's scan as slow as its
 * turns added up. The bound is shared, not per scan, because concurrent
 * requests for different scans each scan: 16 per scan ran a serve under a low
 * hard open-file limit out of descriptors. Identical output requests share
 * one scan (swamp-club#4074), so the bound caps descriptors and sharing caps
 * memory. Lookups that open one file at a time (findById, findByIds and the
 * like) do not take a permit, so the process holds at most 16 scan
 * descriptors plus one or two per such lookup, beside the definition index's
 * 32. A workflow-run status scan that finds a workflow's run index out of
 * line with its records repairs it outside the permits, one record at a
 * time, so it adds at most one descriptor per repair under way, and it
 * validates at most {@link SCAN_CONCURRENCY} workflows at once; a since scan
 * never repairs. Every repository in the process
 * shares the permits, so scans of a slow filesystem can delay scans of
 * another. A scan given an AbortSignal (a serve request's) stops waiting for
 * permits once it aborts, starts no further listing or read, and gives back
 * each permit it holds as that listing or read settles (swamp-club#4070).
 *
 * A listing holds its permit for its whole `Deno.readDir` iteration, and its
 * directory stays open throughout, so the permit cannot be given back
 * between batches without breaking the bound on open files. Instead the
 * search and history listings serve requests run (the outputs'
 * findHistoryByDefinition, findAllGlobal and findAllGlobalSince, and both
 * workflow-run scans) may hold at most {@link SEARCH_SCAN_SHARE} permits, so
 * a method run's per-type output reads (findAll, findByDefinition,
 * findLatestByDefinition) always have the rest, however many large listings
 * are under way (swamp-club#4073). The share follows the method, not its
 * caller: serve's model output get reads through findLatestByDefinition and
 * findByDefinition, so it draws on the lookups' permits as a method run does,
 * and the boot reconciliation and shutdown passes over running runs go
 * through findGlobalByStatus, so they wait behind searches for each single
 * listing or read.
 */
export const SCAN_CONCURRENCY = 16;

/** How many of the {@link SCAN_CONCURRENCY} permits searches may hold. */
const SEARCH_SCAN_SHARE = 12;

/** The {@link SCAN_CONCURRENCY} permits all scans' listings and reads share. */
const scanPermits = new ScanPermits(SCAN_CONCURRENCY, SEARCH_SCAN_SHARE);

/**
 * `open` once one of the shared scan permits `kind` may take is free,
 * releasing it when `open` settles. `open` is one listing, stat or read: it
 * never waits for another permit, so scans cannot deadlock on each other.
 * Once `signal` aborts, a scan waiting for a permit leaves the queue without
 * one and `open` does not start; either rejects with the abort reason.
 */
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
 * `fn` of each item, at most `limit` at once, in the items' order. Once one
 * call fails, or `signal` aborts, no further item starts, and the failure is
 * raised only after every started call has settled, so none is left running.
 * Once `signal` has aborted, its reason is the failure, whichever call
 * failed first.
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
