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
  type LentLocks,
  type LockHolderEnvStore,
  LockHolderMarker,
  MAX_FORWARDED_LOCK_TOKENS_LENGTH,
  MAX_LOCK_ANCESTORS,
  MAX_LOCK_NONCE_LENGTH,
  SWAMP_LOCK_ANCESTOR_PIDS,
  SWAMP_LOCK_HOLDER_PID,
  SWAMP_LOCK_HOLDER_TOKENS,
  withRemoteLockHolder,
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

Deno.test("LockHolderMarker.lockRelation: a handed-down nonce is skipped whichever pid and host hold it (swamp-club#3096)", () => {
  // 400 is not above this process: its lock came over a worker dispatch or
  // a --server request.
  const env = fakeEnv({
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100",
    [SWAMP_LOCK_HOLDER_TOKENS]: "400:own",
  });
  const relation = new LockHolderMarker(env.store, 300, () => "h")
    .lockRelation();

  assertEquals(relation({ pid: 400, hostname: "h", nonce: "own" }), "ancestor");
  assertEquals(
    relation({ pid: 400, hostname: "other-host", nonce: "own" }),
    "ancestor",
  );
  assertEquals(relation({ pid: 999, nonce: "own" }), "ancestor");
  assertEquals(relation({ nonce: "own" }), "ancestor");
  // The same holder's other locks are not held for this run.
  assertEquals(
    relation({ pid: 400, hostname: "h", nonce: "sibling" }),
    "other",
  );
  assertEquals(relation({ pid: 400, hostname: "h" }), "other");
});

Deno.test("LockHolderMarker.lockRelation: an ancestor's lock listed under another pid is still this run's (swamp-club#3096)", () => {
  // Serve (100) adopted the nonce of a lock it holds itself from a client
  // list that named it under the client's parent.
  const env = fakeEnv({
    [SWAMP_LOCK_ANCESTOR_PIDS]: "100",
    [SWAMP_LOCK_HOLDER_TOKENS]: "100:own,400:adopted",
  });
  const relation = new LockHolderMarker(env.store, 300, () => "h")
    .lockRelation();

  assertEquals(
    relation({ pid: 100, hostname: "h", nonce: "adopted" }),
    "ancestor",
  );
  assertEquals(
    relation({ pid: 100, hostname: "h", nonce: "sibling" }),
    "ancestor-other-run",
  );
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

Deno.test("LockHolderMarker.inheritedLockIds: every lock handed down, whichever pid its entry names", () => {
  const marker = new LockHolderMarker(
    fakeEnv({
      [SWAMP_LOCK_ANCESTOR_PIDS]: "100,200",
      [SWAMP_LOCK_HOLDER_TOKENS]: "100:run-a+run-b,200:run-c,300:run-d",
    }).store,
    500,
  );

  assertEquals(
    [...marker.inheritedLockIds()].sort(),
    ["run-a", "run-b", "run-c", "run-d"],
  );
});

Deno.test("LockHolderMarker.inheritedLockIds: empty when the ancestors handed down no lock list", () => {
  const marker = new LockHolderMarker(
    fakeEnv({ [SWAMP_LOCK_ANCESTOR_PIDS]: "100" }).store,
    500,
  );

  assertEquals(marker.inheritedLockIds().size, 0);
});

Deno.test("LockHolderMarker.remoteLockHolder: names this process and the locks its scope holds", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500, () => "host-a");

  const holder = await marker.runHolding(
    ["nonce-a", "nonce-b"],
    () => Promise.resolve(marker.remoteLockHolder()),
  );

  assertEquals(holder, {
    pid: 500,
    hostname: "host-a",
    lockIds: ["nonce-a", "nonce-b"],
  });
});

Deno.test("LockHolderMarker.remoteLockHolder: also names the locks handed down to this process (swamp-club#3096)", async () => {
  const marker = new LockHolderMarker(
    fakeEnv({
      [SWAMP_LOCK_ANCESTOR_PIDS]: "100",
      // An entry under its own pid is a lock handed down from a swamp on
      // another host with the same pid.
      [SWAMP_LOCK_HOLDER_TOKENS]: "100:up-a+up-b,400:up-c,500:up-d",
    }).store,
    500,
    () => "host-a",
  );

  assertEquals(marker.remoteLockHolder(), {
    pid: 500,
    hostname: "host-a",
    lockIds: ["up-a", "up-b", "up-c", "up-d"],
  });
  assertEquals(
    await marker.runHolding(
      ["nonce-a", "up-a"],
      () => Promise.resolve(marker.remoteLockHolder()?.lockIds),
    ),
    ["up-a", "up-b", "up-c", "up-d", "nonce-a"],
  );
});

Deno.test("LockHolderMarker.childLockEnv: keeps the locks handed down under its own pid (swamp-club#3096)", async () => {
  // A dispatch runner whose pid equals its orchestrator's on another host.
  const runner = new LockHolderMarker(
    fakeEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: "100:up-a,500:remote" }).store,
    500,
  );

  assertEquals(runner.childLockEnv(), {
    [SWAMP_LOCK_HOLDER_TOKENS]: "100:up-a,500:remote",
  });
  assertEquals(
    await runner.runHolding(
      ["own"],
      () => Promise.resolve(runner.childLockEnv()),
    ),
    { [SWAMP_LOCK_HOLDER_TOKENS]: "100:up-a,500:remote+own" },
  );
});

Deno.test("LockHolderMarker.remoteLockHolder: undefined outside a scope and in a scope holding no lock", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500, () => "host-a");

  assertEquals(marker.remoteLockHolder(), undefined);
  assertEquals(
    await marker.runHolding(
      [],
      () => Promise.resolve(marker.remoteLockHolder()),
    ),
    undefined,
  );
});

Deno.test("withRemoteLockHolder: declares a same-host orchestrator an ancestor holding only its listed locks", () => {
  const env = withRemoteLockHolder(
    { [SWAMP_LOCK_ANCESTOR_PIDS]: "700", OTHER: "kept" },
    { pid: 500, hostname: "host-a", lockIds: ["nonce-a"] },
    "host-a",
  );

  assertEquals(env, {
    [SWAMP_LOCK_ANCESTOR_PIDS]: "500,700",
    [SWAMP_LOCK_HOLDER_TOKENS]: "500:nonce-a",
    OTHER: "kept",
  });

  // A swamp started under the runner skips that lock and waits on the
  // orchestrator's others.
  const child = new LockHolderMarker(fakeEnv(env).store, 900, () => "host-a");
  const relationTo = child.lockRelation();
  assertEquals(
    relationTo({ pid: 500, hostname: "host-a", nonce: "nonce-a" }),
    "ancestor",
  );
  assertEquals(
    relationTo({ pid: 500, hostname: "host-a", nonce: "nonce-b" }),
    "ancestor-other-run",
  );
});

Deno.test("withRemoteLockHolder: hands down the locks of an orchestrator on another host without declaring it an ancestor (swamp-club#3096)", () => {
  const base = { [SWAMP_LOCK_ANCESTOR_PIDS]: "700", OTHER: "kept" };
  const env = withRemoteLockHolder(
    base,
    { pid: 500, hostname: "host-b", lockIds: ["nonce-a"] },
    "host-a",
  );

  assertEquals(env, {
    [SWAMP_LOCK_ANCESTOR_PIDS]: "700",
    [SWAMP_LOCK_HOLDER_TOKENS]: "500:nonce-a",
    OTHER: "kept",
  });

  // A swamp started under the runner skips that lock and waits on every
  // other lock the orchestrator holds, and on a local process with its pid.
  const child = new LockHolderMarker(fakeEnv(env).store, 900, () => "host-a");
  const relationTo = child.lockRelation();
  assertEquals(
    relationTo({ pid: 500, hostname: "host-b", nonce: "nonce-a" }),
    "ancestor",
  );
  assertEquals(
    relationTo({ pid: 500, hostname: "host-b", nonce: "nonce-b" }),
    "other",
  );
  assertEquals(
    relationTo({ pid: 500, hostname: "host-a", nonce: "nonce-b" }),
    "other",
  );
  assertEquals(withRemoteLockHolder(base, undefined, "host-a"), base);
});

Deno.test("withRemoteLockHolder: merges into the chain and tokens the worker inherited", () => {
  const env = withRemoteLockHolder(
    {
      [SWAMP_LOCK_ANCESTOR_PIDS]: "500,700",
      [SWAMP_LOCK_HOLDER_TOKENS]: "500:nonce-a,600:nonce-z",
    },
    { pid: 500, hostname: "host-a", lockIds: ["nonce-b"] },
    "host-a",
  );

  assertEquals(env[SWAMP_LOCK_ANCESTOR_PIDS], "500,700");
  assertEquals(
    env[SWAMP_LOCK_HOLDER_TOKENS],
    "600:nonce-z,500:nonce-a+nonce-b",
  );
});

Deno.test("withRemoteLockHolder: drops malformed nonces and never adds the pid without a tokens entry", () => {
  const base = { [SWAMP_LOCK_ANCESTOR_PIDS]: "700" };
  const holder = { hostname: "host-a" };

  assertEquals(
    withRemoteLockHolder(
      base,
      { ...holder, pid: 500, lockIds: ["ok", "a,1:b", "c+d", ""] },
      "host-a",
    )[SWAMP_LOCK_HOLDER_TOKENS],
    "500:ok",
  );
  // No usable nonce, or no usable pid: nothing is handed over.
  for (
    const bad of [
      { ...holder, pid: 500, lockIds: ["a,1:b"] },
      { ...holder, pid: 500, lockIds: [] },
      { ...holder, pid: 0, lockIds: ["ok"] },
      { ...holder, pid: -3, lockIds: ["ok"] },
      { ...holder, pid: 1.5, lockIds: ["ok"] },
      { ...holder, pid: Number.NaN, lockIds: ["ok"] },
    ]
  ) {
    assertEquals(withRemoteLockHolder(base, bad, "host-a"), base);
  }
});

Deno.test("withRemoteLockHolder: a full chain still names the orchestrator in the runner's env", () => {
  const full = Array.from({ length: MAX_LOCK_ANCESTORS }, (_, i) => 1000 + i);
  const env = withRemoteLockHolder(
    { [SWAMP_LOCK_ANCESTOR_PIDS]: full.join(",") },
    { pid: 500, hostname: "host-a", lockIds: ["nonce-a"] },
    "host-a",
  );

  const chain = env[SWAMP_LOCK_ANCESTOR_PIDS].split(",").map(Number);
  assertEquals(chain.length, MAX_LOCK_ANCESTORS);
  assertEquals(chain[0], 500);
  assertEquals(chain.at(-1), full.at(-1));
});

Deno.test("LockHolderMarker.forwardedLockTokens: sends what a child would inherit, or nothing", async () => {
  assertEquals(
    new LockHolderMarker(fakeEnv().store, 300).forwardedLockTokens(),
    undefined,
  );

  const marker = new LockHolderMarker(
    fakeEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: "100:a" }).store,
    300,
  );
  assertEquals(marker.forwardedLockTokens(), "100:a");
  assertEquals(
    await marker.runHolding(
      ["n1"],
      () => Promise.resolve(marker.forwardedLockTokens()),
    ),
    "100:a,300:n1",
  );
});

Deno.test("LockHolderMarker.forwardedLockTokens: sends a list at the length limit and none over it", () => {
  // Distinct nonces, the last padded so the list is exactly `length` long.
  const listOf = (length: number) => {
    let list = "100:n0";
    for (let i = 1; list.length + 16 < length; i++) list += `+n${i}`;
    return list + "+" + "a".repeat(length - list.length - 1);
  };
  const forwarded = (value: string) =>
    new LockHolderMarker(
      fakeEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: value }).store,
      300,
    ).forwardedLockTokens();

  const atLimit = listOf(MAX_FORWARDED_LOCK_TOKENS_LENGTH);
  assertEquals(forwarded(atLimit), atLimit);
  assertEquals(
    forwarded(listOf(MAX_FORWARDED_LOCK_TOKENS_LENGTH + 1)),
    undefined,
  );
});

/** What a child started inside `marker`'s current scope would inherit. */
const childTokens = (marker: LockHolderMarker): string | undefined =>
  marker.childLockEnv()[SWAMP_LOCK_HOLDER_TOKENS];

Deno.test("LockHolderMarker.runAdopting: a run adopts the forwarded locks and holds its own too", async () => {
  const server = new LockHolderMarker(fakeEnv().store, 300);

  const tokens = await server.runHolding(["a"], () =>
    // Run B, requested by a client under run A, holding its own lock.
    server.runAdopting("300:a", () =>
      server.runHolding(["b"], () => Promise.resolve(childTokens(server)))));

  assertEquals(tokens, "300:a+b");
});

/** What a child of a request handler adopting `forwarded` would inherit. */
const adopted = (
  server: LockHolderMarker,
  forwarded: string | undefined,
): Promise<string | undefined> =>
  server.runAdopting(forwarded, () => Promise.resolve(childTokens(server)));

Deno.test("LockHolderMarker.runAdopting: opens no scope without a usable lock", async () => {
  const server = new LockHolderMarker(fakeEnv().store, 300);

  assertEquals(await adopted(server, undefined), undefined);
  assertEquals(await adopted(server, ""), undefined);
  assertEquals(await adopted(server, "not a list"), undefined);
  assertEquals(await adopted(server, "300:"), undefined);
  assertEquals(await adopted(server, "100:b@d"), undefined);
  // Longer than a worker accepts in a dispatch, so never taken up.
  assertEquals(
    await adopted(server, `100:${"a".repeat(MAX_LOCK_NONCE_LENGTH + 1)}`),
    undefined,
  );
  assertEquals(
    await adopted(server, `100:${"a".repeat(MAX_LOCK_NONCE_LENGTH)}`),
    `300:${"a".repeat(MAX_LOCK_NONCE_LENGTH)}`,
  );
  assertEquals(
    await adopted(
      server,
      `300:${"a+".repeat(MAX_FORWARDED_LOCK_TOKENS_LENGTH)}a`,
    ),
    undefined,
  );
});

Deno.test("LockHolderMarker.runAdopting: adopts every nonce the list names, whichever pid holds it (swamp-club#3096)", async () => {
  // Serve holds none of these: the holders are a local run between the
  // calling step and the client, and a swamp on another host.
  const server = new LockHolderMarker(fakeEnv().store, 300);

  assertEquals(await adopted(server, "100:a"), "300:a");
  assertEquals(await adopted(server, "100:a+b,200:c,300:d"), "300:a+b+c+d");
  assertEquals(await adopted(server, "100:a+b@d,garbage,200:c"), "300:a+c");
});

Deno.test("LockHolderMarker.runAdopting: a dispatch from an adopting run carries the adopted locks (swamp-club#3096)", async () => {
  const server = new LockHolderMarker(fakeEnv().store, 300, () => "host-a");

  const holder = await server.runAdopting(
    "100:a",
    () =>
      server.runHolding(
        ["b"],
        () => Promise.resolve(server.remoteLockHolder()),
      ),
  );

  assertEquals(holder, { pid: 300, hostname: "host-a", lockIds: ["a", "b"] });
});

/**
 * Locks a run took, as a scope lends them: `reclaim` re-keys by bumping a
 * generation, and records each call in `log`.
 */
function lentLocks(name: string, log: string[]): LentLocks {
  let generation = 1;
  return {
    lockIds: () => [`${name}-${generation}`],
    reclaim: () => {
      log.push(`reclaim ${name}-${generation}`);
      generation++;
      return Promise.resolve();
    },
  };
}

Deno.test("LockHolderMarker.beginChildHandOff: lends the scope's locks and reclaims them when the hop ends (swamp-club#3111)", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500);
  const log: string[] = [];

  await marker.runHolding(lentLocks("a", log), async () => {
    const first = await marker.beginChildHandOff();
    assertEquals(first.lent, { [SWAMP_LOCK_HOLDER_TOKENS]: "500:a-1" });
    assertEquals(log, []);
    await first.end();
    assertEquals(log, ["reclaim a-1"]);

    // The next hop is lent the re-keyed lock.
    const second = await marker.beginChildHandOff();
    assertEquals(second.lent, { [SWAMP_LOCK_HOLDER_TOKENS]: "500:a-2" });
    assertEquals(marker.childLockEnv(), second.lent);
    await second.end();
    // Ending twice reclaims once.
    await second.end();
  });

  assertEquals(log, ["reclaim a-1", "reclaim a-2"]);
});

Deno.test("LockHolderMarker.beginChildHandOff: a lock is not reclaimed under a sibling hop that still skips it", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500);
  const log: string[] = [];

  await marker.runHolding(lentLocks("a", log), async () => {
    const one = await marker.beginChildHandOff();
    const two = await marker.beginChildHandOff();
    await one.end();
    assertEquals(log, []);
    await two.end();
    assertEquals(log, ["reclaim a-1"]);
  });
});

Deno.test("LockHolderMarker.beginChildHandOff: a nested scope's hop counts against the scopes around it, and each reclaims its own lock", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500);
  const log: string[] = [];

  await marker.runHolding(lentLocks("outer", log), async () => {
    const outerHop = await marker.beginChildHandOff();
    await marker.runHolding(lentLocks("inner", log), async () => {
      const innerHop = await marker.beginChildHandOff();
      assertEquals(innerHop.lent, {
        [SWAMP_LOCK_HOLDER_TOKENS]: "500:outer-1+inner-1",
      });
      await innerHop.end();
      // The outer scope still has a live hop, so only the inner reclaims.
      assertEquals(log, ["reclaim inner-1"]);
    });
    await outerHop.end();
    assertEquals(log, ["reclaim inner-1", "reclaim outer-1"]);
  });
});

Deno.test("LockHolderMarker.beginChildHandOff: the signal an end is given reaches its own scope's reclaim, not a scope around it (swamp-club#3157)", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500);
  const signals: Record<string, AbortSignal | undefined> = {};
  const recording = (name: string): LentLocks => ({
    lockIds: () => [name],
    reclaim: (signal) => {
      signals[name] = signal;
      return Promise.resolve();
    },
  });
  const signal = new AbortController().signal;

  await marker.runHolding(recording("outer"), async () => {
    await marker.runHolding(recording("inner"), async () => {
      const hop = await marker.beginChildHandOff();
      // The last hop of both scopes: one end reclaims both.
      await hop.end(signal);
    });
  });

  assertEquals(Object.keys(signals).sort(), ["inner", "outer"]);
  assertEquals(signals.inner, signal);
  assertEquals(signals.outer, undefined);
});

Deno.test("LockHolderMarker.beginChildHandOff: adopted, listed and inherited nonces are lent but never reclaimed", async () => {
  const env = fakeEnv({ [SWAMP_LOCK_HOLDER_TOKENS]: "100:up-a" });
  const marker = new LockHolderMarker(env.store, 500);
  marker.publish();

  await marker.runAdopting(
    "200:adopted-a",
    () =>
      marker.runHolding(["listed-a"], async () => {
        const hop = await marker.beginChildHandOff();
        assertEquals(hop.lent, {
          [SWAMP_LOCK_HOLDER_TOKENS]: "100:up-a,500:adopted-a+listed-a",
        });
        await hop.end();
      }),
  );

  // Outside any scope there is nothing to count or reclaim.
  const hop = await marker.beginChildHandOff();
  assertEquals(hop.lent, { [SWAMP_LOCK_HOLDER_TOKENS]: "100:up-a" });
  await hop.end();
});

Deno.test("LockHolderMarker.beginChildHandOff: a hop begun during a reclaim waits for it and is lent the new nonce", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500);
  let generation = 1;
  const reclaimed = Promise.withResolvers<void>();
  const locks: LentLocks = {
    lockIds: () => [`a-${generation}`],
    reclaim: async () => {
      await reclaimed.promise;
      generation++;
    },
  };

  await marker.runHolding(locks, async () => {
    const first = await marker.beginChildHandOff();
    const ending = first.end();
    let begun = false;
    const next = marker.beginChildHandOff().then((hop) => {
      begun = true;
      return hop;
    });
    // Let the pending begin run as far as it can.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assertEquals(begun, false);

    reclaimed.resolve();
    await ending;
    const hop = await next;
    assertEquals(hop.lent, { [SWAMP_LOCK_HOLDER_TOKENS]: "500:a-2" });
    await hop.end();
  });
});

Deno.test("LockHolderMarker.beginChildHandOff: a failed reclaim fails the hop's end and any hop waiting to begin", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500);
  const failure = new Error("structural command still working");
  const reclaiming = Promise.withResolvers<void>();
  const locks: LentLocks = {
    lockIds: () => ["a-1"],
    reclaim: () => reclaiming.promise,
  };

  await marker.runHolding(locks, async () => {
    const first = await marker.beginChildHandOff();
    const ending = first.end();
    const next = marker.beginChildHandOff();
    reclaiming.reject(failure);

    assertEquals(await ending.catch((error) => error), failure);
    assertEquals(await next.catch((error) => error), failure);
  });
});

Deno.test("LockHolderMarker.remoteHandOff: is bound to the scope it was built in, wherever an attempt begins", async () => {
  const marker = new LockHolderMarker(fakeEnv().store, 500, () => "host-a");
  const log: string[] = [];

  const source = await marker.runHolding(
    lentLocks("a", log),
    () => Promise.resolve(marker.remoteHandOff()),
  );

  // Begun outside the scope, as a dispatcher resuming from its queue does.
  assertEquals(source.holder()?.lockIds, ["a-1"]);
  const first = await source.begin();
  assertEquals(first.lent, { pid: 500, hostname: "host-a", lockIds: ["a-1"] });
  await first.end();
  assertEquals(log, ["reclaim a-1"]);

  // A retry is its own hand-off and carries the re-keyed lock.
  const retry = await source.begin();
  assertEquals(retry.lent?.lockIds, ["a-2"]);
  await retry.end();

  // A dispatch made outside any scope lends nothing.
  const none = await marker.remoteHandOff().begin();
  assertEquals(none.lent, undefined);
  await none.end();
});
