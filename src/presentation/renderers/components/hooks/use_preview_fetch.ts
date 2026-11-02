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

const DEFAULT_DEBOUNCE_MS = 100;

const DEFAULT_CACHE_SIZE = 10;

export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);

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

export interface PreviewFetchResult<D> {
  detail: D | undefined;
}

export function usePreviewFetch<T, D>(
  item: T | undefined,
  fetchFn: ((item: T) => Promise<D>) | undefined,
  keyFn: (item: T) => unknown = (i) => i,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
  cacheSize: number = DEFAULT_CACHE_SIZE,
): PreviewFetchResult<D> {
  const [detail, setDetail] = useState<D | undefined>(undefined);

  const cacheRef = useRef(new LruCache<unknown, D>(cacheSize));
  const fetchIdRef = useRef(0);

  useEffect(() => {
    setDetail(undefined);

    if (item === undefined || fetchFn === undefined) {
      return;
    }

    // Increment fetch ID to invalidate any in-flight fetch, even on cache hits
    const currentFetchId = ++fetchIdRef.current;

    const key = keyFn(item);

    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      setDetail(cached);
      return;
    }

    const timer = setTimeout(() => {
      fetchFn(item).then((result) => {
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
