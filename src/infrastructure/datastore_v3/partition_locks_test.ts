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

import { assertEquals, assertThrows } from "@std/assert";
import { HeldPartitionLocks, PartitionLocks } from "./partition_locks.ts";

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => open = resolve);
  return { open, opened };
}

Deno.test("PartitionLocks.hold: holders of one key run in arrival order, one at a time", async () => {
  const locks = new PartitionLocks();
  const order: string[] = [];
  const first = gate();
  const runs = [
    locks.hold(["p"], async () => {
      order.push("a:start");
      await first.opened;
      order.push("a:end");
    }),
    locks.hold(["p"], () => {
      order.push("b");
      return Promise.resolve();
    }),
    locks.hold(["p"], () => {
      order.push("c");
      return Promise.resolve();
    }),
  ];
  await Promise.resolve();
  first.open();
  await Promise.all(runs);
  assertEquals(order, ["a:start", "a:end", "b", "c"]);
  assertEquals(locks.size, 0);
});

Deno.test("PartitionLocks.hold: holders of different keys overlap", async () => {
  const locks = new PartitionLocks();
  const both = gate();
  let inside = 0;
  let most = 0;
  const run = (key: string) =>
    locks.hold([key], async () => {
      inside++;
      most = Math.max(most, inside);
      if (inside === 2) both.open();
      await both.opened;
      inside--;
    });
  await Promise.all([run("p"), run("q")]);
  assertEquals(most, 2);
});

Deno.test("PartitionLocks.hold: overlapping key sets given in opposite orders do not deadlock", async () => {
  const locks = new PartitionLocks();
  const order: string[] = [];
  await Promise.all([
    locks.hold(["q", "p"], () => {
      order.push("qp");
      return Promise.resolve();
    }),
    locks.hold(["p", "q"], () => {
      order.push("pq");
      return Promise.resolve();
    }),
  ]);
  assertEquals(order, ["qp", "pq"]);
  assertEquals(locks.size, 0);
});

Deno.test("PartitionLocks.hold: a caller holding a key runs under it instead of queueing behind itself", async () => {
  const locks = new PartitionLocks();
  const ran = await locks.hold(
    ["p"],
    (held) =>
      locks.hold(["p", "q"], (inner) => {
        assertEquals(inner.holds("p"), true);
        assertEquals(inner.holds("q"), true);
        return Promise.resolve("inner");
      }, held),
  );
  assertEquals(ran, "inner");
  assertEquals(locks.size, 0);
});

Deno.test("PartitionLocks.hold: a token kept past its hold proves nothing", async () => {
  const locks = new PartitionLocks();
  let kept: HeldPartitionLocks | undefined;
  await locks.hold(["p"], (held) => {
    kept = held;
    return Promise.resolve();
  });
  assertEquals(kept!.holds("p"), false);
  const order: string[] = [];
  const blocker = gate();
  const blocking = locks.hold(["p"], async () => {
    await blocker.opened;
    order.push("blocker");
  });
  const passing = locks.hold(["p"], () => {
    order.push("stale");
    return Promise.resolve();
  }, kept);
  blocker.open();
  await Promise.all([blocking, passing]);
  assertEquals(order, ["blocker", "stale"]);
});

Deno.test("PartitionLocks.hold: a failing holder releases its keys", async () => {
  const locks = new PartitionLocks();
  await locks.hold(["p"], () => Promise.reject(new Error("boom"))).catch(
    () => {},
  );
  assertEquals(locks.size, 0);
  assertEquals(await locks.hold(["p"], () => Promise.resolve(1)), 1);
});

Deno.test("HeldPartitionLocks: cannot be made outside PartitionLocks", () => {
  assertThrows(
    () =>
      new HeldPartitionLocks(
        Symbol("partition-locks") as never,
        new Set(["p"]),
      ),
    Error,
    "Only PartitionLocks holds keys",
  );
});
