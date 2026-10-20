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
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import {
  type CustomDatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import type { V3ReplicaTarget } from "../../domain/datastore/replica_target.ts";
import {
  DatastoreFormatMismatchError,
  UnreachableDatastoreFormatMarkerError,
} from "../../domain/datastore/datastore_format.ts";
import { V3HostingUnsupportedError } from "../../domain/datastore/v3_hosting.ts";
import { UserError } from "../../domain/errors.ts";
import { lockingConfigOf } from "../persistence/datastore_lock_target.ts";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";
import { V3_REPLICA_ENV } from "./litestream/replica_setting.ts";
import {
  assertV3BucketHost,
  bindV3BucketDatastore,
  boundV3BucketLocation,
  confirmV3BucketMarker,
  resetV3BucketBindingsForTesting,
  V3_LOCAL_COPIES_DIR,
  v3BucketBindingAt,
  v3BucketNamespacedStore,
  v3ControlPlaneAt,
  v3ReplicaFor,
  v3ReplicatesAt,
} from "./v3_datastore_binding.ts";

const TARGET: V3ReplicaTarget = {
  type: "s3",
  bucket: "team-bucket",
  prefix: "",
  region: "us-east-1",
};

function bucketProvider(
  options: { target?: V3ReplicaTarget; storage?: boolean } = {},
) {
  const remote = createInMemoryRemote({
    controlPlane: true,
    ...(options.storage === false ? {} : { storage: true }),
    replicaTarget: options.target ?? TARGET,
    replicaPaths: true,
  });
  const provider: DatastoreProvider = {
    createLock: () => {
      throw new Error("not used");
    },
    createVerifier: () => {
      throw new Error("not used");
    },
    resolveDatastorePath: (repoDir) => join(repoDir, ".swamp"),
    datastoreWideLease: true,
    datastoreControlPlaneStore: () => remote.datastoreControlPlaneStore!(),
    ...(remote.storage ? { storage: () => remote.storage!() } : {}),
    replicaTarget: () => remote.replicaTarget!(),
    replicaPaths: () => remote.replicaPaths!(),
  };
  return { remote, provider };
}

function bucketConfig(namespace?: string): CustomDatastoreConfig {
  return {
    type: "@test/bucket",
    config: {},
    datastorePath: "/unused",
    format: 3,
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

const LINUX = { os: "linux", arch: "x86_64" } as const;

async function withRepo(fn: (repoDir: string) => Promise<void>) {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-v3-binding-" });
  try {
    await fn(repoDir);
  } finally {
    resetV3BucketBindingsForTesting();
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("bindV3BucketDatastore: binds a local root under the checkout's copies, where the helpers find the bucket", async () => {
  await withRepo(async (repoDir) => {
    const { provider } = bucketProvider();
    const config = bucketConfig("team-a");
    const location = bindV3BucketDatastore(repoDir, config, provider, {
      platform: LINUX,
    });
    assertStringIncludes(location.path, V3_LOCAL_COPIES_DIR);
    assert((await Deno.stat(location.path)).isDirectory);
    assertEquals(location.namespace, "team-a");
    assertEquals(boundV3BucketLocation(config), location);
    // Bound once per config object.
    assertEquals(
      bindV3BucketDatastore(repoDir, config, provider, { platform: LINUX }),
      location,
    );
    const binding = v3BucketBindingAt(location.path);
    assert(binding !== undefined);
    assertEquals(v3ControlPlaneAt(location.path), binding.controlPlane);
    assert(v3ReplicatesAt(location.path), "a bucket datastore replicates");
    assertEquals(v3ReplicaFor(location.path)?.type, "s3");
    assertEquals(binding.replicaPaths?.root, "s3::team-bucket:");
    // Its locks are file locks at the same root.
    const locking = lockingConfigOf(config);
    assert(!isCustomDatastoreConfig(locking));
    assertEquals(locking.path, location.path);
  });
});

Deno.test("bindV3BucketDatastore: the internal replica setting wins for replication but never moves the local root", async () => {
  await withRepo(async (repoDir) => {
    const plain = bindV3BucketDatastore(
      repoDir,
      bucketConfig(),
      bucketProvider().provider,
      { platform: LINUX },
    );
    resetV3BucketBindingsForTesting();
    await withMockedEnv(
      {
        [V3_REPLICA_ENV]: JSON.stringify({
          type: "file",
          path: join(repoDir, "replica"),
        }),
      },
      () => {
        const overridden = bindV3BucketDatastore(
          repoDir,
          bucketConfig(),
          bucketProvider().provider,
          { platform: LINUX },
        );
        assertEquals(overridden.path, plain.path);
        assertEquals(v3ReplicaFor(overridden.path)?.type, "file");
        return Promise.resolve();
      },
    );
  });
});

Deno.test("bindV3BucketDatastore: with the replica setting empty a bucket datastore still replicates to its own target (swamp-club#3565)", async () => {
  await withRepo(async (repoDir) => {
    // A filesystem v3 writer with the setting empty does not replicate; a
    // bucket's writer always does, so no writer of it skips replication.
    await withMockedEnv({ [V3_REPLICA_ENV]: "" }, () => {
      const location = bindV3BucketDatastore(
        repoDir,
        bucketConfig(),
        bucketProvider().provider,
        { platform: LINUX },
      );
      assert(v3ReplicatesAt(location.path), "a bucket datastore replicates");
      assertEquals(v3ReplicaFor(location.path)?.type, "s3");
      return Promise.resolve();
    });
  });
});

Deno.test("bindV3BucketDatastore: a different bucket gets a different local root", async () => {
  await withRepo((repoDir) => {
    const a = bindV3BucketDatastore(
      repoDir,
      bucketConfig(),
      bucketProvider().provider,
      { platform: LINUX },
    );
    const b = bindV3BucketDatastore(
      repoDir,
      bucketConfig(),
      bucketProvider({ target: { ...TARGET, bucket: "other" } }).provider,
      { platform: LINUX },
    );
    assertNotEquals(a.path, b.path);
    return Promise.resolve();
  });
});

Deno.test("a filesystem v3 datastore has no binding: the helpers behave as before", async () => {
  await withRepo(async (dir) => {
    assertEquals(v3BucketBindingAt(dir), undefined);
    assertEquals(v3ReplicatesAt(dir), false);
    await withMockedEnv(
      { [V3_REPLICA_ENV]: JSON.stringify({ type: "file", path: dir }) },
      () => {
        assertEquals(v3ReplicaFor(dir)?.type, "file");
        return Promise.resolve();
      },
    );
  });
});

Deno.test("assertV3BucketHost: refuses a provider without the v3 capabilities, Windows below the pin and a replica target the provider refuses", () => {
  const { provider } = bucketProvider({ storage: false });
  assertThrows(
    () => assertV3BucketHost(provider, "@test/bucket", LINUX),
    V3HostingUnsupportedError,
    "storage()",
  );
  assertThrows(
    () =>
      assertV3BucketHost(bucketProvider().provider, "@test/bucket", {
        os: "windows",
        arch: "x86_64",
      }),
    UserError,
    "Windows",
  );
  const refusing: DatastoreProvider = {
    ...bucketProvider().provider,
    replicaTarget: () => {
      throw new Error("a custom apiEndpoint has no Litestream equivalent");
    },
  };
  assertThrows(
    () => assertV3BucketHost(refusing, "@test/bucket", LINUX),
    UserError,
    "a custom apiEndpoint has no Litestream equivalent",
  );
  assertEquals(
    assertV3BucketHost(bucketProvider().provider, "@test/bucket", LINUX).type,
    "s3",
  );
});

Deno.test("v3BucketNamespacedStore: namespaced records live under ns/, never beside the lease or the lineages", async () => {
  await withRepo(async (repoDir) => {
    const { remote, provider } = bucketProvider();
    const location = bindV3BucketDatastore(repoDir, bucketConfig(), provider, {
      platform: LINUX,
    });
    const binding = v3BucketBindingAt(location.path)!;
    for (const namespace of [undefined, "writer", "lineage", "team-a"]) {
      const store = v3BucketNamespacedStore(binding, namespace);
      assertEquals(
        await store.putIfAbsent("waits/run-1", new TextEncoder().encode("x")),
        true,
      );
      assertEquals(await store.list("waits/"), ["waits/run-1"]);
    }
    const keys = [...remote.controlPlaneRecords().keys()].sort();
    assertEquals(keys, [
      "_control/ns/_/waits/run-1",
      "_control/ns/lineage/waits/run-1",
      "_control/ns/team-a/waits/run-1",
      "_control/ns/writer/waits/run-1",
    ]);
    assertEquals(await binding.controlPlane.list("writer/"), []);
    assertEquals(await binding.controlPlane.list("lineage/"), []);
  });
});

Deno.test("confirmV3BucketMarker: passes a format-3 marker and refuses a missing, other or unreadable one", async () => {
  const store = (bytes: Uint8Array | null | Error) => ({
    get: () =>
      bytes instanceof Error ? Promise.reject(bytes) : Promise.resolve(bytes),
  });
  const encode = (text: string) => new TextEncoder().encode(text);
  await confirmV3BucketMarker(
    store(encode('{"format":3,"minReaderFormat":3}')),
    "@test/bucket",
  );
  await assertRejects(
    () => confirmV3BucketMarker(store(null), "@test/bucket"),
    DatastoreFormatMismatchError,
    "no readable format marker",
  );
  await assertRejects(
    () => confirmV3BucketMarker(store(encode('{"format":2}')), "@test/bucket"),
    DatastoreFormatMismatchError,
    "says format 2",
  );
  const unreachable = await assertRejects(
    () => confirmV3BucketMarker(store(new Error("reset")), "@test/bucket"),
    UnreachableDatastoreFormatMarkerError,
    "reset",
  );
  // Only ever confirmed under a format-3 config (swamp-club#3644).
  assertEquals(unreachable.message.includes("as format 2"), false);
});

Deno.test("V3BucketBinding.confirmMarker: reads once while it passes, and again after a failure", async () => {
  await withRepo(async (repoDir) => {
    const { remote, provider } = bucketProvider();
    const location = bindV3BucketDatastore(repoDir, bucketConfig(), provider, {
      platform: LINUX,
    });
    const binding = v3BucketBindingAt(location.path)!;
    await assertRejects(
      () => binding.confirmMarker(),
      DatastoreFormatMismatchError,
    );
    await remote.datastoreControlPlaneStore!().put(
      "datastore-format",
      new TextEncoder().encode('{"format":3,"minReaderFormat":3}'),
    );
    await binding.confirmMarker();
    await remote.datastoreControlPlaneStore!().delete("datastore-format");
    // Confirmed once for the process: not read again.
    await binding.confirmMarker();
  });
});

Deno.test("bindV3BucketDatastore: a re-resolved config of the same datastore keeps the first binding; another datastore on its root is refused", async () => {
  await withRepo(async (repoDir) => {
    const { remote, provider } = bucketProvider();
    const first = bindV3BucketDatastore(repoDir, bucketConfig(), provider, {
      platform: LINUX,
    });
    const binding = v3BucketBindingAt(first.path)!;
    await remote.datastoreControlPlaneStore!().put(
      "datastore-format",
      new TextEncoder().encode('{"format":3,"minReaderFormat":3}'),
    );
    await binding.confirmMarker();
    const again = bindV3BucketDatastore(repoDir, bucketConfig(), provider, {
      platform: LINUX,
    });
    assertEquals(again.path, first.path);
    assert(
      v3BucketBindingAt(first.path) === binding,
      "the first binding stays",
    );
    assertThrows(
      () =>
        bindV3BucketDatastore(
          repoDir,
          { ...bucketConfig(), type: "@test/other" },
          provider,
          { platform: LINUX },
        ),
      Error,
      "share the local root",
    );
  });
});

Deno.test("lockingConfigOf: a v3 extension config no binding has seen is refused, never locked the v2 way", () => {
  assertThrows(
    () => lockingConfigOf(bucketConfig()),
    Error,
    "before it was bound",
  );
  const { format: _, ...v2 } = bucketConfig();
  assertEquals(lockingConfigOf(v2), v2);
});
