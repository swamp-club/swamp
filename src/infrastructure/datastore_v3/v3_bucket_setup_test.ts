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
import {
  DATASTORE_FORMAT_MARKER_KEY,
  DatastoreFormatMismatchError,
} from "../../domain/datastore/datastore_format.ts";
import {
  initializeV3BucketDatastore,
  inspectV3BucketTarget,
  V2_ROOT_INDEX_KEYS,
} from "./v3_bucket_setup.ts";

/**
 * The refusal the S3 and GCS extensions' sync services throw for a prefix
 * whose marker says format 3 or more (swamp-club#3549): a `code` and a
 * message telling the user to upgrade.
 */
class FormatUnsupportedError extends Error {
  readonly code = "datastore_format_unsupported";

  constructor() {
    super(
      "This datastore uses format 3 (written by 1.0.0), which this swamp " +
        "release can't open. Upgrade swamp to the latest release " +
        "(`swamp update`). Nothing was synced.",
    );
  }
}

/**
 * A provider over the in-memory remote whose sync service answers
 * `fetchContent` from `rootFiles`, as a real bucket's root index would:
 * the fake keeps no index files of its own. Like the extensions, it refuses
 * every read once the marker says format 3. `refuseFetch` makes it refuse
 * whatever the marker says: `"marker"` first writes one, as a concurrent
 * setup would after inspection read none; `"other"` writes nothing.
 * `namespaces` is what `listNamespaces` lists.
 */
function provider(
  options: {
    rootFiles?: Record<string, string>;
    fetchContent?: boolean;
    listNamespaces?: boolean;
    refuseFetch?: "marker" | "other";
    namespaces?: string[];
  } = {},
) {
  const remote = createInMemoryRemote({ controlPlane: true, storage: true });
  const fetched: string[] = [];
  const service = {
    fetchContent: async (relPath: string) => {
      fetched.push(relPath);
      if (options.refuseFetch === "marker") {
        await remote.datastoreControlPlaneStore!().put(
          DATASTORE_FORMAT_MARKER_KEY,
          new TextEncoder().encode('{"format":3,"minReaderFormat":3}'),
        );
      }
      const marker = await remote.datastoreControlPlaneStore!().get(
        DATASTORE_FORMAT_MARKER_KEY,
      );
      if (
        options.refuseFetch !== undefined ||
        (marker !== null &&
          JSON.parse(new TextDecoder().decode(marker)).format >= 3)
      ) {
        throw new FormatUnsupportedError();
      }
      const text = options.rootFiles?.[relPath];
      return text === undefined ? null : new TextEncoder().encode(text);
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
      : { listNamespaces: () => Promise.resolve(options.namespaces ?? []) }),
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

Deno.test("inspectV3BucketTarget: a prefix holding only a format-3 marker is resumable from any repo, and its v2 root data is not probed (swamp-club#3643)", async () => {
  const { provider: p, fetched } = provider();
  await initializeV3BucketDatastore(p, "@test/bucket", "1.0.0");
  for (const repoDir of ["/repo-a", "/repo-b"]) {
    assertEquals(
      await inspectV3BucketTarget(p, "@test/bucket", repoDir, undefined),
      { kind: "resumable" },
      repoDir,
    );
  }
  assertEquals(fetched, []);
});

Deno.test("inspectV3BucketTarget: a format-3 marker beside a control-plane record is still refused (swamp-club#3643)", async () => {
  const { remote, provider: p } = provider();
  await initializeV3BucketDatastore(p, "@test/bucket", "1.0.0");
  await remote.datastoreControlPlaneStore!().put(
    "writer-lease",
    new Uint8Array(),
  );
  assertEquals(
    await inspectV3BucketTarget(p, "@test/bucket", "/repo", undefined),
    {
      kind: "refused",
      reason: "its control plane already holds records (writer-lease)",
    },
  );
});

Deno.test("inspectV3BucketTarget: v2 root data planted beside a format-3 marker is not probed, and the prefix completes (swamp-club#3643)", async () => {
  // The extensions' sync services refuse every read of a format-3 prefix,
  // and no compliant swamp writes v2 data beside a v3 marker, so setup's
  // v2 probes ran before it wrote the marker and are not run again.
  const { provider: p } = provider({
    rootFiles: { [V2_ROOT_INDEX_KEYS[0]]: "{}" },
  });
  await initializeV3BucketDatastore(p, "@test/bucket", "1.0.0");
  assertEquals(
    await inspectV3BucketTarget(p, "@test/bucket", "/repo", undefined),
    { kind: "resumable" },
  );
});

Deno.test("inspectV3BucketTarget: v2 namespaces beside a format-3 marker are still refused (swamp-club#3643)", async () => {
  // listNamespaces lists the bucket through the provider, not the sync
  // service, so the marker does not stop it.
  const { provider: p } = provider({ namespaces: ["team"] });
  await initializeV3BucketDatastore(p, "@test/bucket", "1.0.0");
  assertEquals(
    await inspectV3BucketTarget(p, "@test/bucket", "/repo", undefined),
    { kind: "refused", reason: "it holds v2 namespaces (team)" },
  );
});

Deno.test("inspectV3BucketTarget: an extension's format refusal never reaches the user, and says run again only when a marker appeared (swamp-club#3643)", async () => {
  const cases: ["marker" | "other", string][] = [
    [
      "marker",
      "a format marker was written to it while it was being inspected, " +
      "which another setup may have done; run the command again",
    ],
    [
      "other",
      "its extension refused to read it, so swamp cannot tell whether it " +
      "holds v2 data",
    ],
  ];
  for (const [refuseFetch, reason] of cases) {
    const state = await inspectV3BucketTarget(
      provider({ refuseFetch }).provider,
      "@test/bucket",
      "/repo",
      undefined,
    );
    assertEquals(state, { kind: "refused", reason }, refuseFetch);
  }
});
