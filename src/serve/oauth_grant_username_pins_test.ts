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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  createOAuthGrantUsernameResolver,
  type GrantUsernameLookup,
  type GrantUsernamePins,
  type GrantUsernamePinStore,
  OAUTH_GRANT_USERNAMES_KEY,
  parseGrantUsernamePins,
  serializeGrantUsernamePins,
  vaultGrantUsernamePinStore,
} from "./oauth_grant_username_pins.ts";
import { UsernameNotFoundError } from "./oauth_client.ts";
import type { UsernameLookup } from "../domain/access/grant_username_resolution.ts";

const PROVIDER = "https://club.example";

function memoryStore(initial?: Partial<GrantUsernamePins>) {
  let pins: GrantUsernamePins = {
    pinned: { ...initial?.pinned },
    missing: { ...initial?.missing },
  };
  let writes = 0;
  const store: GrantUsernamePinStore = {
    read: () =>
      Promise.resolve({
        pinned: { ...pins.pinned },
        missing: { ...pins.missing },
      }),
    write: (next) => {
      writes++;
      pins = { pinned: { ...next.pinned }, missing: { ...next.missing } };
      return Promise.resolve();
    },
  };
  return {
    store,
    get pins() {
      return pins;
    },
    set pins(next: GrantUsernamePins) {
      pins = next;
    },
    get writes() {
      return writes;
    },
  };
}

/** A provider lookup answering from a mutable table, recording names asked. */
function provider(table: Record<string, string>) {
  const asked: string[] = [];
  const lookup: GrantUsernameLookup = (username) => {
    asked.push(username);
    if (Object.hasOwn(table, username)) return Promise.resolve(table[username]);
    return Promise.reject(new UsernameNotFoundError(username, PROVIDER));
  };
  return { lookup, asked, table };
}

function resolverOver(
  store: GrantUsernamePinStore,
  lookup: GrantUsernameLookup | null,
  extra: Partial<Parameters<typeof createOAuthGrantUsernameResolver>[0]> = {},
) {
  return createOAuthGrantUsernameResolver({
    store,
    providerUrl: PROVIDER,
    lookup: () => lookup,
    noLookupMessage: "no credential",
    now: () => "2026-10-13T00:00:00.000Z",
    ...extra,
  });
}

function status(answers: ReadonlyMap<string, UsernameLookup>, name: string) {
  return answers.get(name);
}

Deno.test("grant username pins: a new name is looked up and pinned", async () => {
  const mem = memoryStore();
  const p = provider({ alice: "sub-alice" });
  const answers = await resolverOver(mem.store, p.lookup).resolve({
    names: ["alice"],
    complete: true,
  });
  assertEquals(status(answers, "alice"), {
    status: "resolved",
    sub: "sub-alice",
  });
  assertEquals({ ...mem.pins.pinned }, { alice: "sub-alice" });
});

Deno.test("grant username pins: a pinned name is never looked up again, so it is never re-pointed", async () => {
  const mem = memoryStore({ pinned: { alice: "sub-original" } });
  // The name now belongs to someone else on the provider.
  const p = provider({ alice: "sub-new-owner" });
  const resolver = resolverOver(mem.store, p.lookup);
  // A new name alongside makes the resolve look things up at all.
  const answers = await resolver.resolve({
    names: ["alice", "bob"],
    complete: true,
  });
  assertEquals(status(answers, "alice"), {
    status: "resolved",
    sub: "sub-original",
  });
  assertEquals(p.asked, ["bob"]);
  assertEquals(mem.pins.pinned.alice, "sub-original");
});

Deno.test("grant username pins: a name first seen missing is recorded and never looked up again", async () => {
  const mem = memoryStore();
  const p = provider({});
  const resolver = resolverOver(mem.store, p.lookup);
  const first = await resolver.resolve({ names: ["alcie"], complete: true });
  assertEquals(first.get("alcie")?.status, "unresolved");
  assertStringIncludes(
    (first.get("alcie") as { message: string }).message,
    `${PROVIDER}/api/auth/resolve-user`,
  );
  assertEquals({ ...mem.pins.missing }, { alcie: "2026-10-13T00:00:00.000Z" });

  // Someone registers the typo; it must still not resolve.
  p.table.alcie = "sub-attacker";
  const second = await resolver.resolve({ names: ["alcie"], complete: true });
  assertEquals(second.get("alcie")?.status, "unresolved");
  assertStringIncludes(
    (second.get("alcie") as { message: string }).message,
    "when first looked up (2026-10-13T00:00:00.000Z)",
  );
  assertEquals(p.asked, ["alcie"]);
});

Deno.test("grant username pins: a lookup failure other than not-found records nothing", async () => {
  const mem = memoryStore();
  const failing: GrantUsernameLookup = () =>
    Promise.reject(new Error("503 Service Unavailable"));
  const answers = await resolverOver(mem.store, failing).resolve({
    names: ["alice"],
    complete: true,
  });
  const answer = answers.get("alice") as { status: string; message: string };
  assertEquals(answer.status, "unresolved");
  assertStringIncludes(answer.message, "503 Service Unavailable");
  assertEquals(mem.pins, { pinned: {}, missing: {} });
  assertEquals(mem.writes, 0);
});

Deno.test("grant username pins: without a credential, new names are left unresolved and pins still answer", async () => {
  const mem = memoryStore({ pinned: { alice: "sub-alice" } });
  const answers = await resolverOver(mem.store, null).resolve({
    names: ["alice", "bob"],
    complete: true,
  });
  assertEquals(answers.get("alice"), { status: "resolved", sub: "sub-alice" });
  assertEquals(answers.get("bob"), {
    status: "unresolved",
    message: "no credential",
  });
});

Deno.test("grant username pins: records are forgotten only on a complete resolve", async () => {
  const mem = memoryStore({
    pinned: { alice: "sub-alice" },
    missing: { alcie: "2026-01-01T00:00:00.000Z" },
  });
  const resolver = resolverOver(mem.store, provider({}).lookup);
  // A source is held back: its names keep their records.
  await resolver.resolve({ names: [], complete: false });
  assertEquals({ ...mem.pins.pinned }, { alice: "sub-alice" });
  assertEquals({ ...mem.pins.missing }, { alcie: "2026-01-01T00:00:00.000Z" });

  await resolver.resolve({ names: [], complete: true });
  assertEquals(mem.pins, { pinned: {}, missing: {} });
});

Deno.test("grant username pins: a forgotten missing name is looked up afresh when added back", async () => {
  const mem = memoryStore({ missing: { carol: "2026-01-01T00:00:00.000Z" } });
  const p = provider({ carol: "sub-carol" });
  const resolver = resolverOver(mem.store, p.lookup);
  await resolver.resolve({ names: [], complete: true });
  const answers = await resolver.resolve({ names: ["carol"], complete: true });
  assertEquals(answers.get("carol"), { status: "resolved", sub: "sub-carol" });
});

Deno.test("grant username pins: a pin a peer wrote since the last resolve wins over a lookup", async () => {
  const mem = memoryStore();
  const p = provider({ alice: "sub-from-lookup" });
  const resolver = resolverOver(mem.store, p.lookup);
  await resolver.resolve({ names: [], complete: true });
  mem.pins = { pinned: { alice: "sub-from-peer" }, missing: {} };
  const answers = await resolver.resolve({ names: ["alice"], complete: true });
  assertEquals(answers.get("alice"), {
    status: "resolved",
    sub: "sub-from-peer",
  });
  assertEquals(p.asked, []);
});

Deno.test("grant username pins: more new names than the cap are all left unresolved, none looked up", async () => {
  const mem = memoryStore();
  const p = provider({ a: "1", b: "2", c: "3" });
  const answers = await resolverOver(mem.store, p.lookup, { maxNewNames: 2 })
    .resolve({ names: ["a", "b", "c"], complete: true });
  for (const name of ["a", "b", "c"]) {
    const answer = answers.get(name) as { status: string; message: string };
    assertEquals(answer.status, "unresolved");
    assertStringIncludes(answer.message, "more than the 2");
  }
  assertEquals(p.asked, []);
});

Deno.test("grant username pins: lookups run at most `concurrency` at once", async () => {
  const mem = memoryStore();
  let inFlight = 0;
  let peak = 0;
  const lookup: GrantUsernameLookup = async (name) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    await Promise.resolve();
    inFlight--;
    return `sub-${name}`;
  };
  const names = Array.from({ length: 10 }, (_, i) => `u${i}`);
  const answers = await resolverOver(mem.store, lookup, { concurrency: 3 })
    .resolve({ names, complete: true });
  assertEquals(peak, 3);
  assertEquals(answers.size, 10);
});

Deno.test("grant username pins: the deadline signal reaches every lookup", async () => {
  const mem = memoryStore();
  const signals: AbortSignal[] = [];
  const lookup: GrantUsernameLookup = (name, signal) => {
    signals.push(signal);
    return Promise.resolve(`sub-${name}`);
  };
  await resolverOver(mem.store, lookup, { deadlineMs: 1_000 }).resolve({
    names: ["a", "b"],
    complete: true,
  });
  assertEquals(signals.length, 2);
  assert(signals.every((s) => s === signals[0] && !s.aborted));
});

Deno.test("grant username pins: concurrent resolves take turns, so neither loses the other's pin", async () => {
  const mem = memoryStore();
  const p = provider({ alice: "sub-alice", bob: "sub-bob" });
  const resolver = resolverOver(mem.store, p.lookup);
  await Promise.all([
    resolver.resolve({ names: ["alice"], complete: false }),
    resolver.resolve({ names: ["bob"], complete: false }),
  ]);
  assertEquals({ ...mem.pins.pinned }, { alice: "sub-alice", bob: "sub-bob" });
});

Deno.test("grant username pins: a store read failure fails the resolve instead of reading as no pins", async () => {
  const store: GrantUsernamePinStore = {
    read: () => Promise.reject(new Error("control plane unreachable")),
    write: () => Promise.resolve(),
  };
  const p = provider({ alice: "sub-new-owner" });
  await assertRejects(
    () =>
      resolverOver(store, p.lookup).resolve({
        names: ["alice"],
        complete: true,
      }),
    Error,
    "control plane unreachable",
  );
  assertEquals(p.asked, []);
});

Deno.test("grant username pins: names like constructor are plain names", async () => {
  const mem = memoryStore();
  const p = provider({});
  const answers = await resolverOver(mem.store, p.lookup).resolve({
    names: ["constructor", "__proto__"],
    complete: true,
  });
  assertEquals(p.asked.sort(), ["__proto__", "constructor"]);
  assertEquals(answers.get("constructor")?.status, "unresolved");
});

Deno.test("vaultGrantUsernamePinStore: an absent key reads as no pins; a failed get fails", async () => {
  const values = new Map<string, string>();
  let failGet = false;
  const store = vaultGrantUsernamePinStore({
    list: () => Promise.resolve([...values.keys()]),
    get: (key) =>
      failGet
        ? Promise.reject(new Error("decrypt failed"))
        : Promise.resolve(values.get(key)!),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  });
  assertEquals(await store.read(), { pinned: {}, missing: {} });
  await store.write({ pinned: { alice: "sub-alice" }, missing: { x: "t" } });
  assert(values.has(OAUTH_GRANT_USERNAMES_KEY));
  const read = await store.read();
  assertEquals({ ...read.pinned }, { alice: "sub-alice" });
  assertEquals({ ...read.missing }, { x: "t" });
  failGet = true;
  await assertRejects(() => store.read(), Error, "decrypt failed");
});

Deno.test("parseGrantUsernamePins: round-trips and refuses other shapes", () => {
  const pins: GrantUsernamePins = { pinned: { a: "1" }, missing: { b: "t" } };
  const parsed = parseGrantUsernamePins(serializeGrantUsernamePins(pins));
  assertEquals({ ...parsed.pinned }, pins.pinned);
  assertEquals({ ...parsed.missing }, pins.missing);
  for (const bad of ["{}", "[]", '{"pinned":{"a":1},"missing":{}}', "null"]) {
    let threw = false;
    try {
      parseGrantUsernamePins(bad);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

Deno.test("grant username pins: a record a peer writes during a lookup is kept, not written over", async () => {
  const mem = memoryStore();
  // While this instance looks bob up, a peer records alcie as missing.
  const lookup: GrantUsernameLookup = (name) => {
    mem.pins = {
      pinned: { ...mem.pins.pinned },
      missing: { ...mem.pins.missing, alcie: "2026-01-01T00:00:00.000Z" },
    };
    return Promise.resolve(`sub-${name}`);
  };
  await resolverOver(mem.store, lookup).resolve({
    names: ["bob"],
    complete: false,
  });
  assertEquals({ ...mem.pins.pinned }, { bob: "sub-bob" });
  assertEquals({ ...mem.pins.missing }, { alcie: "2026-01-01T00:00:00.000Z" });
});

Deno.test("grant username pins: a pin a peer writes for the same name during the lookup wins", async () => {
  const mem = memoryStore();
  const lookup: GrantUsernameLookup = () => {
    mem.pins = { pinned: { alice: "sub-peer" }, missing: {} };
    return Promise.resolve("sub-mine");
  };
  const answers = await resolverOver(mem.store, lookup).resolve({
    names: ["alice"],
    complete: true,
  });
  assertEquals(answers.get("alice"), { status: "resolved", sub: "sub-peer" });
  assertEquals({ ...mem.pins.pinned }, { alice: "sub-peer" });
});
