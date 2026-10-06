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

// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import type { ControlPlaneStore } from "./datastore_types.ts";

/** Options for {@link assertControlPlaneStoreConformance}. */
export interface ControlPlaneStoreConformanceOptions {
  /**
   * How many creates of one key are raced against each other. Default: 8.
   */
  concurrency?: number;
  /**
   * Set to false for a store that does not implement `putIfAbsent`. Only the
   * other operations are then checked, and the store cannot hold the records
   * of workflow signal waits. Default: true.
   */
  requirePutIfAbsent?: boolean;
}

/** A store with the atomic create. */
type AtomicStore =
  & ControlPlaneStore
  & Required<Pick<ControlPlaneStore, "putIfAbsent">>;

const encode = (text: string) => new TextEncoder().encode(text);

async function text(
  store: ControlPlaneStore,
  key: string,
): Promise<string | null> {
  const bytes = await store.get(key);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/**
 * Checks a `ControlPlaneStore` against the contract swamp relies on.
 *
 * `openStore` is called more than once and must return handles onto the
 * same records each time, as two swamp processes on one datastore get. The
 * suite writes only under a key prefix of its own and removes what it
 * wrote.
 *
 * Checked: `get` of a missing key, `put` round-trip and overwrite, `delete`
 * and its idempotence, `list` by prefix, visibility of one handle's writes
 * to another, and, unless `requirePutIfAbsent` is false, the atomic create:
 * it creates once, never overwrites, is readable in full straight after,
 * can be repeated after a delete, and of concurrent creates of one key
 * exactly one wins.
 *
 * ```ts
 * import { assertControlPlaneStoreConformance } from "@swamp-club/swamp-testing";
 *
 * Deno.test("control-plane store conformance", async () => {
 *   await assertControlPlaneStoreConformance(() =>
 *     createSyncService().controlPlaneStore()
 *   );
 * });
 * ```
 */
export async function assertControlPlaneStoreConformance(
  openStore: () => ControlPlaneStore | Promise<ControlPlaneStore>,
  options: ControlPlaneStoreConformanceOptions = {},
): Promise<void> {
  const store = await openStore();
  const other = await openStore();
  const root = `conformance-${crypto.randomUUID()}`;
  const key = (name: string) => `${root}/${name}`;
  const written = new Set<string>();
  const track = (name: string) => {
    written.add(key(name));
    return key(name);
  };

  try {
    // get of a missing key
    assertEquals(
      await store.get(key("missing")),
      null,
      "get must return null for a key that holds no record",
    );

    // put round-trip and overwrite
    await store.put(track("plain"), encode("one"));
    assertEquals(await text(store, key("plain")), "one", "put then get");
    await store.put(key("plain"), encode("two"));
    assertEquals(
      await text(store, key("plain")),
      "two",
      "put must replace an existing record",
    );
    assertEquals(
      await text(other, key("plain")),
      "two",
      "a second handle must see the first handle's write at once",
    );

    // An empty record is a record, not an absent key.
    await store.put(track("empty"), new Uint8Array());
    assertEquals(
      (await store.get(key("empty")))?.length,
      0,
      "an empty record must read back as empty, not as null",
    );

    // list by prefix
    await store.put(track("list/a"), encode("a"));
    await store.put(track("list/nested/b"), encode("b"));
    await store.put(track("listing"), encode("sibling"));
    assertEquals(
      (await store.list(`${root}/list/`)).sort(),
      [key("list/a"), key("list/nested/b")],
      "list must return every key under the prefix in full, and no sibling whose name only starts the same",
    );
    assertEquals(
      await store.list(`${root}/nothing/`),
      [],
      "list of a prefix with no keys must return an empty array",
    );

    // delete and its idempotence
    await store.delete(key("plain"));
    assertEquals(await store.get(key("plain")), null, "delete then get");
    await store.delete(key("plain"));
    await store.delete(key("never-written"));
    assert(
      !(await store.list(`${root}/`)).includes(key("plain")),
      "a deleted key must not be listed",
    );

    if (options.requirePutIfAbsent === false) return;
    assert(
      typeof store.putIfAbsent === "function",
      "the store must implement putIfAbsent (pass requirePutIfAbsent: false to check a store without it)",
    );
    const atomic = store as AtomicStore;
    const otherAtomic = other as AtomicStore;

    // creates once, readable in full straight after
    const large = "x".repeat(64 * 1024);
    assertEquals(
      await atomic.putIfAbsent(track("once"), encode(large)),
      true,
      "putIfAbsent on a key that holds no record must return true",
    );
    assertEquals(
      await text(other, key("once")),
      large,
      "a record must be readable in full, from any handle, as soon as its create returns",
    );

    // never overwrites, from either handle
    assertEquals(
      await atomic.putIfAbsent(key("once"), encode("second")),
      false,
      "putIfAbsent on a key that holds a record must return false",
    );
    assertEquals(
      await otherAtomic.putIfAbsent(key("once"), encode("third")),
      false,
      "putIfAbsent must see a record another handle created",
    );
    assertEquals(
      await text(store, key("once")),
      large,
      "a refused putIfAbsent must leave the record unchanged",
    );

    // a key written by put is taken too
    await store.put(track("taken"), encode("put"));
    assertEquals(
      await atomic.putIfAbsent(key("taken"), encode("create")),
      false,
      "putIfAbsent must not replace a record written by put",
    );
    assertEquals(await text(store, key("taken")), "put");

    // repeatable after a delete
    await store.delete(key("once"));
    assertEquals(
      await atomic.putIfAbsent(key("once"), encode("again")),
      true,
      "putIfAbsent must succeed again once the record was deleted",
    );
    assertEquals(await text(store, key("once")), "again");

    // of concurrent creates of one key exactly one wins
    const racers = options.concurrency ?? 8;
    track("race");
    const results = await Promise.all(
      Array.from({ length: racers }, async (_, i) => {
        const handle = await openStore() as AtomicStore;
        return await handle.putIfAbsent(key("race"), encode(`racer-${i}`));
      }),
    );
    const winners = results.flatMap((won, i) => won ? [i] : []);
    assertEquals(
      winners.length,
      1,
      `of ${racers} concurrent putIfAbsent calls on one key exactly one must return true, got ${winners.length}`,
    );
    assertEquals(
      await text(store, key("race")),
      `racer-${winners[0]}`,
      "the stored record must be the winner's, in full",
    );
  } finally {
    for (const k of written) {
      try {
        await store.delete(k);
      } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * A {@link ControlPlaneStore} held in memory, with `putIfAbsent`. For tests
 * of code that reads and writes control-plane records.
 */
export function createInMemoryControlPlaneStore(): AtomicStore {
  const records = new Map<string, Uint8Array>();
  return {
    put: (key, data) => {
      records.set(key, data.slice());
      return Promise.resolve();
    },
    putIfAbsent: (key, data) => {
      if (records.has(key)) return Promise.resolve(false);
      records.set(key, data.slice());
      return Promise.resolve(true);
    },
    get: (key) => Promise.resolve(records.get(key)?.slice() ?? null),
    delete: (key) => {
      records.delete(key);
      return Promise.resolve();
    },
    list: (prefix) =>
      Promise.resolve(
        [...records.keys()].filter((key) => key.startsWith(prefix)).sort(),
      ),
  };
}
