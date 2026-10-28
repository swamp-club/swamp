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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type ReleaseScanPermit,
  type ScanKind,
  ScanPermits,
} from "./scan_permits.ts";

/** An acquire whose grant a test can observe without awaiting it. */
function track(permits: ScanPermits, kind: ScanKind, signal?: AbortSignal) {
  const state: { release?: ReleaseScanPermit; promise: Promise<void> } = {
    promise: Promise.resolve(),
  };
  state.promise = permits.acquire(kind, signal).then((release) => {
    state.release = release;
  });
  return state;
}

/** Lets settled acquires' continuations run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

Deno.test("ScanPermits: rejects a search share outside 1 to limit - 1", () => {
  assertThrows(() => new ScanPermits(4, 0), Error, "searchLimit");
  assertThrows(() => new ScanPermits(4, 4), Error, "searchLimit");
  new ScanPermits(4, 3);
});

Deno.test("ScanPermits: searches hold at most their share, and lookups take the rest", async () => {
  const permits = new ScanPermits(4, 3);
  const searches = [0, 1, 2, 3].map(() => track(permits, "search"));
  await settle();
  assertEquals(searches.map((s) => s.release !== undefined), [
    true,
    true,
    true,
    false,
  ]);

  // The fourth search waits at the head of the queue; the lookup asked after
  // it still takes the permit no search may hold.
  const lookup = track(permits, "lookup");
  await settle();
  assertEquals(lookup.release !== undefined, true);
  assertEquals(searches[3].release, undefined);

  searches[0].release!();
  await settle();
  assertEquals(searches[3].release !== undefined, true);
});

Deno.test("ScanPermits: lookups may hold every permit, and never more", async () => {
  const permits = new ScanPermits(4, 3);
  const lookups = [0, 1, 2, 3, 4].map(() => track(permits, "lookup"));
  await settle();
  assertEquals(lookups.filter((l) => l.release !== undefined).length, 4);
  const search = track(permits, "search");
  await settle();
  assertEquals(search.release, undefined);

  lookups[0].release!();
  await settle();
  // The lookup asked before the search gets the freed permit.
  assertEquals(lookups[4].release !== undefined, true);
  assertEquals(search.release, undefined);

  lookups[1].release!();
  await settle();
  assertEquals(search.release !== undefined, true);
});

Deno.test("ScanPermits: a release goes to the first waiter in arrival order that may take it", async () => {
  const permits = new ScanPermits(4, 3);
  const held = [0, 1, 2].map(() => track(permits, "search"));
  const lookupHeld = track(permits, "lookup");
  await settle();

  const waitingSearch = track(permits, "search");
  const firstLookup = track(permits, "lookup");
  const secondLookup = track(permits, "lookup");
  await settle();

  // Searches hold their whole share, so the waiting search may not take the
  // permit the lookup frees: the first lookup in line does.
  lookupHeld.release!();
  await settle();
  assertEquals(waitingSearch.release, undefined);
  assertEquals(firstLookup.release !== undefined, true);
  assertEquals(secondLookup.release, undefined);

  // A search's permit goes to the search waiting longest, ahead of the
  // lookup that asked after it.
  held[0].release!();
  await settle();
  assertEquals(waitingSearch.release !== undefined, true);
  assertEquals(secondLookup.release, undefined);
});

Deno.test("ScanPermits: a second call of a release gives nothing back", async () => {
  const permits = new ScanPermits(2, 1);
  const first = await permits.acquire("lookup");
  await permits.acquire("lookup");
  const waiting = track(permits, "lookup");
  const alsoWaiting = track(permits, "lookup");

  first();
  first();
  await settle();
  assertEquals(waiting.release !== undefined, true);
  assertEquals(alsoWaiting.release, undefined);
});

Deno.test("ScanPermits: a waiter whose signal aborts rejects with the reason and takes no permit", async () => {
  const permits = new ScanPermits(2, 1);
  const holder = await permits.acquire("search");
  const controller = new AbortController();
  const reason = new DOMException("request cancelled", "AbortError");
  const aborted = permits.acquire("search", controller.signal);
  const behind = track(permits, "search");
  controller.abort(reason);
  assertEquals(await assertRejects(() => aborted), reason);

  holder();
  await settle();
  // The search behind it gets the permit the aborted one would have.
  assertEquals(behind.release !== undefined, true);
});

Deno.test("ScanPermits: an already aborted signal rejects without taking a permit", async () => {
  const permits = new ScanPermits(2, 1);
  const controller = new AbortController();
  const reason = new DOMException("request cancelled", "AbortError");
  controller.abort(reason);
  assertEquals(
    await assertRejects(() => permits.acquire("lookup", controller.signal)),
    reason,
  );
  await permits.acquire("lookup");
  await permits.acquire("lookup");
});

Deno.test("ScanPermits: a permit handed over before its signal aborts stays held until released", async () => {
  const permits = new ScanPermits(2, 1);
  const holder = await permits.acquire("lookup");
  await permits.acquire("lookup");
  const controller = new AbortController();
  const granted = track(permits, "lookup", controller.signal);
  holder();
  await settle();
  controller.abort();
  assertEquals(granted.release !== undefined, true);

  const next = track(permits, "lookup");
  await settle();
  assertEquals(next.release, undefined);
  granted.release!();
  await settle();
  assertEquals(next.release !== undefined, true);
});
