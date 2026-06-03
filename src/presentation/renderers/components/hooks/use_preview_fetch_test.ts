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

import { assertEquals } from "@std/assert";
import { LruCache } from "./use_preview_fetch.ts";

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
