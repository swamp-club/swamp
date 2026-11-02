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

import type { ExtensionListEntry } from "../../libswamp/extensions/list.ts";
import {
  extensionCacheKey,
  type ExtensionUpdateCheckMap,
  type ExtensionUpdateCheckRepository,
  isExtensionCheckStale,
} from "../../domain/extensions/extension_update_check_cache.ts";
import { checkExtensionVersion } from "../../domain/extensions/extension_update_service.ts";
import type { EnrichedExtensionListEntry } from "../../presentation/renderers/extension_list.ts";

export interface ExtensionListFreshnessDeps {
  getLatestVersion: (
    name: string,
    channel?: string,
  ) => Promise<string | null>;
  cacheRepository: ExtensionUpdateCheckRepository;
  now: () => Date;
  concurrency: number;
}

/**
 * on registry failure the cache is stamped latestVersion: installedVersion to
 * suppress retries for 24h, and the entry gets unknown_offline with latestVersion
 * null, so JSON consumers can tell "didn't try" from "tried and failed".
 */
export async function enrichExtensionList(
  entries: ExtensionListEntry[],
  deps: ExtensionListFreshnessDeps,
): Promise<EnrichedExtensionListEntry[]> {
  if (entries.length === 0) return [];

  const cache = await deps.cacheRepository.read();
  const now = deps.now();

  type StaleTarget = {
    index: number;
    name: string;
    installedVersion: string;
    channel?: string;
  };
  const stale: StaleTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // extension update cannot act on an auto-resolved entry, so it is not
    // offered one.
    if (e.autoResolved) continue;
    if (isExtensionCheckStale(cache, e.name, now, e.channel)) {
      stale.push({
        index: i,
        name: e.name,
        installedVersion: e.version,
        channel: e.channel,
      });
    }
  }

  type FetchResult = {
    index: number;
    name: string;
    channel?: string;
    latestVersion: string | null;
    failed: boolean;
  };
  // deps return null on failure, but a throwing implementation must not break
  // the composer; either way the cache is stamped to suppress retries for 24h.
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

  const checkedAtIso = now.toISOString();
  for (const r of fetched) {
    const key = extensionCacheKey(r.name, r.channel);
    cache[key] = {
      checkedAt: checkedAtIso,
      latestVersion: r.latestVersion ?? entries[r.index].version,
    };
  }
  if (fetched.length > 0) {
    await deps.cacheRepository.write(cache);
  }

  // a stale entry that failed this run gets unknown_offline so the failure
  // renders distinctly; stamped entries served from a fresh cache appear
  // up_to_date for 24h.
  const fetchedByIndex = new Map<number, FetchResult>(
    fetched.map((r) => [r.index, r]),
  );

  return entries.map((e, i): EnrichedExtensionListEntry => {
    if (e.autoResolved) return { ...e };
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
 * workers must turn their own failures into values; if one throws, the slot
 * records undefined for that index and continues.
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

export const DEFAULT_FRESHNESS_CONCURRENCY = 4;

export type { ExtensionUpdateCheckMap };
