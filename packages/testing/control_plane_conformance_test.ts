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
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import {
  assertControlPlaneStoreConformance,
  assertDatastoreControlPlaneStoreConformance,
  assertWritableDatastoreControlPlaneStoreConformance,
  createInMemoryControlPlaneStore,
  type NamespacedSyncFixture,
} from "./control_plane_conformance.ts";
import { join } from "@std/path";
import {
  createInMemoryRemote,
  type InMemoryRemote,
} from "./in_memory_remote.ts";
import type {
  ControlPlaneStore,
  DatastoreSyncService,
  WritableDatastoreControlPlaneStore,
} from "./datastore_types.ts";

Deno.test("assertControlPlaneStoreConformance: the in-memory store conforms and is left empty", async () => {
  const store = createInMemoryControlPlaneStore();

  await assertControlPlaneStoreConformance(() => store);

  if ((await store.list("")).length !== 0) {
    throw new Error("the suite left records behind");
  }
});

Deno.test("assertControlPlaneStoreConformance: a store without putIfAbsent fails unless it is declared so", async () => {
  const { putIfAbsent: _dropped, ...partial } =
    createInMemoryControlPlaneStore();
  const store: ControlPlaneStore = partial;

  await assertRejects(
    () => assertControlPlaneStoreConformance(() => store),
    Error,
    "must implement putIfAbsent",
  );
  await assertControlPlaneStoreConformance(() => store, {
    requirePutIfAbsent: false,
  });
});

Deno.test("assertControlPlaneStoreConformance: catches a create that overwrites", async () => {
  const store = createInMemoryControlPlaneStore();
  const overwriting: ControlPlaneStore = {
    ...store,
    putIfAbsent: async (key, data) => {
      await store.put(key, data);
      return true;
    },
  };

  await assertRejects(
    () => assertControlPlaneStoreConformance(() => overwriting),
    Error,
    "must return false",
  );
});

Deno.test("assertControlPlaneStoreConformance: catches a create that checks and writes in two steps", async () => {
  const store = createInMemoryControlPlaneStore();
  // Reads, yields, then writes: every racer sees the key as free.
  const racy: ControlPlaneStore = {
    ...store,
    putIfAbsent: async (key, data) => {
      if (await store.get(key) !== null) return false;
      await Promise.resolve();
      await store.put(key, data);
      return true;
    },
  };

  await assertRejects(
    () => assertControlPlaneStoreConformance(() => racy),
    Error,
    "exactly one must return true",
  );
});

Deno.test("assertControlPlaneStoreConformance: catches handles that do not share their records", async () => {
  await assertRejects(
    () =>
      assertControlPlaneStoreConformance(() =>
        createInMemoryControlPlaneStore()
      ),
    Error,
    "a second handle must see",
  );
});

Deno.test("assertControlPlaneStoreConformance: catches a list that matches by name prefix instead of by path", async () => {
  const store = createInMemoryControlPlaneStore();
  const loose: ControlPlaneStore = {
    ...store,
    list: (prefix) => store.list(prefix.replace(/\/$/, "")),
  };

  await assertRejects(
    () => assertControlPlaneStoreConformance(() => loose),
    Error,
    "list must return every key under the prefix",
  );
});

Deno.test("assertDatastoreControlPlaneStoreConformance: catches a store that reads under a bound namespace", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cp-conformance-" });
  try {
    const remote = createInMemoryRemote({ controlPlane: true });
    let caches = 0;
    const openSyncService = () =>
      remote.connect(join(dir, `cache-${caches++}`));
    await assertRejects(
      () =>
        assertDatastoreControlPlaneStoreConformance({
          namespace: "team",
          // A namespaced service's store, not the datastore-wide one.
          openDatastoreStore: async () => {
            const service = openSyncService();
            await service.pullChanged({ namespace: "team" });
            return service.controlPlaneStore!();
          },
          openSyncService,
        }),
      Error,
      "datastore-wide root",
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

async function withRemoteDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cp-conformance-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Sync services and fixtures over `remote`, each with a cache of its own. */
function remoteFixtures(remote: InMemoryRemote, dir: string) {
  let caches = 0;
  const openNamespacedSyncFixture = (): Promise<NamespacedSyncFixture> => {
    const cacheDir = join(dir, `cache-${caches++}`);
    return Promise.resolve({ service: remote.connect(cacheDir), cacheDir });
  };
  return {
    openSyncService: (): DatastoreSyncService =>
      remote.connect(join(dir, `cache-${caches++}`)),
    openNamespacedSyncFixture,
  };
}

Deno.test("assertWritableDatastoreControlPlaneStoreConformance: the in-memory remote conforms and is left without control records or files", async () => {
  await withRemoteDir(async (dir) => {
    const remote = createInMemoryRemote({ controlPlane: true });
    const result = await assertWritableDatastoreControlPlaneStoreConformance({
      openDatastoreStore: () => remote.datastoreControlPlaneStore!(),
      ...remoteFixtures(remote, dir),
    });
    assertEquals(result, {});
    assertEquals([...remote.controlPlaneRecords().keys()], []);
    assertEquals([...remote.files().keys()], []);
  });
});

Deno.test("assertWritableDatastoreControlPlaneStoreConformance: skips the namespaced-push case without a fixture", async () => {
  await withRemoteDir(async (dir) => {
    const remote = createInMemoryRemote({ controlPlane: true });
    const result = await assertWritableDatastoreControlPlaneStoreConformance({
      openDatastoreStore: () => remote.datastoreControlPlaneStore!(),
      openSyncService: remoteFixtures(remote, dir).openSyncService,
    });
    assertEquals(
      result.namespacedPushSkipped,
      "no openNamespacedSyncFixture was given",
    );
  });
});

Deno.test("assertWritableDatastoreControlPlaneStoreConformance: catches a create that overwrites", async () => {
  await withRemoteDir(async (dir) => {
    const remote = createInMemoryRemote({ controlPlane: true });
    await assertRejects(
      () =>
        assertWritableDatastoreControlPlaneStoreConformance({
          openDatastoreStore: () => {
            const store = remote.datastoreControlPlaneStore!();
            return {
              ...store,
              putIfAbsent: async (key, data) => {
                await store.put(key, data);
                return true;
              },
            };
          },
          ...remoteFixtures(remote, dir),
        }),
      Error,
      "putIfAbsent on a key that holds a record must return false",
    );
  });
});

Deno.test("assertWritableDatastoreControlPlaneStoreConformance: catches a store that writes under a bound namespace", async () => {
  await withRemoteDir(async (dir) => {
    const remote = createInMemoryRemote({ controlPlane: true });
    const fixtures = remoteFixtures(remote, dir);
    await assertRejects(
      () =>
        assertWritableDatastoreControlPlaneStoreConformance({
          namespace: "team",
          // A namespaced service's store, not the datastore-wide one.
          openDatastoreStore: async () => {
            const service = fixtures.openSyncService();
            await service.pullChanged({ namespace: "team" });
            return service
              .controlPlaneStore!() as WritableDatastoreControlPlaneStore;
          },
          ...fixtures,
        }),
      Error,
      "datastore-wide root",
    );
  });
});

Deno.test("assertWritableDatastoreControlPlaneStoreConformance: catches a store whose list reports a namespace's records", async () => {
  await withRemoteDir(async (dir) => {
    const remote = createInMemoryRemote({ controlPlane: true });
    await assertRejects(
      () =>
        assertWritableDatastoreControlPlaneStoreConformance({
          namespace: "team",
          openDatastoreStore: () => {
            const store = remote.datastoreControlPlaneStore!();
            return {
              ...store,
              list: async (prefix) => {
                const namespaced = [...remote.controlPlaneRecords().keys()]
                  .filter((k) => k.startsWith(`team/_control/${prefix}`))
                  .map((k) => k.slice("team/_control/".length));
                return [
                  ...new Set([...await store.list(prefix), ...namespaced]),
                ];
              },
            };
          },
          ...remoteFixtures(remote, dir),
        }),
      Error,
      "list must report only datastore-wide records",
    );
  });
});

Deno.test("assertWritableDatastoreControlPlaneStoreConformance: catches a namespaced pull that moves root records into the namespace", async () => {
  await withRemoteDir(async (dir) => {
    const remote = createInMemoryRemote({ controlPlane: true });
    const fixtures = remoteFixtures(remote, dir);
    const root = remote.datastoreControlPlaneStore!();
    // Models the S3 and GCS extensions' migrateRootControlPlaneToNamespace:
    // once the namespace has files, a namespaced pull moves every root
    // _control record into it.
    const migrating = (
      service: DatastoreSyncService,
    ): DatastoreSyncService => ({
      ...service,
      pullChanged: async (options) => {
        const ns = options?.namespace;
        if (
          ns && [...remote.files().keys()].some((k) => k.startsWith(`${ns}/`))
        ) {
          for (const [key, data] of remote.controlPlaneRecords()) {
            if (!key.startsWith("_control/")) continue;
            const relative = key.slice("_control/".length);
            remote.seedControlPlane(relative, data, { namespace: ns });
            await root.delete(relative);
          }
        }
        return await service.pullChanged(options);
      },
    });
    await assertRejects(
      () =>
        assertWritableDatastoreControlPlaneStoreConformance({
          namespace: "team",
          openDatastoreStore: () => remote.datastoreControlPlaneStore!(),
          openSyncService: fixtures.openSyncService,
          openNamespacedSyncFixture: async () => {
            const fixture = await fixtures.openNamespacedSyncFixture();
            return { ...fixture, service: migrating(fixture.service) };
          },
        }),
      Error,
      "must stay at the datastore-wide root after namespaced pulls and pushes",
    );
  });
});
