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
  SWAMP_LOCK_HOLDER_TOKENS,
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

Deno.test("LockHolderMarker.lockRelation: matches an ancestor's lock only on this host", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_HOLDER_PID]: "200",
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100,200",
  });
  const relation = new LockHolderMarker(env.store, 300, () => "this-host")
    .lockRelation();

  assertEquals(relation({ pid: 100, hostname: "this-host" }), "ancestor");
  assertEquals(relation({ pid: 200, hostname: "this-host" }), "ancestor");
  assertEquals(relation({ pid: 100, hostname: "other-host" }), "other");
  assertEquals(relation({ pid: 300, hostname: "this-host" }), "other");
  assertEquals(relation({ pid: 400, hostname: "this-host" }), "other");
  assertEquals(relation({ hostname: "this-host" }), "other");
});

Deno.test("LockHolderMarker.lockRelation: a lock without a hostname matches on pid alone", () => {
  const env = fakeEnv({ [SWAMP_LOCK_ANCESTOR_PIDS]: "100" });
  const relation = new LockHolderMarker(env.store, 300, () => "this-host")
    .lockRelation();

  assertEquals(relation({ pid: 100 }), "ancestor");
  assertEquals(relation({ pid: 400 }), "other");
});

Deno.test("LockHolderMarker.lockRelation: an ancestor that listed its run's locks is held to the list", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100",
    [SWAMP_LOCK_HOLDER_TOKENS]: "100:own-a+own-b",
  });
  const relation = new LockHolderMarker(env.store, 300, () => "h")
    .lockRelation();

  assertEquals(
    relation({ pid: 100, hostname: "h", nonce: "own-a" }),
    "ancestor",
  );
  assertEquals(
    relation({ pid: 100, hostname: "h", nonce: "own-b" }),
    "ancestor",
  );
  assertEquals(
    relation({ pid: 100, hostname: "h", nonce: "sibling" }),
    "ancestor-other-run",
  );
});

Deno.test("LockHolderMarker.lockRelation: an empty entry means the ancestor holds no lock for this run", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100",
    [SWAMP_LOCK_HOLDER_TOKENS]: "100:",
  });
  const relation = new LockHolderMarker(env.store, 300, () => "h")
    .lockRelation();

  assertEquals(
    relation({ pid: 100, hostname: "h", nonce: "any" }),
    "ancestor-other-run",
  );
});

Deno.test("LockHolderMarker.lockRelation: falls back to the pid for an ancestor without an entry or a lock without a nonce", () => {
  // 100 handed down no list (an older swamp, or a spawn outside any scope);
  // 200 did, but an older-format lock file carries no nonce.
  const env = fakeEnv({
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100,200",
    [SWAMP_LOCK_HOLDER_TOKENS]: "200:own",
  });
  const relation = new LockHolderMarker(env.store, 300, () => "h")
    .lockRelation();

  assertEquals(relation({ pid: 100, hostname: "h", nonce: "x" }), "ancestor");
  assertEquals(relation({ pid: 200, hostname: "h" }), "ancestor");
});

Deno.test("LockHolderMarker.lockRelation: an entry for a pid that is not an ancestor changes nothing", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100",
    [SWAMP_LOCK_HOLDER_TOKENS]: "400:own",
  });
  const relation = new LockHolderMarker(env.store, 300, () => "h")
    .lockRelation();

  assertEquals(relation({ pid: 400, hostname: "h", nonce: "own" }), "other");
});

Deno.test("LockHolderMarker.lockRelation: ignores malformed entries and nonces", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100,200",
    [SWAMP_LOCK_HOLDER_TOKENS]: "garbage,x:a,100:ok+b@d,,200",
  });
  const relation = new LockHolderMarker(env.store, 300, () => "h")
    .lockRelation();

  assertEquals(relation({ pid: 100, hostname: "h", nonce: "ok" }), "ancestor");
  assertEquals(
    relation({ pid: 100, hostname: "h", nonce: "b@d" }),
    "ancestor-other-run",
  );
  // "200" has no separator, so 200 has no entry and falls back to the pid.
  assertEquals(relation({ pid: 200, hostname: "h", nonce: "x" }), "ancestor");
});

Deno.test("LockHolderMarker.lockRelation: after publishing, uses what was inherited, not later env writes", () => {
  const env = fakeEnv({
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100",
    [SWAMP_LOCK_HOLDER_TOKENS]: "100:own",
  });
  const marker = new LockHolderMarker(env.store, 300, () => "h");
  marker.publish();
  env.values.set(SWAMP_LOCK_HOLDER_TOKENS, "100:other");

  assertEquals(
    marker.lockRelation()({ pid: 100, hostname: "h", nonce: "own" }),
    "ancestor",
  );
});

Deno.test("LockHolderMarker.childLockEnv: outside any scope, hands down only what was inherited", () => {
  assertEquals(new LockHolderMarker(fakeEnv().store, 300).childLockEnv(), {});

  const env = fakeEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: "100:a" });
  assertEquals(new LockHolderMarker(env.store, 300).childLockEnv(), {
    [SWAMP_LOCK_HOLDER_TOKENS]: "100:a",
  });
});

Deno.test("LockHolderMarker.childLockEnv: inside a scope, adds its own pid's held locks after the inherited ones", async () => {
  const env = fakeEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: "100:a" });
  const marker = new LockHolderMarker(env.store, 300);
  marker.publish();

  const childEnv = await marker.runHolding(
    ["n1", "n2"],
    () => Promise.resolve(marker.childLockEnv()),
  );

  assertEquals(childEnv, { [SWAMP_LOCK_HOLDER_TOKENS]: "100:a,300:n1+n2" });
  // The scope never reaches the process env.
  assertEquals(env.values.get(SWAMP_LOCK_HOLDER_TOKENS), "100:a");
});

Deno.test("LockHolderMarker.childLockEnv: a scope holding no lock hands down an empty entry", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 300);

  const childEnv = await marker.runHolding(
    [],
    () => Promise.resolve(marker.childLockEnv()),
  );

  assertEquals(childEnv, { [SWAMP_LOCK_HOLDER_TOKENS]: "300:" });
});

Deno.test("LockHolderMarker.runHolding: nested scopes hold the outer scopes' locks too", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 300);

  const childEnv = await marker.runHolding(
    ["outer"],
    () =>
      marker.runHolding(
        ["inner", "outer"],
        () => Promise.resolve(marker.childLockEnv()),
      ),
  );

  assertEquals(childEnv, { [SWAMP_LOCK_HOLDER_TOKENS]: "300:outer+inner" });
});

Deno.test("LockHolderMarker.runHolding: concurrent scopes never see each other's locks", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 300);
  let releaseA!: () => void;
  const aWaiting = new Promise<void>((resolve) => releaseA = resolve);

  const [a, b] = await Promise.all([
    marker.runHolding(["a"], async () => {
      await aWaiting;
      return marker.childLockEnv();
    }),
    marker.runHolding(["b"], () => {
      releaseA();
      return Promise.resolve(marker.childLockEnv());
    }),
  ]);

  assertEquals(a, { [SWAMP_LOCK_HOLDER_TOKENS]: "300:a" });
  assertEquals(b, { [SWAMP_LOCK_HOLDER_TOKENS]: "300:b" });
});

Deno.test("LockHolderMarker.childLockEnv: a child's drain skips its run's lock and waits on a sibling run's", async () => {
  const parentEnv = fakeEnv({ [SWAMP_LOCK_ANCESTOR_PIDS]: "100" });
  const parent = new LockHolderMarker(parentEnv.store, 200, () => "h");
  parent.publish();

  const childEnv = await parent.runHolding(
    ["run-a"],
    () => Promise.resolve(parent.childLockEnv()),
  );
  const child = new LockHolderMarker(
    fakeEnv({
      [SWAMP_LOCK_ANCESTOR_PIDS]: parentEnv.values.get(
        SWAMP_LOCK_ANCESTOR_PIDS,
      )!,
      ...childEnv,
    }).store,
    300,
    () => "h",
  );
  const relation = child.lockRelation();

  assertEquals(
    relation({ pid: 200, hostname: "h", nonce: "run-a" }),
    "ancestor",
  );
  assertEquals(
    relation({ pid: 200, hostname: "h", nonce: "run-b" }),
    "ancestor-other-run",
  );
  // The grandparent handed down no list, so its locks match on the pid.
  assertEquals(relation({ pid: 100, hostname: "h", nonce: "x" }), "ancestor");
});

Deno.test("LockHolderMarker.childLockEnv: keeps the newest MAX_LOCK_ANCESTORS entries", async () => {
  const inherited = Array.from(
    { length: MAX_LOCK_ANCESTORS + 5 },
    (_, i) => `${i + 1}:n${i + 1}`,
  ).join(",");
  const marker = new LockHolderMarker(
    fakeEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: inherited }).store,
    99_999,
  );

  const childEnv = await marker.runHolding(
    ["own"],
    () => Promise.resolve(marker.childLockEnv()),
  );
  const entries = childEnv[SWAMP_LOCK_HOLDER_TOKENS].split(",");

  assertEquals(entries.length, MAX_LOCK_ANCESTORS);
  assertEquals(entries.at(-1), "99999:own");
  assertEquals(entries[0], "7:n7");
});
