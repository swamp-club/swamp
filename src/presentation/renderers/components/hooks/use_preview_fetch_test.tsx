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

import React, { useState } from "react";
import { assertEquals } from "@std/assert";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { LruCache, usePreviewFetch } from "./use_preview_fetch.ts";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- LruCache unit tests ---

Deno.test("LruCache: get returns undefined for missing key", () => {
  const cache = new LruCache<string, number>(3);
  assertEquals(cache.get("a"), undefined);
});

Deno.test("LruCache: set and get round-trip", () => {
  const cache = new LruCache<string, number>(3);
  cache.set("a", 1);
  assertEquals(cache.get("a"), 1);
  assertEquals(cache.size, 1);
});

Deno.test("LruCache: evicts oldest when over capacity", () => {
  const cache = new LruCache<string, number>(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assertEquals(cache.size, 3);

  // Adding a 4th should evict "a" (oldest)
  cache.set("d", 4);
  assertEquals(cache.size, 3);
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), 2);
  assertEquals(cache.get("c"), 3);
  assertEquals(cache.get("d"), 4);
});

Deno.test("LruCache: get moves item to most-recently-used", () => {
  const cache = new LruCache<string, number>(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);

  // Access "a" to make it most-recently-used
  cache.get("a");

  // Adding "d" should evict "b" (now the oldest), not "a"
  cache.set("d", 4);
  assertEquals(cache.get("a"), 1);
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("c"), 3);
  assertEquals(cache.get("d"), 4);
});

Deno.test("LruCache: set overwrites existing key and moves to end", () => {
  const cache = new LruCache<string, number>(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);

  // Overwrite "a" with new value
  cache.set("a", 10);
  assertEquals(cache.get("a"), 10);
  assertEquals(cache.size, 3);

  // Adding "d" should evict "b" (now oldest), not "a" (just refreshed)
  cache.set("d", 4);
  assertEquals(cache.get("a"), 10);
  assertEquals(cache.get("b"), undefined);
});

Deno.test("LruCache: clear empties the cache", () => {
  const cache = new LruCache<string, number>(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.clear();
  assertEquals(cache.size, 0);
  assertEquals(cache.get("a"), undefined);
});

Deno.test("LruCache: size 1 always evicts on new insert", () => {
  const cache = new LruCache<string, number>(1);
  cache.set("a", 1);
  cache.set("b", 2);
  assertEquals(cache.size, 1);
  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), 2);
});

// --- usePreviewFetch hook tests ---

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function UpdatableProbe(props: {
  initialItem: string | undefined;
  fetchFn: (item: string) => Promise<string>;
  onDetail: (detail: string | undefined) => void;
}) {
  const [item, setItem] = useState(props.initialItem);

  const { detail } = usePreviewFetch(
    item,
    props.fetchFn,
    (i) => i,
    10,
    10,
  );

  React.useEffect(() => {
    props.onDetail(detail);
  }, [detail]);

  (globalThis as Record<string, unknown>).__setProbeItem = setItem;

  return <Text>{detail ?? "none"}</Text>;
}

Deno.test({
  name:
    "usePreviewFetch: in-flight fetch for A is discarded after switching to cached B",
  ...inkTestOptions,
  fn: async () => {
    const fetchA = deferred<string>();
    let detail: string | undefined;
    const bResult = "B-detail";

    const fetchFn = (item: string): Promise<string> => {
      if (item === "A") return fetchA.promise;
      return Promise.resolve(bResult);
    };

    // Start with B to populate the LRU cache
    const { unmount } = render(
      <UpdatableProbe
        initialItem="B"
        fetchFn={fetchFn}
        onDetail={(d) => {
          detail = d;
        }}
      />,
    );

    await tick(200);
    assertEquals(detail, bResult);

    const setItem = (globalThis as Record<string, unknown>).__setProbeItem as (
      item: string,
    ) => void;

    // Switch to A — starts an async fetch (uncached)
    setItem("A");
    await tick(50);

    // Switch to B — cache hit, should show B's detail immediately
    // and invalidate A's in-flight fetch via the fetch-id bump
    setItem("B");
    await tick(50);
    assertEquals(detail, bResult);

    // Resolve A's fetch — must NOT overwrite B's detail
    fetchA.resolve("A-detail-stale");
    await tick(50);

    assertEquals(detail, bResult);

    unmount();
    delete (globalThis as Record<string, unknown>).__setProbeItem;
  },
});
