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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  drainAllOwed,
  drainOwedWithin,
  hydrateOwedPartitions,
  type LazyHydration,
  lazyHydrationOf,
  v3LazyModelFiles,
  v3OwedFileHook,
} from "./lazy_hydration.ts";
import { isOwedFileHook } from "../../domain/datastore/datastore_sync_service.ts";
import {
  type FakeCalls,
  fakeLazyHydration,
} from "./lazy_hydration_test_helpers.ts";

Deno.test("v3LazyModelFiles: only a serve-mode checkout whose hydrationStrategy is unset or lazy owes files", () => {
  assertEquals(v3LazyModelFiles({ serveUpstream: true }), true);
  assertEquals(
    v3LazyModelFiles({ serveUpstream: true, hydrationStrategy: "lazy" }),
    true,
  );
  assertEquals(
    v3LazyModelFiles({ serveUpstream: true, hydrationStrategy: "full" }),
    false,
  );
  assertEquals(v3LazyModelFiles({ serveUpstream: false }), false);
  assertEquals(
    v3LazyModelFiles({ serveUpstream: false, hydrationStrategy: "lazy" }),
    false,
  );
});

Deno.test("lazyHydrationOf: a handle without every lazy method is not lazy", () => {
  const lazy = fakeLazyHydration();
  assert(lazyHydrationOf(lazy) === lazy);
  const { drainOwed: _drop, ...partial } = lazy;
  assertEquals(lazyHydrationOf(partial), undefined);
  assertEquals(lazyHydrationOf({}), undefined);
});

Deno.test("v3OwedFileHook: true for a hydrated path, false for one not owed, and it is owed-only", async () => {
  const lazy = fakeLazyHydration({ owedPaths: ["/repo/.swamp/data/a/raw"] });
  const hook = v3OwedFileHook(lazy);
  assert(isOwedFileHook(hook));
  const signal = new AbortController().signal;
  assertEquals(await hook("/repo/.swamp/data/a/raw", { signal }), true);
  assertEquals(await hook("/repo/.swamp/data/b/raw"), false);
  assert(lazy.calls.paths[0].signal === signal);
  // a read that passes no signal is still bounded
  assert(lazy.calls.paths[1].signal !== signal);
});

Deno.test("v3OwedFileHook: a hydrate that fails rejects the read", async () => {
  const lazy: LazyHydration = {
    ...fakeLazyHydration(),
    hydrateOwedPath: () => Promise.reject(new Error("cannot hydrate")),
  };
  await assertRejects(
    () => v3OwedFileHook(lazy)("/repo/.swamp/data/a/raw"),
    Error,
    "cannot hydrate",
  );
});

Deno.test("hydrateOwedPartitions: hydrates each partition in the namespace", async () => {
  const lazy = fakeLazyHydration();
  const count = await hydrateOwedPartitions(
    lazy,
    "team",
    ["model/a/1", "model/b/2"],
    new AbortController().signal,
  );
  assertEquals(count, 2);
  assertEquals(lazy.calls.partitions, [
    { namespace: "team", partition: "model/a/1" },
    { namespace: "team", partition: "model/b/2" },
  ]);
});

Deno.test("drainOwedWithin: checkouts share one budget and those that owe nothing are skipped", async () => {
  let clock = 0;
  const ticking = (
    lazy: LazyHydration & { calls: FakeCalls },
    takesMs: number,
  ): LazyHydration & { calls: FakeCalls } => {
    const drain = lazy.drainOwed;
    return {
      ...lazy,
      drainOwed: async (budgetMs, signal) => {
        clock += takesMs;
        return await drain(budgetMs, signal);
      },
    };
  };
  const idle = fakeLazyHydration({ owed: 0 });
  const first = ticking(fakeLazyHydration({ owed: 5 }), 1_500);
  const second = ticking(fakeLazyHydration({ owed: 3, perDrain: 1 }), 500);
  const third = fakeLazyHydration({ owed: 4 });
  const report = await drainOwedWithin(
    [idle, first, second, third],
    2_000,
    new AbortController().signal,
    () => clock,
  );
  assertEquals(idle.calls.drains, []);
  assertEquals(first.calls.drains, [2_000]);
  assertEquals(second.calls.drains, [500]);
  // the budget was spent before the third, which keeps all it owes
  assertEquals(third.calls.drains, []);
  assertEquals(report, { hydrated: 6, left: 6 });
});

Deno.test("drainAllOwed: drains every checkout until nothing is owed", async () => {
  const slow = fakeLazyHydration({ owed: 5, perDrain: 2 });
  const quick = fakeLazyHydration({ owed: 1 });
  const report = await drainAllOwed(
    [slow, quick],
    new AbortController().signal,
  );
  assertEquals(report, { hydrated: 6, left: 0 });
  assertEquals(slow.owedCount(), 0);
  assertEquals(slow.calls.drains.length, 3);
});

Deno.test("drainAllOwed: a pass that hydrates nothing while files are owed fails", async () => {
  const stuck = fakeLazyHydration({ owed: 2, perDrain: 0 });
  await assertRejects(
    () => drainAllOwed([stuck], new AbortController().signal),
    Error,
    "made no progress with 2 still owed",
  );
});
