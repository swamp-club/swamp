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

import { assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  OrderedLookahead,
  type OrderedLookaheadOptions,
} from "./ordered_lookahead.ts";

/** each resolution waits until the test settles it */
function deferredResolver() {
  const started: string[] = [];
  const pending = new Map<string, PromiseWithResolvers<string>>();
  let running = 0;
  let mostAtOnce = 0;
  return {
    started,
    mostAtOnce: () => mostAtOnce,
    resolve: (item: string): Promise<string> => {
      started.push(item);
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      const deferred = Promise.withResolvers<string>();
      pending.set(item, deferred);
      return deferred.promise.finally(() => running--);
    },
    settle: async (item: string, value = item.toUpperCase()) => {
      await waitFor(() => pending.has(item), `${item} resolving`);
      pending.get(item)!.resolve(value);
      pending.delete(item);
    },
    fail: async (item: string, error: Error) => {
      await waitFor(() => pending.has(item), `${item} resolving`);
      pending.get(item)!.reject(error);
      pending.delete(item);
    },
  };
}

function lookaheadOf(
  items: readonly string[],
  resolve: (item: string) => Promise<string>,
  overrides: Partial<OrderedLookaheadOptions<string, string>> = {},
): { lookahead: OrderedLookahead<string, string>; discarded: string[] } {
  const discarded: string[] = [];
  const lookahead = new OrderedLookahead(
    items.map((item) => ({ key: item, item })),
    {
      depth: 2,
      resolve,
      runsAhead: () => true,
      schedulesAfter: () => true,
      fresh: () => true,
      discard: (value) => discarded.push(value),
      ...overrides,
    },
  );
  return { lookahead, discarded };
}

Deno.test("OrderedLookahead.take: the next items resolve one at a time while the taken one is worked on, never more than depth ahead", async () => {
  const resolver = deferredResolver();
  const { lookahead } = lookaheadOf(["a", "b", "c", "d"], resolver.resolve);
  const a = lookahead.take("a", "a");
  await resolver.settle("a");
  assertEquals(await a, "A");
  // a is taken and not yet done with: b resolves meanwhile, then c
  await resolver.settle("b");
  await resolver.settle("c");
  assertEquals(await lookahead.take("b", "b"), "B");
  await resolver.settle("d");
  assertEquals(await lookahead.take("c", "c"), "C");
  assertEquals(await lookahead.take("d", "d"), "D");
  assertEquals(resolver.started, ["a", "b", "c", "d"]);
  assertEquals(resolver.mostAtOnce(), 1);
  await lookahead.settle();
});

Deno.test("OrderedLookahead.take: with depth items resolved ahead, nothing more resolves until the next take", async () => {
  const resolver = deferredResolver();
  const { lookahead } = lookaheadOf(["a", "b", "c", "d"], resolver.resolve);
  const a = lookahead.take("a", "a");
  await resolver.settle("a");
  await a;
  await resolver.settle("b");
  await resolver.settle("c");
  // settle waits for every resolution under way, so it ends only if d never
  // started
  let idle = false;
  const settled = lookahead.settle().then(() => {
    idle = true;
  });
  await waitFor(
    () => idle || resolver.started.length > 3,
    "the lookahead idle or resolving d",
  );
  assertEquals(resolver.started, ["a", "b", "c"]);
  await settled;
});

Deno.test("OrderedLookahead.take: an item that may not run ahead holds the ones after it, and resolves by its take once nothing else is resolving", async () => {
  const resolver = deferredResolver();
  const asked: { item: string; pending: string[] }[] = [];
  const { lookahead } = lookaheadOf(["a", "b", "c", "d"], resolver.resolve, {
    depth: 3,
    runsAhead: (item, pending) => {
      asked.push({ item, pending: [...pending] });
      return item !== "c";
    },
  });
  const a = lookahead.take("a", "a");
  await resolver.settle("a");
  await a;
  await resolver.settle("b");
  assertEquals(await lookahead.take("b", "b"), "B");
  assertEquals(resolver.started, ["a", "b"]);
  const c = lookahead.take("c", "c");
  await resolver.settle("c");
  assertEquals(await c, "C");
  await resolver.settle("d");
  assertEquals(await lookahead.take("d", "d"), "D");
  assertEquals(resolver.started, ["a", "b", "c", "d"]);
  // each is asked about with the item taken last and those resolved ahead
  assertEquals(asked.map(({ item }) => item), ["b", "c", "d"]);
  assertEquals(asked[0].pending, ["A"]);
  assertEquals(asked[1].pending.at(-1), "B");
  assertEquals(asked[2].pending, ["C"]);
  await lookahead.settle();
});

Deno.test("OrderedLookahead.take: a failed resolution is thrown by its take and holds the rest; one skipped over is dropped", async () => {
  const resolver = deferredResolver();
  const { lookahead } = lookaheadOf(["a", "b", "c"], resolver.resolve);
  const a = lookahead.take("a", "a");
  await resolver.settle("a");
  await a;
  await resolver.fail("b", new Error("b failed"));
  await assertRejects(() => lookahead.take("b", "b"), Error, "b failed");
  await lookahead.settle();
  assertEquals(resolver.started, ["a", "b"]);

  const again = deferredResolver();
  const skipping = lookaheadOf(["a", "b", "c"], again.resolve).lookahead;
  const first = skipping.take("a", "a");
  await again.settle("a");
  await first;
  await again.fail("b", new Error("b failed"));
  const c = skipping.take("c", "c");
  await again.settle("c");
  assertEquals(await c, "C");
  await skipping.settle();
});

Deno.test("OrderedLookahead.take: a stale value is discarded and resolved again; settle waits for what is resolving and discards what none took", async () => {
  const resolver = deferredResolver();
  let generation = 0;
  const { lookahead, discarded } = lookaheadOf(
    ["a", "b", "c"],
    (item) => {
      const resolvedIn = generation;
      return resolver.resolve(item).then((v) => `${v}${resolvedIn}`);
    },
    { fresh: (value) => value.endsWith(String(generation)) },
  );
  const a = lookahead.take("a", "a");
  await resolver.settle("a");
  assertEquals(await a, "A0");
  await resolver.settle("b");
  await resolver.settle("c");
  generation = 1;
  const b = lookahead.take("b", "b");
  await resolver.settle("b");
  assertEquals(await b, "B1");
  assertEquals(discarded.sort(), ["B0", "C0"]);
  const settled = lookahead.settle();
  await resolver.settle("c");
  await settled;
  assertEquals(discarded.sort(), ["B0", "C0", "C1"]);
});

Deno.test("OrderedLookahead.take: an unknown key resolves its item on its own", async () => {
  const resolver = deferredResolver();
  const { lookahead } = lookaheadOf(["a"], resolver.resolve);
  const x = lookahead.take("x", "x");
  await resolver.settle("x");
  assertEquals(await x, "X");
  await lookahead.settle();
});
