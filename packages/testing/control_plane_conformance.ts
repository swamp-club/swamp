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
import { dirname, join } from "@std/path";
import type {
  ControlPlaneStore,
  DatastoreControlPlaneStore,
  DatastoreSyncService,
  WritableDatastoreControlPlaneStore,
} from "./datastore_types.ts";

export interface ControlPlaneStoreConformanceOptions {
  concurrency?: number;
  requirePutIfAbsent?: boolean;
}

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
 * openStore is called more than once and must return handles onto the same
 * records each time, as two swamp processes on one datastore get; the suite
 * writes only under its own key prefix and removes what it wrote
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
    assertEquals(
      await store.get(key("missing")),
      null,
      "get must return null for a key that holds no record",
    );

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

    await store.put(track("taken"), encode("put"));
    assertEquals(
      await atomic.putIfAbsent(key("taken"), encode("create")),
      false,
      "putIfAbsent must not replace a record written by put",
    );
    assertEquals(await text(store, key("taken")), "put");

    await store.delete(key("once"));
    assertEquals(
      await atomic.putIfAbsent(key("once"), encode("again")),
      true,
      "putIfAbsent must succeed again once the record was deleted",
    );
    assertEquals(await text(store, key("once")), "again");

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

export interface DatastoreControlPlaneStoreConformanceOptions {
  openDatastoreStore: () =>
    | DatastoreControlPlaneStore
    | Promise<DatastoreControlPlaneStore>;
  openSyncService: () => DatastoreSyncService | Promise<DatastoreSyncService>;
  /**
   * The namespace a service is bound to, by pulling with it. Default: a
   * fresh one per run. A backend that only pulls registered namespaces
   * needs one registered before the suite runs; pass its name here.
   */
  namespace?: string;
}

export async function assertDatastoreControlPlaneStoreConformance(
  options: DatastoreControlPlaneStoreConformanceOptions,
): Promise<void> {
  const namespace = options.namespace ??
    `conformance-ns-${crypto.randomUUID().slice(0, 8)}`;
  const root = `conformance-${crypto.randomUUID()}`;
  const rootKey = `${root}/datastore-wide`;
  const namespacedKey = `${root}/namespaced`;

  const rootService = await options.openSyncService();
  const namespacedService = await options.openSyncService();
  if (!rootService.controlPlaneStore || !namespacedService.controlPlaneStore) {
    throw new Error(
      "openSyncService must return services with a controlPlaneStore",
    );
  }
  const rootStore = rootService.controlPlaneStore();
  let namespacedStore: ControlPlaneStore | undefined;

  try {
    await rootStore.put(rootKey, encode("root"));
    const store = await options.openDatastoreStore();

    const read = await store.get(rootKey);
    assertEquals(
      read === null ? null : new TextDecoder().decode(read),
      "root",
      "get must read the record written at the datastore-wide root",
    );
    assertEquals(
      await store.get(`${root}/missing`),
      null,
      "get must return null for a key that holds no record",
    );

    // The datastore-wide store was used first; the service must still
    // bind its own namespace, and its records stay out of the root.
    await namespacedService.pullChanged({ namespace });
    namespacedStore = namespacedService.controlPlaneStore();
    await namespacedStore.put(namespacedKey, encode("namespaced"));
    assertEquals(
      await store.get(namespacedKey),
      null,
      "get must not see a record written only under a namespace",
    );
    const namespacedRead = await namespacedStore.get(namespacedKey);
    assertEquals(
      namespacedRead === null ? null : new TextDecoder().decode(namespacedRead),
      "namespaced",
      "a namespaced service must still read its own records after the datastore-wide store was used",
    );

    let rejected = false;
    try {
      await store.get(rootKey, { signal: AbortSignal.abort() });
    } catch {
      rejected = true;
    }
    assert(rejected, "get must reject when its signal is already aborted");
  } finally {
    try {
      await rootStore.delete(rootKey);
    } catch { /* best-effort cleanup */ }
    try {
      await namespacedStore?.delete(namespacedKey);
    } catch { /* best-effort cleanup */ }
  }
}

export interface NamespacedSyncFixture {
  service: DatastoreSyncService;
  cacheDir: string;
}

export interface WritableDatastoreControlPlaneStoreConformanceOptions {
  openDatastoreStore: () =>
    | WritableDatastoreControlPlaneStore
    | Promise<WritableDatastoreControlPlaneStore>;
  openSyncService: () => DatastoreSyncService | Promise<DatastoreSyncService>;
  /**
   * a fresh sync service with its cache directory for the namespaced-push case;
   * without it, or without markNamespaceUpgradedFromSolo, that case is skipped
   */
  openNamespacedSyncFixture?: () => Promise<NamespacedSyncFixture>;
  /**
   * puts the backend where a namespaced push moves root _control/ records into
   * the namespace, as if a solo datastore was upgraded; without it the case is
   * skipped
   */
  markNamespaceUpgradedFromSolo?: (namespace: string) => Promise<void>;
  /**
   * The namespace the suite syncs under. Default: a fresh one per run. A
   * backend that only syncs registered namespaces needs one registered
   * before the suite runs; pass its name here.
   */
  namespace?: string;
  concurrency?: number;
}

export interface WritableDatastoreControlPlaneStoreConformanceResult {
  namespacedPushSkipped?: string;
}

/**
 * checks the contract the v3 writer lease relies on: one set of records at the
 * datastore-wide _control/ root, whatever namespace a checkout syncs
 */
export async function assertWritableDatastoreControlPlaneStoreConformance(
  options: WritableDatastoreControlPlaneStoreConformanceOptions,
): Promise<WritableDatastoreControlPlaneStoreConformanceResult> {
  const namespace = options.namespace ??
    `conformance-ns-${crypto.randomUUID().slice(0, 8)}`;

  await assertControlPlaneStoreConformance(options.openDatastoreStore, {
    concurrency: options.concurrency,
  });
  await assertDatastoreControlPlaneStoreConformance({
    openDatastoreStore: options.openDatastoreStore,
    openSyncService: options.openSyncService,
    namespace,
  });
  await assertWritesStayAtRoot(options, namespace);
  if (!options.openNamespacedSyncFixture) {
    return { namespacedPushSkipped: "no openNamespacedSyncFixture was given" };
  }
  if (!options.markNamespaceUpgradedFromSolo) {
    return {
      namespacedPushSkipped: "no markNamespaceUpgradedFromSolo was given",
    };
  }
  const skipped = await assertDatastoreWideRecordsSurviveNamespacedPush(
    options.openDatastoreStore,
    options.openNamespacedSyncFixture,
    options.markNamespaceUpgradedFromSolo,
  );
  return skipped === undefined ? {} : { namespacedPushSkipped: skipped };
}

async function assertWritesStayAtRoot(
  options: WritableDatastoreControlPlaneStoreConformanceOptions,
  namespace: string,
): Promise<void> {
  const root = `conformance-${crypto.randomUUID()}`;
  const sharedKey = `${root}/shared`;
  const namespacedOnlyKey = `${root}/namespaced-only`;

  // Built before the datastore-wide store writes, so a write that bound a
  // namespace would show when this service pulls under its own.
  const namespacedService = await options.openSyncService();
  const rootService = await options.openSyncService();
  if (!namespacedService.controlPlaneStore || !rootService.controlPlaneStore) {
    throw new Error(
      "openSyncService must return services with a controlPlaneStore",
    );
  }
  const store = await options.openDatastoreStore();
  let namespacedStore: ControlPlaneStore | undefined;

  try {
    await store.put(sharedKey, encode("root"));
    assertEquals(
      await text(rootService.controlPlaneStore(), sharedKey),
      "root",
      "a record written through the datastore-wide store must be read at the root by a never-pulled sync service",
    );

    await namespacedService.pullChanged({ namespace });
    namespacedStore = namespacedService.controlPlaneStore();
    assertEquals(
      await namespacedStore.get(sharedKey),
      null,
      "a namespaced service must not see a record the datastore-wide store wrote at the root",
    );
    await namespacedStore.put(sharedKey, encode("namespaced"));
    await namespacedStore.put(namespacedOnlyKey, encode("namespaced"));
    assertEquals(
      await text(namespacedStore, sharedKey),
      "namespaced",
      "a namespaced service must still read its own records after the datastore-wide store wrote",
    );

    assertEquals(
      await text(store, sharedKey),
      "root",
      "a namespaced write must not change the datastore-wide record of the same key",
    );
    assertEquals(
      (await store.list(`${root}/`)).sort(),
      [sharedKey],
      "list must report only datastore-wide records, never a namespace's",
    );
    assertEquals(
      await store.putIfAbsent(namespacedOnlyKey, encode("root")),
      true,
      "putIfAbsent must not count a record that exists only under a namespace",
    );
    assertEquals(
      await text(namespacedStore, namespacedOnlyKey),
      "namespaced",
      "a datastore-wide create must leave the namespace's record of the same key unchanged",
    );
  } finally {
    for (const key of [sharedKey, namespacedOnlyKey]) {
      try {
        await store.delete(key);
      } catch { /* best-effort cleanup */ }
      try {
        await namespacedStore?.delete(key);
      } catch { /* best-effort cleanup */ }
    }
  }
}

async function assertDatastoreWideRecordsSurviveNamespacedPush(
  openDatastoreStore:
    WritableDatastoreControlPlaneStoreConformanceOptions["openDatastoreStore"],
  openFixture: () => Promise<NamespacedSyncFixture>,
  markNamespaceUpgradedFromSolo: (namespace: string) => Promise<void>,
): Promise<string | undefined> {
  const id = crypto.randomUUID();
  // Under `writer/` but not a lease key, so a live lease never reads it;
  // under `lineage/` but no lineage's fence, so no restore reads it.
  const writerKey = `writer/conformance-${id}`;
  const lineageKey = `lineage/conformance-${id}/started.json`;
  const datastoreWide = [
    { key: writerKey, dir: "writer/" },
    { key: lineageKey, dir: "lineage/" },
  ];
  // A namespace of its own: it stays marked upgraded from solo, so every
  // later push into it would move root records again.
  const namespace = `conformance-upgraded-${id.slice(0, 8)}`;
  const relPath = `${namespace}/data/conformance/writer-${id}`;
  const store = await openDatastoreStore();

  // The push about to be triggered moves every root record, not only the
  // suite's own, on a backend that does it at all. Run it only where there
  // is nothing else to move.
  const existing = await store.list("");
  if (existing.length > 0) {
    return `the datastore-wide root holds ${existing.length} record(s) the suite did not write; run it against an empty datastore or prefix`;
  }

  const fixture = await openFixture();
  try {
    for (const { key } of datastoreWide) {
      await store.put(key, encode("datastore-wide"));
    }
    await markNamespaceUpgradedFromSolo(namespace);

    // A namespaced push into a namespace upgraded from solo is when root
    // records are moved into it.
    await fixture.service.pullChanged({ namespace });
    await fixture.service.markDirty({ relPath, namespace });
    await writeLocal(fixture.cacheDir, relPath, encode("conformance"));
    await fixture.service.pushChanged({ namespace });

    for (const { key, dir } of datastoreWide) {
      assertEquals(
        await text(store, key),
        "datastore-wide",
        `a record under ${dir} must stay at the datastore-wide root after a namespaced push`,
      );
      assert(
        (await store.list(dir)).includes(key),
        `a record under ${dir} must still be listed at the root after a namespaced push`,
      );
      if (fixture.service.controlPlaneStore) {
        assertEquals(
          await fixture.service.controlPlaneStore().get(key),
          null,
          `a record under ${dir} must never be copied into a namespace`,
        );
      }
    }
  } finally {
    for (const { key } of datastoreWide) {
      try {
        await store.delete(key);
      } catch { /* best-effort cleanup */ }
      // A store that moved the record left it under the namespace.
      try {
        await fixture.service.controlPlaneStore?.().delete(key);
      } catch { /* best-effort cleanup */ }
    }
    try {
      await fixture.service.markDirty({ relPath, namespace });
      await Deno.remove(join(fixture.cacheDir, ...relPath.split("/")));
      await fixture.service.pushChanged({ namespace });
    } catch { /* best-effort cleanup */ }
  }
  return undefined;
}

async function writeLocal(
  cacheDir: string,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const path = join(cacheDir, ...relPath.split("/"));
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeFile(path, bytes);
}

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
