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
 * Default cap on how many workflows are read concurrently when collecting run
 * summaries across all workflows. Bounds peak transient memory: an unbounded
 * `Promise.all` over every workflow would have one in-flight file parse per
 * workflow simultaneously; a modest cap keeps that to `concurrency` at a time.
 */
export const RUN_FANOUT_CONCURRENCY = 8;

/**
 * Maps `items` to arrays via `fn` with bounded concurrency and flattens the
 * results into a single array, preserving no particular order (callers sort
 * afterward). At most `concurrency` invocations of `fn` are in flight at once.
 */
export async function collectBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const part = await fn(items[index]);
      for (const r of part) out.push(r);
    }
  });
  await Promise.all(workers);
  return out;
}
