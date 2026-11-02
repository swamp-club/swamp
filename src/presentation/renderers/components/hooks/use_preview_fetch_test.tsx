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
import { waitFor } from "@swamp-club/swamp-testing";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { LruCache, usePreviewFetch } from "./use_preview_fetch.ts";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

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

  cache.get("a");

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

  cache.set("a", 10);
  assertEquals(cache.get("a"), 10);
  assertEquals(cache.size, 3);

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
    let aRequested = false;
    const bResult = "B-detail";

    const fetchFn = (item: string): Promise<string> => {
      if (item === "A") {
        aRequested = true;
        return fetchA.promise;
      }
      return Promise.resolve(bResult);
    };

    const { unmount } = render(
      <UpdatableProbe
        initialItem="B"
        fetchFn={fetchFn}
        onDetail={(d) => {
          detail = d;
        }}
      />,
    );

    await waitFor(() => detail === bResult, "B's detail");

    const setItem = (globalThis as Record<string, unknown>).__setProbeItem as (
      item: string,
    ) => void;

    setItem("A");
    await waitFor(() => aRequested && detail === undefined, "A's fetch");

    // a cache hit shows B at once, and the fetch-id bump invalidates A's
    // in-flight fetch
    setItem("B");
    await waitFor(() => detail === bResult, "B's cached detail");

    fetchA.resolve("A-detail-stale");
    await fetchA.promise;

    assertEquals(detail, bResult);

    unmount();
    delete (globalThis as Record<string, unknown>).__setProbeItem;
  },
});
