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

import type { ExtensionListEntry } from "../../libswamp/mod.ts";
import {
  extensionCacheKey,
  type ExtensionUpdateCheckMap,
  type ExtensionUpdateCheckRepository,
  isExtensionCheckStale,
} from "../../domain/extensions/extension_update_check_cache.ts";
import { checkExtensionVersion } from "../../domain/extensions/extension_update_service.ts";
import type { EnrichedExtensionListEntry } from "../../presentation/renderers/extension_list.ts";

/** Dependencies for the freshness composer. */
export interface ExtensionListFreshnessDeps {
  /** Look up the latest version for an extension. Return null on failure. */
  getLatestVersion: (
    name: string,
    channel?: string,
  ) => Promise<string | null>;
  /** Cache repository for the 24h check cooldown. */
  cacheRepository: ExtensionUpdateCheckRepository;
  /** Returns the current time. Injected for testability. */
  now: () => Date;
  /** Maximum in-flight registry calls. */
  concurrency: number;
}

/**
 * Enriches a list of installed extensions with freshness data.
 *
 * Reads the 24h cache; for any stale entries, queries the registry in
 * parallel with bounded concurrency. Cache writes are aggregated into a
 * single atomic write at the end. On registry failure, the cache is
 * stamped with `latestVersion: installedVersion` to suppress retries for
 * 24h, and the in-memory enriched entry receives `updateStatus: "unknown_offline"`
 * with `latestVersion: null` so JSON consumers can distinguish "didn't
 * try" (fields absent on the bare entry) from "tried and failed".
 *
 * Caller is responsible for the outer try/catch to degrade to a bare
 * list on unexpected throws.
 */
export async function enrichExtensionList(
  entries: ExtensionListEntry[],
  deps: ExtensionListFreshnessDeps,
): Promise<EnrichedExtensionListEntry[]> {
  if (entries.length === 0) return [];

  const cache = await deps.cacheRepository.read();
  const now = deps.now();

  // Determine which entries need a registry call.
  type StaleTarget = {
    index: number;
    name: string;
    installedVersion: string;
    channel?: string;
  };
  const stale: StaleTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (isExtensionCheckStale(cache, e.name, now, e.channel)) {
      stale.push({
        index: i,
        name: e.name,
        installedVersion: e.version,
        channel: e.channel,
      });
    }
  }

  // Result map: index → in-memory unknown_offline marker, when applicable.
  type FetchResult = {
    index: number;
    name: string;
    channel?: string;
    latestVersion: string | null;
    failed: boolean;
  };
  // Per-target worker. The deps contract is that getLatestVersion
  // returns null on failure rather than throwing — but we wrap in a
  // try/catch anyway so a misbehaving deps implementation can't break
  // the composer. Either path results in failed=true and a cache stamp
  // suppressing 24h retries.
  const fetched: FetchResult[] = await runBounded(
    stale,
    deps.concurrency,
    async (target) => {
      try {
        const latest = await deps.getLatestVersion(
          target.name,
          target.channel,
        );
        return {
          index: target.index,
          name: target.name,
          channel: target.channel,
          latestVersion: latest,
          failed: latest === null,
        };
      } catch {
        return {
          index: target.index,
          name: target.name,
          channel: target.channel,
          latestVersion: null,
          failed: true,
        };
      }
    },
  );

  // Mutate cache map in-memory; ONE atomic write at the end.
  const checkedAtIso = now.toISOString();
  for (const r of fetched) {
    const key = extensionCacheKey(r.name, r.channel);
    cache[key] = {
      checkedAt: checkedAtIso,
      // On registry failure, stamp with installedVersion to suppress
      // retries for 24h.
      latestVersion: r.latestVersion ?? entries[r.index].version,
    };
  }
  if (fetched.length > 0) {
    await deps.cacheRepository.write(cache);
  }

  // Build the enriched entries. Source of latest version:
  //   - For freshly-fetched entries: the fetch result (or null if failed).
  //   - For cache-fresh entries: the cache value.
  //   - For never-checked entries (no cache, no fetch): no enrichment.
  // The "stale and failed THIS run" case gets unknown_offline so the
  // caller can render the failure-to-fetch state distinctly. Stamped
  // entries served from a fresh cache appear up_to_date for 24h — see
  // design/extension.md for the user-visible 24h-window semantics.
  const fetchedByIndex = new Map<number, FetchResult>(
    fetched.map((r) => [r.index, r]),
  );

  return entries.map((e, i): EnrichedExtensionListEntry => {
    const fetchedEntry = fetchedByIndex.get(i);
    if (fetchedEntry?.failed) {
      return {
        ...e,
        latestVersion: null,
        updateStatus: "unknown_offline",
      };
    }
    const latestFromFetch = fetchedEntry?.latestVersion ?? null;
    const cacheKey = extensionCacheKey(e.name, e.channel);
    const latestFromCache = cache[cacheKey]?.latestVersion ?? null;
    const latest = latestFromFetch ?? latestFromCache;
    if (latest === null) return { ...e };

    const status = checkExtensionVersion(e.name, e.version, latest);
    return {
      ...e,
      latestVersion: latest,
      updateStatus: status.status === "update_available"
        ? "update_available"
        : "up_to_date",
    };
  });
}

/**
 * Runs `worker` over `items` with at most `concurrency` workers in flight
 * at once. Workers are contracted to translate their own failures into
 * success values (e.g. returning null) — if a worker throws unexpectedly,
 * the slot's slot-runner records `undefined` for that index and continues.
 * The composer's outer try/catch handles higher-level degradation.
 *
 * Internal helper; not exported from libswamp.
 */
async function runBounded<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const slots = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runSlot(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]);
      } catch {
        results[i] = undefined as R;
      }
    }
  }

  await Promise.all(Array.from({ length: slots }, runSlot));
  return results;
}

/** Default concurrency for the freshness composer. */
export const DEFAULT_FRESHNESS_CONCURRENCY = 4;

// Re-export for convenience in tests.
export type { ExtensionUpdateCheckMap };
