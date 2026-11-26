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

import { DEFAULT_SYNC_TIMEOUT_MS } from "../../domain/datastore/datastore_config.ts";
import type { OwedFileHook } from "../../domain/datastore/datastore_sync_service.ts";

/** what a v3 handle opened with lazyModelFiles offers its checkout */
export interface LazyHydration {
  /** throws when the file is owed but cannot be hydrated */
  hydrateOwedPath(
    absPath: string,
    signal: AbortSignal,
  ): Promise<"hydrated" | "not_owed">;
  hydrateOwedPartition(
    namespace: string,
    partition: string,
    signal: AbortSignal,
  ): Promise<number>;
  drainOwed(
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<{ hydrated: number; left: number }>;
  owedCount(): number;
}

export interface OwedDrainReport {
  readonly hydrated: number;
  readonly left: number;
}

export const OWED_DRAIN_BUDGET_MS = 2_000;

/** a file already downloading when the budget ends may finish within this */
export const OWED_DRAIN_ABORT_GRACE_MS = 3_000;

/** a hydrate downloads chunks, so it is bounded as one sync direction is */
export const OWED_HYDRATE_TIMEOUT_MS = DEFAULT_SYNC_TIMEOUT_MS;

/** each drain-all pass is bounded so a progress check runs between passes */
const DRAIN_ALL_PASS_MS = 30_000;

export interface LazyCheckout {
  readonly serveUpstream: boolean;
  readonly hydrationStrategy?: string;
}

/** filesystem-mode v3 and hydrationStrategy full always write every file */
export function v3LazyModelFiles(checkout: LazyCheckout): boolean {
  return checkout.serveUpstream &&
    (checkout.hydrationStrategy === undefined ||
      checkout.hydrationStrategy === "lazy");
}

export function lazyHydrationOf(handle: object): LazyHydration | undefined {
  const candidate = handle as Partial<LazyHydration>;
  return typeof candidate.hydrateOwedPath === "function" &&
      typeof candidate.hydrateOwedPartition === "function" &&
      typeof candidate.drainOwed === "function" &&
      typeof candidate.owedCount === "function"
    ? handle as LazyHydration
    : undefined;
}

export function v3OwedFileHook(lazy: LazyHydration): OwedFileHook {
  const hook = async (
    absPath: string,
    options?: { signal?: AbortSignal },
  ): Promise<boolean> =>
    await lazy.hydrateOwedPath(
      absPath,
      options?.signal ?? AbortSignal.timeout(OWED_HYDRATE_TIMEOUT_MS),
    ) === "hydrated";
  return Object.assign(hook, { owedOnly: true as const });
}

export async function hydrateOwedPartitions(
  lazy: LazyHydration,
  namespace: string,
  partitions: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  let hydrated = 0;
  for (const partition of partitions) {
    hydrated += await lazy.hydrateOwedPartition(namespace, partition, signal);
  }
  return hydrated;
}

/** one budget for all: each checkout drains in what those before it left */
export async function drainOwedWithin(
  lazies: readonly LazyHydration[],
  budgetMs: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<OwedDrainReport> {
  const deadline = now() + budgetMs;
  let hydrated = 0;
  let left = 0;
  for (const lazy of lazies) {
    const owed = lazy.owedCount();
    if (owed === 0) continue;
    const remaining = deadline - now();
    if (remaining <= 0 || signal.aborted) {
      left += owed;
      continue;
    }
    const report = await lazy.drainOwed(remaining, signal);
    hydrated += report.hydrated;
    left += report.left;
  }
  return { hydrated, left };
}

/** a pass that leaves as many files owed as before it fails the drain */
export async function drainAllOwed(
  lazies: readonly LazyHydration[],
  signal: AbortSignal,
): Promise<OwedDrainReport> {
  let hydrated = 0;
  for (const lazy of lazies) {
    let before = lazy.owedCount();
    while (before > 0) {
      signal.throwIfAborted();
      const report = await lazy.drainOwed(DRAIN_ALL_PASS_MS, signal);
      hydrated += report.hydrated;
      if (report.left === 0) break;
      // a pass that settles rows without writing them (stale, another
      // writer's, unreadable) still progresses: judge by what is left
      if (report.left >= before) {
        throw new Error(
          `Hydrating the files this checkout is owed made no progress with ` +
            `${report.left} still owed. Run the command again; if it keeps ` +
            `failing, run \`swamp doctor datastores\`.`,
        );
      }
      before = report.left;
    }
  }
  return { hydrated, left: 0 };
}
