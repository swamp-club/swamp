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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import { DatastoreFormatMismatchError } from "../../domain/datastore/datastore_format.ts";
import {
  initializeV3BucketDatastore,
  inspectV3BucketTarget,
  V2_ROOT_INDEX_KEYS,
} from "./v3_bucket_setup.ts";

/**
 * A provider over the in-memory remote whose sync service answers
 * `fetchContent` from `rootFiles`, as a real bucket's root index would:
 * the fake keeps no index files of its own.
 */
function provider(
  options: {
    rootFiles?: Record<string, string>;
    fetchContent?: boolean;
    listNamespaces?: boolean;
  } = {},
) {
  const remote = createInMemoryRemote({ controlPlane: true, storage: true });
  const fetched: string[] = [];
  const service = {
    fetchContent: (relPath: string) => {
      fetched.push(relPath);
      const text = options.rootFiles?.[relPath];
      return Promise.resolve(
        text === undefined ? null : new TextEncoder().encode(text),
      );
    },
  } as unknown as DatastoreSyncService;
  const provider: DatastoreProvider = {
    createLock: () => {
      throw new Error("not used");
    },
    createVerifier: () => {
      throw new Error("not used");
    },
    resolveDatastorePath: () => "/ds",
    datastoreWideLease: true,
    datastoreControlPlaneStore: () => remote.datastoreControlPlaneStore!(),
    storage: () => remote.storage!(),
    createSyncService: () =>
      options.fetchContent === false ? ({} as DatastoreSyncService) : service,
    ...(options.listNamespaces === false
      ? {}
      : { listNamespaces: () => Promise.resolve([]) }),
  };
  return { remote, provider, fetched };
}

Deno.test("inspectV3BucketTarget: an empty bucket is new, and both v2 root index keys are probed", async () => {
  const { provider: p, fetched } = provider();
  assertEquals(
    await inspectV3BucketTarget(p, "@test/bucket", "/repo", undefined),
    { kind: "new" },
  );
  assertEquals(fetched, [...V2_ROOT_INDEX_KEYS]);
});

Deno.test("inspectV3BucketTarget: either v2 root index key refuses the bucket", async () => {
  for (const key of V2_ROOT_INDEX_KEYS) {
    const { provider: p } = provider({ rootFiles: { [key]: "{}" } });
    const state = await inspectV3BucketTarget(
      p,
      "@test/bucket",
      "/repo",
      undefined,
    );
    assertEquals(state, { kind: "refused", reason: "it holds v2 data" }, key);
  }
});

Deno.test("inspectV3BucketTarget: a check it cannot make refuses rather than passes", async () => {
  const noFetch = await inspectV3BucketTarget(
    provider({ fetchContent: false }).provider,
    "@test/bucket",
    "/repo",
    undefined,
  );
  assertEquals(noFetch.kind, "refused");
  if (noFetch.kind === "refused") {
    assertStringIncludes(noFetch.reason, "fetchContent");
  }
  const noList = await inspectV3BucketTarget(
    provider({ listNamespaces: false }).provider,
    "@test/bucket",
    "/repo",
    undefined,
  );
  assertEquals(noList.kind, "refused");
  if (noList.kind === "refused") {
    assertStringIncludes(noList.reason, "cannot list namespaces");
  }
  const { remote, provider: failing } = provider();
  remote.failNext("controlPlane", new Error("access denied"), {
    instance: "datastore",
  });
  const unreadable = await inspectV3BucketTarget(
    failing,
    "@test/bucket",
    "/repo",
    undefined,
  );
  assertEquals(unreadable.kind, "refused");
  if (unreadable.kind === "refused") {
    assertStringIncludes(unreadable.reason, "access denied");
  }
});

Deno.test("inspectV3BucketTarget: the verifier's probe keys are not records, and a lone format-3 marker is resumable", async () => {
  const { remote, provider: p } = provider();
  const store = remote.datastoreControlPlaneStore!();
  await store.put("conditional-write-probe-1234", new Uint8Array());
  assertEquals(
    await inspectV3BucketTarget(p, "@test/bucket", "/repo", undefined),
    { kind: "new" },
  );
  await initializeV3BucketDatastore(p, "@test/bucket", "1.0.0");
  assertEquals(
    await inspectV3BucketTarget(p, "@test/bucket", "/repo", undefined),
    { kind: "resumable" },
  );
});

Deno.test("initializeV3BucketDatastore: accepts a format-3 marker another setup wrote, and refuses another format", async () => {
  const { remote, provider: p } = provider();
  await initializeV3BucketDatastore(p, "@test/bucket", "first");
  await initializeV3BucketDatastore(p, "@test/bucket", "second");
  assertStringIncludes(
    new TextDecoder().decode(
      remote.controlPlaneRecords().get("_control/datastore-format"),
    ),
    "first",
  );
  const other = provider();
  await other.remote.datastoreControlPlaneStore!().put(
    "datastore-format",
    new TextEncoder().encode('{"format":2}'),
  );
  await assertRejects(
    () => initializeV3BucketDatastore(other.provider, "@test/bucket", "x"),
    DatastoreFormatMismatchError,
  );
});
