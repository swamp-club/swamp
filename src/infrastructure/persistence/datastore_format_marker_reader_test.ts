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

import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  DATASTORE_FORMAT_MARKER_KEY,
  DATASTORE_FORMAT_MARKER_MAX_BYTES,
} from "../../domain/datastore/datastore_format.ts";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import {
  DATASTORE_FORMAT_FALLBACK_READ_TIMEOUT_MS,
  DATASTORE_FORMAT_READ_TIMEOUT_MS,
  readDatastoreFormatMarker,
} from "./datastore_format_marker_reader.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-format-marker-" });
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

const encode = (text: string) => new TextEncoder().encode(text);

function customConfig(
  overrides: Partial<CustomDatastoreConfig> = {},
): CustomDatastoreConfig {
  return {
    type: "@test/store",
    config: {},
    datastorePath: "/repo/.swamp",
    cachePath: "/repo/.cache",
    ...overrides,
  };
}

function provider(
  createSyncService?: DatastoreProvider["createSyncService"],
  datastoreControlPlaneStore?: DatastoreProvider["datastoreControlPlaneStore"],
): () => Promise<DatastoreProvider> {
  const p: DatastoreProvider = {
    createLock: () => {
      throw new Error("the reader must not take a lock");
    },
    createVerifier: () => {
      throw new Error("the reader must not verify");
    },
    resolveDatastorePath: () => "/repo/.swamp",
    ...(createSyncService ? { createSyncService } : {}),
    ...(datastoreControlPlaneStore ? { datastoreControlPlaneStore } : {}),
  };
  return () => Promise.resolve(p);
}

// ---- filesystem -----------------------------------------------------------

Deno.test("readDatastoreFormatMarker: a filesystem datastore without a marker reads absent", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await readDatastoreFormatMarker("/repo", {
        type: "filesystem",
        path: dir,
      }),
      { kind: "absent" },
    );
  });
});

Deno.test("readDatastoreFormatMarker: a filesystem marker is read from the datastore root, whatever the namespace", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, DATASTORE_FORMAT_MARKER_FILE);
    await Deno.writeTextFile(path, '{"format":3}');
    for (const namespace of [undefined, "infra"]) {
      const read = await readDatastoreFormatMarker("/repo", {
        type: "filesystem",
        path: dir,
        ...(namespace ? { namespace } : {}),
      });
      assertEquals(read.kind, "present");
      if (read.kind !== "present") return;
      assertEquals(read.source, path);
      assertEquals(new TextDecoder().decode(read.bytes), '{"format":3}');
    }
  });
});

Deno.test("readDatastoreFormatMarker: a missing datastore directory or a file in its place reads absent", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await readDatastoreFormatMarker("/repo", {
        type: "filesystem",
        path: join(dir, "missing"),
      }),
      { kind: "absent" },
    );
    const file = join(dir, "file");
    await Deno.writeTextFile(file, "x");
    const read = await readDatastoreFormatMarker("/repo", {
      type: "filesystem",
      path: file,
    });
    // ENOTDIR on POSIX; Windows reports a missing path.
    assertEquals(read.kind, "absent");
  });
});

Deno.test("readDatastoreFormatMarker: a directory at the marker path is invalid", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, DATASTORE_FORMAT_MARKER_FILE));
    const read = await readDatastoreFormatMarker("/repo", {
      type: "filesystem",
      path: dir,
    });
    assertEquals(read.kind, "invalid");
  });
});

Deno.test({
  name:
    "readDatastoreFormatMarker: a symlink at the marker path is invalid, not followed",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, "outside.json");
      await Deno.writeTextFile(outside, '{"format":2}');
      await Deno.symlink(outside, join(dir, DATASTORE_FORMAT_MARKER_FILE), {
        type: "file",
      });
      const read = await readDatastoreFormatMarker("/repo", {
        type: "filesystem",
        path: dir,
      });
      assertEquals(read.kind, "invalid");
    });
  },
});

Deno.test("readDatastoreFormatMarker: an oversize filesystem marker is invalid without being read", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeFile(
      join(dir, DATASTORE_FORMAT_MARKER_FILE),
      new Uint8Array(DATASTORE_FORMAT_MARKER_MAX_BYTES + 1),
    );
    const read = await readDatastoreFormatMarker("/repo", {
      type: "filesystem",
      path: dir,
    });
    assertEquals(read.kind, "invalid");
  });
});

// ---- control plane --------------------------------------------------------

Deno.test("readDatastoreFormatMarker: reads the datastore-wide control-plane record through a fresh service", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  remote.seedControlPlane(DATASTORE_FORMAT_MARKER_KEY, encode('{"format":3}'));
  remote.seedControlPlane(DATASTORE_FORMAT_MARKER_KEY, encode("ns"), {
    namespace: "infra",
  });
  const read = await readDatastoreFormatMarker(
    "/repo",
    customConfig({ namespace: "infra" }),
    {
      resolveProvider: provider((_repo, cache) =>
        remote.connect(cache) as unknown as DatastoreSyncService
      ),
    },
  );
  assertEquals(read.kind, "present");
  if (read.kind !== "present") return;
  assertEquals(read.source, "_control/datastore-format on @test/store");
  assertEquals(new TextDecoder().decode(read.bytes), '{"format":3}');
  // A read writes nothing.
  assertEquals(remote.ops(), []);
});

Deno.test("readDatastoreFormatMarker: one read builds two sync services and makes one control-plane get", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  await readDatastoreFormatMarker("/repo", customConfig(), {
    resolveProvider: provider((_repo, cache) =>
      remote.connect(cache) as unknown as DatastoreSyncService
    ),
  });
  assertEquals(remote.connections(), 2);
  assertEquals(remote.controlPlaneReads().map((read) => read.key), [
    "_control/datastore-format",
  ]);
});

Deno.test("readDatastoreFormatMarker: a provider's datastore-wide store is read with one get and no sync service", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  remote.seedControlPlane(DATASTORE_FORMAT_MARKER_KEY, encode('{"format":3}'));
  remote.seedControlPlane(DATASTORE_FORMAT_MARKER_KEY, encode("ns"), {
    namespace: "infra",
  });
  const read = await readDatastoreFormatMarker(
    "/repo",
    customConfig({ namespace: "infra" }),
    {
      resolveProvider: provider(
        () => {
          throw new Error("the reader must not build a sync service");
        },
        () => remote.datastoreControlPlaneStore(),
      ),
    },
  );
  assertEquals(read.kind, "present");
  if (read.kind !== "present") return;
  assertEquals(read.source, "_control/datastore-format on @test/store");
  assertEquals(new TextDecoder().decode(read.bytes), '{"format":3}');
  assertEquals(remote.connections(), 0);
  assertEquals(remote.controlPlaneReads(), [
    { instance: "datastore", key: "_control/datastore-format" },
  ]);
  assertEquals(remote.ops(), []);
});

Deno.test("readDatastoreFormatMarker: a failed datastore-wide read is unreadable, with no fallback to a sync service", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  remote.failNext("controlPlane", new Error("AccessDenied"));
  const read = await readDatastoreFormatMarker("/repo", customConfig(), {
    resolveProvider: provider(
      (_repo, cache) =>
        remote.connect(cache) as unknown as DatastoreSyncService,
      () => remote.datastoreControlPlaneStore(),
    ),
  });
  assertEquals(read.kind, "unreadable");
  if (read.kind !== "unreadable") return;
  assertInstanceOf(read.error, Error);
  assertEquals(read.error.message, "AccessDenied");
  assertEquals(remote.connections(), 0);
});

Deno.test("readDatastoreFormatMarker: a read still pending at the deadline is abandoned and its signal aborted", async () => {
  const signals: AbortSignal[] = [];
  const read = await readDatastoreFormatMarker("/repo", customConfig(), {
    timeoutMs: 1,
    resolveProvider: provider(undefined, () => ({
      get: (_key, options) => {
        if (options?.signal) signals.push(options.signal);
        return new Promise<Uint8Array | null>(() => {});
      },
    })),
  });
  assertEquals(read.kind, "unreadable");
  if (read.kind !== "unreadable") return;
  assertInstanceOf(read.error, Error);
  assertEquals(read.error.message, "timed out after 1ms");
  assertEquals(signals.length, 1);
  assert(signals[0].aborted, "the read's signal is aborted at the deadline");
  assertEquals(signals[0].reason, read.error);
});

Deno.test("readDatastoreFormatMarker: a read that settles in time is not aborted", async () => {
  const signals: AbortSignal[] = [];
  const read = await readDatastoreFormatMarker("/repo", customConfig(), {
    resolveProvider: provider(undefined, () => ({
      get: (_key, options) => {
        if (options?.signal) signals.push(options.signal);
        return Promise.resolve(null);
      },
    })),
  });
  assertEquals(read, { kind: "absent" });
  assertEquals(signals.length, 1);
  assertEquals(signals[0].aborted, false);
});

Deno.test("readDatastoreFormatMarker: each read path waits for its own deadline", async () => {
  const hung = () => new Promise<Uint8Array | null>(() => {});
  const datastoreWide = await readDatastoreFormatMarker(
    "/repo",
    customConfig(),
    {
      timeoutMs: 1,
      fallbackTimeoutMs: 60_000,
      resolveProvider: provider(undefined, () => ({ get: hung })),
    },
  );
  assertEquals(datastoreWide.kind, "unreadable");
  if (datastoreWide.kind !== "unreadable") return;
  assertEquals((datastoreWide.error as Error).message, "timed out after 1ms");

  const service = {
    capabilities: () => ({ controlPlane: true }),
    controlPlaneStore: () => ({
      get: hung,
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    }),
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };
  const fallback = await readDatastoreFormatMarker("/repo", customConfig(), {
    timeoutMs: 60_000,
    fallbackTimeoutMs: 1,
    resolveProvider: provider(() =>
      ({ ...service }) as unknown as DatastoreSyncService
    ),
  });
  assertEquals(fallback.kind, "unreadable");
  if (fallback.kind !== "unreadable") return;
  assertEquals((fallback.error as Error).message, "timed out after 1ms");
});

Deno.test("DATASTORE_FORMAT_READ_TIMEOUT_MS: a degraded remote costs a command at most 3 s, or 4 s on the fallback read", () => {
  assert(DATASTORE_FORMAT_READ_TIMEOUT_MS >= 2_000);
  assert(DATASTORE_FORMAT_READ_TIMEOUT_MS <= 3_000);
  assert(
    DATASTORE_FORMAT_FALLBACK_READ_TIMEOUT_MS >=
      DATASTORE_FORMAT_READ_TIMEOUT_MS,
  );
  assert(DATASTORE_FORMAT_FALLBACK_READ_TIMEOUT_MS <= 4_000);
});

Deno.test("readDatastoreFormatMarker: a missing control-plane record reads absent", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  assertEquals(
    await readDatastoreFormatMarker("/repo", customConfig(), {
      resolveProvider: provider((_repo, cache) =>
        remote.connect(cache) as unknown as DatastoreSyncService
      ),
    }),
    { kind: "absent" },
  );
});

Deno.test("readDatastoreFormatMarker: a provider that shares one sync service is skipped and its namespace left unbound", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  remote.seedControlPlane(DATASTORE_FORMAT_MARKER_KEY, encode('{"format":3}'));
  const shared = remote.connect("/repo/.cache");
  const read = await readDatastoreFormatMarker(
    "/repo",
    customConfig({ namespace: "infra" }),
    {
      resolveProvider: provider(() =>
        shared as unknown as DatastoreSyncService
      ),
    },
  );
  assertEquals(read.kind, "unsupported");
  // The command's own namespaced pull on that instance still works.
  await shared.pullChanged({ namespace: "infra" });
});

Deno.test("readDatastoreFormatMarker: a datastore without a cache, sync service or control plane is unsupported", async () => {
  const remote = createInMemoryRemote();
  for (
    const [config, resolveProvider] of [
      [customConfig({ cachePath: undefined }), provider()],
      [customConfig(), provider()],
      [
        customConfig(),
        provider((_repo, cache) =>
          remote.connect(cache) as unknown as DatastoreSyncService
        ),
      ],
    ] as const
  ) {
    const read = await readDatastoreFormatMarker("/repo", config, {
      resolveProvider,
    });
    assertEquals(read.kind, "unsupported");
  }
});

Deno.test("readDatastoreFormatMarker: a failed control-plane read is unreadable", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  remote.failNext("controlPlane", new Error("connection reset"));
  const read = await readDatastoreFormatMarker("/repo", customConfig(), {
    resolveProvider: provider((_repo, cache) =>
      remote.connect(cache) as unknown as DatastoreSyncService
    ),
  });
  assertEquals(read.kind, "unreadable");
  if (read.kind !== "unreadable") return;
  assertInstanceOf(read.error, Error);
  assertEquals(read.error.message, "connection reset");
});

Deno.test("readDatastoreFormatMarker: a provider that cannot be resolved is unreadable", async () => {
  const read = await readDatastoreFormatMarker("/repo", customConfig(), {
    resolveProvider: () => Promise.reject(new Error("not registered")),
  });
  assertEquals(read.kind, "unreadable");
});

Deno.test("readDatastoreFormatMarker: a control-plane read that does not settle in time is unreadable", async () => {
  const hung = {
    capabilities: () => ({ controlPlane: true }),
    controlPlaneStore: () => ({
      get: () => new Promise<Uint8Array | null>(() => {}),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    }),
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => Promise.resolve(0),
    markDirty: () => Promise.resolve(),
  };
  const read = await readDatastoreFormatMarker("/repo", customConfig(), {
    timeoutMs: 1,
    resolveProvider: provider(() =>
      ({ ...hung }) as unknown as DatastoreSyncService
    ),
  });
  assertEquals(read.kind, "unreadable");
  if (read.kind !== "unreadable") return;
  assertInstanceOf(read.error, Error);
  assertEquals(read.error.message, "timed out after 1ms");
});

Deno.test("readDatastoreFormatMarker: an oversize control-plane record is invalid", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  remote.seedControlPlane(
    DATASTORE_FORMAT_MARKER_KEY,
    new Uint8Array(DATASTORE_FORMAT_MARKER_MAX_BYTES + 1),
  );
  const read = await readDatastoreFormatMarker("/repo", customConfig(), {
    resolveProvider: provider((_repo, cache) =>
      remote.connect(cache) as unknown as DatastoreSyncService
    ),
  });
  assertEquals(read.kind, "invalid");
});
