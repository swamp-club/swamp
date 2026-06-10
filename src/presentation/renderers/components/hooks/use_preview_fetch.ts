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

import { useEffect, useRef, useState } from "react";

/** Default debounce delay before fetching preview detail (milliseconds). */
const DEFAULT_DEBOUNCE_MS = 100;

/** Default number of entries to retain in the LRU cache. */
const DEFAULT_CACHE_SIZE = 10;

/**
 * Simple LRU cache backed by a Map (which preserves insertion order).
 * When the cache exceeds `maxSize`, the least-recently-used entry is evicted.
 */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    // If key already exists, delete first so it moves to the end
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);

    // Evict oldest if over capacity
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * Return value from usePreviewFetch.
 */
export interface PreviewFetchResult<D> {
  /** The fetched detail data, or undefined if not yet loaded. */
  detail: D | undefined;
}

/**
 * React hook that fetches preview detail data with debouncing and LRU caching.
 *
 * When `item` changes:
 * 1. Any in-flight fetch is cancelled (its result is ignored).
 * 2. If the item is in the LRU cache, the cached detail is returned immediately.
 * 3. Otherwise, after `debounceMs` of stability, `fetchFn(item)` is called.
 * 4. The result is cached and returned.
 *
 * @param item - The currently highlighted item, or undefined if nothing is selected.
 * @param fetchFn - Async function to fetch detail data for an item. If undefined,
 *   no fetching occurs and detail is always undefined.
 * @param keyFn - Function to extract a cache key from an item. Defaults to the
 *   item itself (reference equality).
 * @param debounceMs - Milliseconds to wait before fetching. Defaults to 100.
 * @param cacheSize - Maximum LRU cache entries. Defaults to 10.
 */
export function usePreviewFetch<T, D>(
  item: T | undefined,
  fetchFn: ((item: T) => Promise<D>) | undefined,
  keyFn: (item: T) => unknown = (i) => i,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
  cacheSize: number = DEFAULT_CACHE_SIZE,
): PreviewFetchResult<D> {
  const [detail, setDetail] = useState<D | undefined>(undefined);

  // Stable refs to avoid re-creating effects on every render
  const cacheRef = useRef(new LruCache<unknown, D>(cacheSize));
  const fetchIdRef = useRef(0);

  useEffect(() => {
    // Reset detail when item changes
    setDetail(undefined);

    if (item === undefined || fetchFn === undefined) {
      return;
    }

    // Increment fetch ID to invalidate any in-flight fetch, even on cache hits
    const currentFetchId = ++fetchIdRef.current;

    const key = keyFn(item);

    // Check cache first
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      setDetail(cached);
      return;
    }

    const timer = setTimeout(() => {
      fetchFn(item).then((result) => {
        // Only apply if this fetch hasn't been superseded
        if (fetchIdRef.current === currentFetchId) {
          cacheRef.current.set(key, result);
          setDetail(result);
        }
      }).catch(() => {
        // Silently ignore fetch errors — the preview stays at immediate content
      });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
    };
  }, [item, fetchFn, keyFn, debounceMs]);

  return { detail };
}
