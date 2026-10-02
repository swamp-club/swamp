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
import {
  type LockHolderEnvStore,
  LockHolderMarker,
  MAX_LOCK_ANCESTORS,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_PID,
} from "./lock_holder_marker.ts";

/** A fake env store that never touches the real process env. */
function fakeEnv(initial: Record<string, string> = {}): {
  store: LockHolderEnvStore;
  values: Map<string, string>;
  writes: () => number;
} {
  const values = new Map(Object.entries(initial));
  let writes = 0;
  return {
    store: {
      get: (key: string) => values.get(key),
      set: (key: string, value: string) => {
        writes++;
        values.set(key, value);
      },
    },
    values,
    writes: () => writes,
  };
}

const sorted = (pids: ReadonlySet<number>): number[] =>
  [...pids].sort((a, b) => a - b);

Deno.test("LockHolderMarker.publish: a lone swamp publishes a chain of only its own pid and no holder", () => {
  const env = fakeEnv();
  new LockHolderMarker(env.store, 500).publish();

  assertEquals(env.values.get(SWAMP_LOCK_HOLDER_PID), undefined);
  assertEquals(env.values.get(SWAMP_LOCK_ANCESTOR_PIDS), "500");
});

Deno.test("LockHolderMarker.publish: appends its own pid to the inherited chain", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_HOLDER_PID]: "200",
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100,200",
  });
  new LockHolderMarker(env.store, 300).publish();

  assertEquals(env.values.get(SWAMP_LOCK_HOLDER_PID), "200");
  assertEquals(env.values.get(SWAMP_LOCK_ANCESTOR_PIDS), "100,200,300");
});

Deno.test("LockHolderMarker.publish: seeds the chain from the holder an older parent set", () => {
  const env = fakeEnv({ [SWAMP_LOCK_HOLDER_PID]: "200" });
  new LockHolderMarker(env.store, 300).publish();

  assertEquals(env.values.get(SWAMP_LOCK_ANCESTOR_PIDS), "200,300");
});

Deno.test("LockHolderMarker.publish: adds the holder an older intermediate swamp set to an inherited chain", () => {
  // A new grandparent published the chain, and an older swamp in between
  // passed it on (by plain env inheritance, not through a shell step, whose
  // allowlist in an older swamp drops the chain) and overwrote the holder.
  const env = fakeEnv({
    [SWAMP_LOCK_HOLDER_PID]: "200",
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100",
  });
  new LockHolderMarker(env.store, 300).publish();

  assertEquals(env.values.get(SWAMP_LOCK_ANCESTOR_PIDS), "100,200,300");
});

Deno.test("LockHolderMarker.publish: is idempotent and never re-captures its own values", () => {
  const env = fakeEnv({ [SWAMP_LOCK_HOLDER_PID]: "200" });
  const marker = new LockHolderMarker(env.store, 300);
  marker.publish();
  const writes = env.writes();
  marker.publish();

  assertEquals(env.writes(), writes);
  assertEquals(env.values.get(SWAMP_LOCK_ANCESTOR_PIDS), "200,300");
  assertEquals(sorted(marker.ancestorPids()), [200]);
});

Deno.test("LockHolderMarker.markHoldingLocks: sets the holder to its own pid once, leaving the chain", () => {
  const env = fakeEnv({ [SWAMP_LOCK_HOLDER_PID]: "200" });
  const marker = new LockHolderMarker(env.store, 300);
  marker.publish();
  marker.markHoldingLocks();
  const writes = env.writes();
  marker.markHoldingLocks();

  assertEquals(env.writes(), writes);
  assertEquals(env.values.get(SWAMP_LOCK_HOLDER_PID), "300");
  assertEquals(env.values.get(SWAMP_LOCK_ANCESTOR_PIDS), "200,300");
  // Its own drain still skips the holder it inherited.
  assertEquals(sorted(marker.ancestorPids()), [200]);
});

Deno.test("LockHolderMarker: a lock-free swamp in between hands the real holder to an older child", () => {
  // The grandparent took locks; the intermediate (e.g. a read-only model
  // method run) takes none, so an older child, which reads only the holder,
  // still skips the grandparent's locks.
  const grandparent = fakeEnv();
  const grandparentMarker = new LockHolderMarker(grandparent.store, 100);
  grandparentMarker.publish();
  grandparentMarker.markHoldingLocks();

  const intermediate = fakeEnv(Object.fromEntries(grandparent.values));
  new LockHolderMarker(intermediate.store, 200).publish();

  assertEquals(intermediate.values.get(SWAMP_LOCK_HOLDER_PID), "100");
  assertEquals(intermediate.values.get(SWAMP_LOCK_ANCESTOR_PIDS), "100,200");
});

Deno.test("LockHolderMarker.ancestorPids: after publishing, returns what was inherited, not its own pid", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_HOLDER_PID]: "200",
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100,200",
  });
  const marker = new LockHolderMarker(env.store, 300);
  marker.publish();

  assertEquals(sorted(marker.ancestorPids()), [100, 200]);
});

Deno.test("LockHolderMarker.ancestorPids: before publishing, reads the live values", () => {
  const env = fakeEnv();
  const marker = new LockHolderMarker(env.store, 300);
  assertEquals(sorted(marker.ancestorPids()), []);

  env.values.set(SWAMP_LOCK_HOLDER_PID, "200");
  env.values.set(SWAMP_LOCK_ANCESTOR_PIDS, "100");
  assertEquals(sorted(marker.ancestorPids()), [100, 200]);
  assertEquals(env.writes(), 0);
});

Deno.test("LockHolderMarker.ancestorPids: never includes its own pid", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_HOLDER_PID]: "300",
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100,300",
  });
  const marker = new LockHolderMarker(env.store, 300);

  assertEquals(sorted(marker.ancestorPids()), [100]);
});

Deno.test("LockHolderMarker.ancestorPids: ignores entries that are not positive integers", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_HOLDER_PID]: "abc",
    [SWAMP_LOCK_ANCESTOR_PIDS]:
      " 100 ,,0,-5,1.5,1e3,07,99999999999999999999,200",
  });
  const marker = new LockHolderMarker(env.store, 300);

  assertEquals(sorted(marker.ancestorPids()), [100, 200]);
});

Deno.test("LockHolderMarker: caps the chain at the newest MAX_LOCK_ANCESTORS entries", () => {
  const inherited = Array.from(
    { length: MAX_LOCK_ANCESTORS + 10 },
    (_, i) => i + 1,
  );
  const env = fakeEnv({ [SWAMP_LOCK_ANCESTOR_PIDS]: inherited.join(",") });
  const own = 100_000;
  const marker = new LockHolderMarker(env.store, own);

  const skipped = sorted(marker.ancestorPids());
  assertEquals(skipped.length, MAX_LOCK_ANCESTORS);
  assertEquals(skipped.at(-1), inherited.at(-1));

  marker.publish();
  const published = env.values.get(SWAMP_LOCK_ANCESTOR_PIDS)!.split(",");
  assertEquals(published.length, MAX_LOCK_ANCESTORS);
  assertEquals(published.at(-1), String(own));
});

Deno.test("LockHolderMarker.ancestorLockFilter: matches an ancestor's lock only on this host", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_HOLDER_PID]: "200",
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100,200",
  });
  const heldByAncestor = new LockHolderMarker(env.store, 300, () => "this-host")
    .ancestorLockFilter();

  assertEquals(heldByAncestor({ pid: 100, hostname: "this-host" }), true);
  assertEquals(heldByAncestor({ pid: 200, hostname: "this-host" }), true);
  assertEquals(heldByAncestor({ pid: 100, hostname: "other-host" }), false);
  assertEquals(heldByAncestor({ pid: 300, hostname: "this-host" }), false);
  assertEquals(heldByAncestor({ pid: 400, hostname: "this-host" }), false);
  assertEquals(heldByAncestor({ hostname: "this-host" }), false);
});

Deno.test("LockHolderMarker.ancestorLockFilter: a lock without a hostname matches on pid alone", () => {
  const env = fakeEnv({ [SWAMP_LOCK_ANCESTOR_PIDS]: "100" });
  const heldByAncestor = new LockHolderMarker(env.store, 300, () => "this-host")
    .ancestorLockFilter();

  assertEquals(heldByAncestor({ pid: 100 }), true);
  assertEquals(heldByAncestor({ pid: 400 }), false);
});
