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

// S3SYNC citations refer to
// swamp-extensions@7c0b1eacf:datastore/s3/extensions/datastores/_lib/s3_cache_sync.ts.
// Each "pins" test asserts the extension behaviour of the release range it
// names (the default semantics: 2026.10.06.1 through 2026.10.07.1),
// including the gaps, so a change to the fake's semantics fails here on
// purpose.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  createInMemoryRemote,
  EXTENSION_2026_10_01_SEMANTICS,
  LEGACY_EXTENSION_SEMANTICS,
} from "./in_memory_remote.ts";
import { assertSyncServiceConformance } from "./datastore_conformance.ts";
import { assertControlPlaneStoreConformance } from "./control_plane_conformance.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-in-memory-remote-" });
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

async function write(cache: string, rel: string, text: string): Promise<void> {
  const path = join(cache, ...rel.split("/"));
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

async function read(cache: string, rel: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(join(cache, ...rel.split("/")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function remove(cache: string, rel: string): Promise<void> {
  await Deno.remove(join(cache, ...rel.split("/")), { recursive: true });
}

function remoteText(
  remote: ReturnType<typeof createInMemoryRemote>,
  rel: string,
): string | undefined {
  const bytes = remote.files().get(rel);
  return bytes && new TextDecoder().decode(bytes);
}

/** Two machines on one remote, each with a cache and a clean sidecar. */
async function twoMachines(
  dir: string,
  options?: Parameters<typeof createInMemoryRemote>[0],
) {
  const remote = createInMemoryRemote(options);
  const aCache = join(dir, "a");
  const bCache = join(dir, "b");
  await Deno.mkdir(aCache);
  await Deno.mkdir(bCache);
  const a = remote.connect(aCache, { instance: "a" });
  const b = remote.connect(bCache, { instance: "b" });
  // A first pull writes each machine's sidecar, as on a real step start.
  await a.pullChanged();
  await b.pullChanged();
  return { remote, a, b, aCache, bCache };
}

Deno.test("createInMemoryRemote: a marked file round-trips between two instances", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "data/m/raw", "v1");
    await a.markDirty({ relPath: "data/m/raw" });

    assertEquals(await a.pushChanged(), 1);
    assertEquals(remoteText(remote, "data/m/raw"), "v1");
    assertEquals(await b.pullChanged(), 1);
    assertEquals(await read(bCache, "data/m/raw"), "v1");
  });
});

Deno.test("createInMemoryRemote: a marked absent path deletes the remote key and everything under it", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "data/m/v1/raw", "x");
    await write(aCache, "data/m/v1/metadata.yaml", "y");
    await a.markDirty({ relPath: "data/m" });
    await a.pushChanged();

    await remove(aCache, "data/m");
    await a.markDirty({ relPath: "data/m" });
    assertEquals(await a.pushChanged(), 2);
    assertEquals([...remote.files().keys()], []);
  });
});

Deno.test("createInMemoryRemote: a marked directory deletes remote entries under it that are gone locally", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "data/m/1/raw", "one");
    await write(aCache, "data/m/2/raw", "two");
    await a.markDirty({ relPath: "data/m" });
    await a.pushChanged();

    await remove(aCache, "data/m/1");
    await a.markDirty({ relPath: "data/m" });
    await a.pushChanged();
    assertEquals([...remote.files().keys()], ["data/m/2/raw"]);
  });
});

Deno.test("createInMemoryRemote: a failed push keeps the path dirty and the next push sends it", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "note", "hi");
    await a.markDirty({ relPath: "note" });
    remote.failNext("push", new Error("network down"));

    await assertRejects(() => a.pushChanged(), Error, "network down");
    assertEquals(remote.files().size, 0);
    assertEquals(await a.pushChanged(), 1);
    assertEquals(remoteText(remote, "note"), "hi");
  });
});

Deno.test("createInMemoryRemote: pins that a bulk mark uploads everything and deletes nothing (S3SYNC:3206-3276)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "keep", "k");
    await write(aCache, "gone", "g");
    await a.markDirty();
    await a.pushChanged();

    await remove(aCache, "gone");
    await write(aCache, "new", "n");
    await a.markDirty();
    assertEquals(await a.pushChanged(), 1);
    // The deleted file survives remotely: a bare mark disables deletes.
    assertEquals([...remote.files().keys()].sort(), ["gone", "keep", "new"]);
  });
});

Deno.test("createInMemoryRemote: pins that path marks after a bulk mark are dropped (S3SYNC:1766-1772)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "x", "1");
    await a.markDirty({ relPath: "x" });
    await a.pushChanged();

    await remove(aCache, "x");
    await a.markDirty();
    await a.markDirty({ relPath: "x" });
    await a.pushChanged();
    assertEquals([...remote.files().keys()], ["x"]);
  });
});

Deno.test("createInMemoryRemote: bulkDisablesDeletes false makes a bulk push delete what is gone", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir, {
      semantics: { bulkDisablesDeletes: false },
    });
    await write(aCache, "gone", "g");
    await a.markDirty();
    await a.pushChanged();

    await remove(aCache, "gone");
    await a.markDirty();
    assertEquals(await a.pushChanged(), 1);
    assertEquals(remote.files().size, 0);
  });
});

Deno.test("createInMemoryRemote: pins that an overflowed dirty set deletes on its full walk (S3SYNC:1799-1806, 3259-3270)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir, { dirtyPathsCap: 2 });
    await write(aCache, "gone", "g");
    await a.markDirty({ relPath: "gone" });
    await a.pushChanged();

    await remove(aCache, "gone");
    await write(aCache, "p1", "1");
    await write(aCache, "p2", "2");
    await a.markDirty({ relPath: "p1" });
    await a.markDirty({ relPath: "p2" });
    await a.markDirty({ relPath: "p3" });
    await a.pushChanged();
    assertEquals([...remote.files().keys()].sort(), ["p1", "p2"]);
  });
});

Deno.test("createInMemoryRemote: pins that a write that was never marked is never pushed (S3SYNC:1945-1954)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "unmarked", "u");
    assertEquals(await a.pushChanged(), 0);
    assertEquals(remote.files().size, 0);
  });
});

Deno.test("createInMemoryRemote: a cache with no sidecar pushes with a full walk that deletes nothing", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote();
    const aCache = join(dir, "a");
    await write(aCache, "one", "1");
    await write(aCache, "two", "2");
    const a = remote.connect(aCache);
    assertEquals(await a.pushChanged(), 2);

    // Dropping the sidecar walks again, and still deletes nothing.
    await remove(aCache, "one");
    remote.resetSidecar(aCache);
    assertEquals(await a.pushChanged(), 0);
    assertEquals([...remote.files().keys()].sort(), ["one", "two"]);
  });
});

for (
  const [range, semantics] of [
    ["2026.09.24.1 and earlier", LEGACY_EXTENSION_SEMANTICS],
    ["2026.10.01.1", EXTENSION_2026_10_01_SEMANTICS],
  ] as const
) {
  Deno.test(`createInMemoryRemote: pins that a pull never deletes local files with extensions ${range} (swamp-extensions@5368cb002 s3_cache_sync.ts:2555-2561)`, async () => {
    await withTempDir(async (dir) => {
      const { a, b, aCache, bCache } = await twoMachines(dir, { semantics });
      await write(aCache, "f", "1");
      await write(aCache, "keep", "k");
      await a.markDirty({ relPath: "f" });
      await a.markDirty({ relPath: "keep" });
      await a.pushChanged();
      await b.pullChanged();

      await remove(aCache, "f");
      await a.markDirty({ relPath: "f" });
      await a.pushChanged();
      assertEquals(await b.pullChanged(), 0);
      assertEquals(await read(bCache, "f"), "1");
    });
  });
}

Deno.test("createInMemoryRemote: pullDeletes removes files the remote dropped unless they are dirty locally", async () => {
  await withTempDir(async (dir) => {
    const { a, b, aCache, bCache } = await twoMachines(dir, {
      semantics: { pullDeletes: true },
    });
    await write(aCache, "drop", "1");
    await write(aCache, "dirty", "2");
    await a.markDirty({ relPath: "drop" });
    await a.markDirty({ relPath: "dirty" });
    await a.pushChanged();
    await b.pullChanged();

    await remove(aCache, "drop");
    await remove(aCache, "dirty");
    await a.markDirty({ relPath: "drop" });
    await a.markDirty({ relPath: "dirty" });
    await a.pushChanged();
    await b.markDirty({ relPath: "dirty" });
    assertEquals(await b.pullChanged(), 1);
    assertEquals(await read(bCache, "drop"), undefined);
    assertEquals(await read(bCache, "dirty"), "2");
  });
});

Deno.test("createInMemoryRemote: pins that a pull overwrites a locally dirty file (S3SYNC:2363-2367)", async () => {
  await withTempDir(async (dir) => {
    const { a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "f", "remote");
    await a.markDirty({ relPath: "f" });
    await a.pushChanged();

    await write(bCache, "f", "local edit");
    await b.markDirty({ relPath: "f" });
    await b.pullChanged();
    assertEquals(await read(bCache, "f"), "remote");
  });
});

Deno.test("createInMemoryRemote: pins that a pull of a moved remote drops the pending push with extensions 2026.09.24.1 and earlier (swamp-extensions@5368cb002 s3_cache_sync.ts:2742, 2759)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir, {
      semantics: LEGACY_EXTENSION_SEMANTICS,
    });
    await write(bCache, "mine", "b");
    await b.markDirty({ relPath: "mine" });

    await write(aCache, "theirs", "a");
    await a.markDirty({ relPath: "theirs" });
    await a.pushChanged();

    await b.pullChanged();
    assertEquals(await b.pushChanged(), 0);
    assertEquals(remote.files().has("mine"), false);
  });
});

Deno.test("createInMemoryRemote: a pull of an unchanged remote keeps the pending push (S3SYNC:1884-1896)", async () => {
  await withTempDir(async (dir) => {
    const { remote, b, bCache } = await twoMachines(dir);
    await write(bCache, "mine", "b");
    await b.markDirty({ relPath: "mine" });

    assertEquals(await b.pullChanged(), 0);
    assertEquals(await b.pushChanged(), 1);
    assertEquals(remote.files().has("mine"), true);
  });
});

Deno.test("createInMemoryRemote: pins that a pull of a moved remote keeps the pending push (S3SYNC:1843-1877, 2792-2796, 2826-2851)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir);
    await write(bCache, "mine", "b");
    await b.markDirty({ relPath: "mine" });
    await write(aCache, "theirs", "a");
    await a.markDirty({ relPath: "theirs" });
    await a.pushChanged();

    await b.pullChanged();
    assertEquals(await b.pushChanged(), 1);
    assertEquals(remote.files().has("mine"), true);
  });
});

Deno.test("createInMemoryRemote: a scoped pull only touches the listed subdirs and keeps dirty state", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "config/x", "c");
    await write(aCache, "data/y", "d");
    await a.markDirty();
    await a.pushChanged();

    await write(bCache, "mine", "b");
    await b.markDirty({ relPath: "mine" });
    assertEquals(await b.pullChanged({ subdirs: ["config"] }), 1);
    assertEquals(await read(bCache, "data/y"), undefined);
    assertEquals(await b.pushChanged(), 1);
    assertEquals(remote.files().has("mine"), true);
  });
});

Deno.test("createInMemoryRemote: two-phase push is invisible to pulls until commit", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "f", "1");
    await a.markDirty({ relPath: "f" });

    const manifest = await a.preparePush();
    assertEquals(remote.files().size, 0);
    assertEquals(await b.pullChanged(), 0);

    assertEquals(await a.commitPush(manifest), 1);
    assertEquals(await b.pullChanged(), 1);
    assertEquals(await read(bCache, "f"), "1");
  });
});

Deno.test("createInMemoryRemote: prepare keeps dirty state, so a push without commit sends again", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "f", "1");
    await a.markDirty({ relPath: "f" });
    await a.preparePush();
    assertEquals(await a.pushChanged(), 1);
    assertEquals(remoteText(remote, "f"), "1");
  });
});

Deno.test("createInMemoryRemote: pins that commit clears marks made after prepare (S3SYNC:4051)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "first", "1");
    await a.markDirty({ relPath: "first" });
    const manifest = await a.preparePush();

    await write(aCache, "second", "2");
    await a.markDirty({ relPath: "second" });
    await a.commitPush(manifest);
    assertEquals(await a.pushChanged(), 0);
    assertEquals(remote.files().has("second"), false);
  });
});

Deno.test("createInMemoryRemote: injected prepare and commit failures leave the change pending", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "f", "1");
    await a.markDirty({ relPath: "f" });

    remote.failNext("prepare");
    await assertRejects(() => a.preparePush());
    const manifest = await a.preparePush();
    remote.failNext("commit");
    await assertRejects(() => a.commitPush(manifest));
    assertEquals(remote.files().size, 0);
    assertEquals(await a.commitPush(manifest), 1);
  });
});

Deno.test("createInMemoryRemote: pins that a push failing after its uploads loses the recorded deletes (S3SYNC:2911, 3305-3307)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "gone", "g");
    await a.markDirty({ relPath: "gone" });
    await a.pushChanged();

    await remove(aCache, "gone");
    await write(aCache, "new", "n");
    await a.markDirty({ relPath: "gone" });
    await a.markDirty({ relPath: "new" });
    remote.failNext("push", undefined, { afterUploads: true });
    await assertRejects(() => a.pushChanged());

    await a.pushChanged();
    assertEquals([...remote.files().keys()].sort(), ["gone", "new"]);
  });
});

Deno.test("createInMemoryRemote: failNext with an instance only fails that instance", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b } = await twoMachines(dir);
    remote.failNext("pull", new Error("b only"), { instance: "b" });
    assertEquals(await a.pullChanged(), 0);
    await assertRejects(() => b.pullChanged(), Error, "b only");
  });
});

Deno.test("createInMemoryRemote: offline rejects remote operations but still records marks", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "f", "1");
    remote.offline(true);
    await a.markDirty({ relPath: "f" });
    await assertRejects(() => a.pushChanged(), Error, "offline");
    await assertRejects(() => a.pullChanged(), Error, "offline");
    await assertRejects(() => a.preparePush(), Error, "offline");

    remote.offline(false);
    assertEquals(await a.pushChanged(), 1);
  });
});

Deno.test("createInMemoryRemote: internal cache files are never pushed but .log files are", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    for (
      const rel of [
        ".datastore-index.json",
        ".datastore-sync-state.json",
        "_index/shard-0.json",
        "_control/grants/x",
        "data/_catalog.db",
        "data/_catalog.db-wal",
        "data/.lock",
        "data/.namespace.json",
        "outputs/run-1.log",
      ]
    ) {
      await write(aCache, rel, "x");
    }
    await a.markDirty();
    await a.pushChanged();
    assertEquals([...remote.files().keys()], ["outputs/run-1.log"]);
  });
});

Deno.test("createInMemoryRemote: a path escaping the cache becomes a bulk mark", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "x", "1");
    await a.markDirty({ relPath: "x" });
    await a.pushChanged();

    await remove(aCache, "x");
    await a.markDirty({ relPath: "../models/probe.yaml" });
    await a.markDirty({ relPath: "x" });
    await a.pushChanged();
    assertEquals([...remote.files().keys()], ["x"]);
  });
});

Deno.test("createInMemoryRemote: the op log records each operation in order", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache } = await twoMachines(dir);
    await write(aCache, "f", "1");
    await a.markDirty({ relPath: "f" });
    await a.markDirty();
    await a.pushChanged();
    await b.pullChanged();

    assertEquals(remote.ops().slice(2), [
      { instance: "a", op: "markDirty", paths: ["f"], deleted: [] },
      { instance: "a", op: "markDirty", paths: [], deleted: [], bulk: true },
      { instance: "a", op: "push", paths: ["f"], deleted: [] },
      { instance: "b", op: "pull", paths: ["f"], deleted: [] },
    ]);
  });
});

Deno.test("createInMemoryRemote: capabilities default to two-phase only and can be overridden", () => {
  const remote = createInMemoryRemote();
  assertEquals(remote.connect("/cache").capabilities?.(), {
    twoPhaseSync: true,
  });
  const plain = createInMemoryRemote({ capabilities: {} });
  assertEquals(plain.connect("/cache").capabilities?.(), {});
});

Deno.test("createInMemoryRemote: passes the sync service conformance suite", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote();
    await assertSyncServiceConformance(remote.connect(dir));
  });
});

Deno.test("createInMemoryRemote: afterUploads still fails operations other than push", async () => {
  await withTempDir(async (dir) => {
    const { remote, a } = await twoMachines(dir);
    remote.failNext("pull", new Error("pull down"), { afterUploads: true });
    await assertRejects(() => a.pullChanged(), Error, "pull down");
  });
});

Deno.test("createInMemoryRemote: pins that a mark of the cache root uploads everything and deletes nothing (S3SYNC:3168-3171)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "gone", "g");
    await a.markDirty({ relPath: "gone" });
    await a.pushChanged();

    await remove(aCache, "gone");
    await write(aCache, "new", "n");
    await a.markDirty({ relPath: "." });
    assertEquals(await a.pushChanged(), 1);
    assertEquals([...remote.files().keys()].sort(), ["gone", "new"]);
  });
});

Deno.test({
  name:
    "createInMemoryRemote: pins that an absolute mark is nested under the cache, so its file is never pushed",
  // A drive-letter path nested under the cache is not a valid Windows path,
  // and the extensions' `/`-only containment check sends every Windows mark
  // to bulk anyway (swamp-club#2573), so this POSIX behaviour has no Windows
  // counterpart to pin.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const { remote, a, aCache } = await twoMachines(dir);
      await write(aCache, "f", "1");
      // join(cachePath, "/abs/...") nests the path, so the walk finds nothing.
      await a.markDirty({ relPath: join(aCache, "f") });
      assertEquals(await a.pushChanged(), 0);
      assertEquals(remote.files().size, 0);
    });
  },
});

Deno.test("createInMemoryRemote: a peer's commit between prepare and commit is still pulled afterwards", async () => {
  await withTempDir(async (dir) => {
    const { a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "x", "a");
    await a.markDirty({ relPath: "x" });
    const manifest = await a.preparePush();

    await write(bCache, "y", "b");
    await b.markDirty({ relPath: "y" });
    await b.pushChanged();
    await a.commitPush(manifest);

    assertEquals(await a.pullChanged(), 1);
    assertEquals(await read(aCache, "y"), "b");
  });
});

Deno.test("createInMemoryRemote: concurrent pushes from two machines each pull the other's file", async () => {
  await withTempDir(async (dir) => {
    const { a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "x", "a");
    await a.markDirty({ relPath: "x" });
    await write(bCache, "y", "b");
    await b.markDirty({ relPath: "y" });
    await Promise.all([a.pushChanged(), b.pushChanged()]);

    await a.pullChanged();
    await b.pullChanged();
    assertEquals(await read(aCache, "y"), "b");
    assertEquals(await read(bCache, "x"), "a");
  });
});

Deno.test("createInMemoryRemote: a clean push returns 0 offline and leaves an injected failure queued", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    remote.offline(true);
    assertEquals(await a.pushChanged(), 0);
    remote.offline(false);

    remote.failNext("push", new Error("later"), { afterUploads: true });
    assertEquals(await a.pushChanged(), 0);
    await write(aCache, "f", "1");
    await a.markDirty({ relPath: "f" });
    await assertRejects(() => a.pushChanged(), Error, "later");
  });
});

Deno.test("createInMemoryRemote: pins that a peer's commit during a bulk two-phase push is skipped by the next pull (S3SYNC:4015-4026, 4333-4361)", async () => {
  await withTempDir(async (dir) => {
    const { a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "x", "a");
    await a.markDirty();
    const manifest = await a.preparePush();

    await write(bCache, "y", "b");
    await b.markDirty({ relPath: "y" });
    await b.pushChanged();
    await a.commitPush(manifest);

    // A's index holds only what it read at prepare plus its own upload, so
    // the fast path arms at the new sequence and B's file never arrives.
    assertEquals(await a.pullChanged(), 0);
    assertEquals(await read(aCache, "y"), undefined);
  });
});

Deno.test("pendingPush: reports the next push's uploads, deletes and marks without side effects", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "gone", "g");
    await write(aCache, "same", "s");
    await a.markDirty({ relPath: "gone" });
    await a.markDirty({ relPath: "same" });
    await a.pushChanged();
    assertEquals(await remote.pendingPush(aCache), {
      uploads: [],
      deletes: [],
      marked: [],
      bulk: false,
    });

    await remove(aCache, "gone");
    await write(aCache, "new", "n");
    await a.markDirty({ relPath: "gone" });
    await a.markDirty({ relPath: "new" });
    await a.markDirty({ relPath: "same" });
    const opCount = remote.ops().length;
    remote.failNext("push", new Error("still queued"));
    remote.offline(true);
    const pending = await remote.pendingPush(aCache);
    remote.offline(false);

    assertEquals(pending, {
      uploads: ["new"],
      deletes: ["gone"],
      marked: ["gone", "new", "same"],
      bulk: false,
    });
    assertEquals(remote.ops().length, opCount, "no op recorded");
    assertEquals([...remote.files().keys()].sort(), ["gone", "same"]);
    // The injected failure was not consumed, and the plan matches the push.
    await assertRejects(() => a.pushChanged(), Error, "still queued");
    await a.pushChanged();
    assertEquals(remote.ops().at(-1)?.paths, pending.uploads);
    assertEquals(remote.ops().at(-1)?.deleted, pending.deletes);
  });
});

Deno.test("pendingPush: shows the bulk flag and lost deletes after a push fails past its uploads", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, aCache } = await twoMachines(dir);
    await write(aCache, "gone", "g");
    await a.markDirty({ relPath: "gone" });
    await a.pushChanged();

    await remove(aCache, "gone");
    await write(aCache, "new", "n");
    await a.markDirty({ relPath: "gone" });
    await a.markDirty({ relPath: "new" });
    remote.failNext("push", undefined, { afterUploads: true });
    await assertRejects(() => a.pushChanged());

    assertEquals(await remote.pendingPush(aCache), {
      uploads: ["new"],
      deletes: [],
      marked: ["gone", "new"],
      bulk: true,
    });
  });
});

Deno.test("pendingPush: a cache with no sidecar plans a full walk that deletes nothing", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote();
    const cache = join(dir, "c");
    await write(cache, "x", "1");
    await write(cache, ".datastore-index.json", "{}");
    assertEquals(await remote.pendingPush(cache), {
      uploads: ["x"],
      deletes: [],
      marked: [],
      bulk: false,
    });
    assertEquals(remote.ops(), []);
  });
});

Deno.test("fetchContent: returns the committed bytes and null for a key the remote lacks", async () => {
  await withTempDir(async (dir) => {
    const { a, b, aCache } = await twoMachines(dir);
    await write(aCache, "data/m/raw", "v1");
    await a.markDirty({ relPath: "data/m/raw" });
    await a.pushChanged();

    const fetched = await b.fetchContent!("data/m/raw");
    assertEquals(fetched && new TextDecoder().decode(fetched), "v1");
    assertEquals(await b.fetchContent!("data/m/missing"), null);
  });
});

Deno.test("fetchContent: writes nothing to the cache and keeps a pending push", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "data/m/raw", "remote");
    await a.markDirty({ relPath: "data/m/raw" });
    await a.pushChanged();

    await b.fetchContent!("data/m/raw");
    assertEquals(await read(bCache, "data/m/raw"), undefined);

    await write(bCache, "data/m/raw", "local");
    await b.markDirty({ relPath: "data/m/raw" });
    const pending = await remote.pendingPush(bCache);
    const fetched = await b.fetchContent!("data/m/raw");

    assertEquals(fetched && new TextDecoder().decode(fetched), "remote");
    assertEquals(await read(bCache, "data/m/raw"), "local");
    assertEquals(await remote.pendingPush(bCache), pending);
  });
});

Deno.test("fetchContent: reads an uncommitted prepare's file only after the commit", async () => {
  await withTempDir(async (dir) => {
    const { a, b, aCache } = await twoMachines(dir);
    await write(aCache, "data/m/raw", "v1");
    await a.markDirty({ relPath: "data/m/raw" });
    const manifest = await a.preparePush();

    assertEquals(await b.fetchContent!("data/m/raw"), null);
    await a.commitPush(manifest);
    const fetched = await b.fetchContent!("data/m/raw");
    assertEquals(fetched && new TextDecoder().decode(fetched), "v1");
  });
});

Deno.test("fetchContent: returns a copy the caller may change", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache } = await twoMachines(dir);
    await write(aCache, "data/m/raw", "v1");
    await a.markDirty({ relPath: "data/m/raw" });
    await a.pushChanged();

    const fetched = await b.fetchContent!("data/m/raw");
    fetched!.fill(0);
    assertEquals(remoteText(remote, "data/m/raw"), "v1");
  });
});

Deno.test("fetchContent: records a fetch op with the normalized path", async () => {
  await withTempDir(async (dir) => {
    const { remote, b } = await twoMachines(dir);
    await b.fetchContent!("./data//m/raw");
    assertEquals(remote.ops().at(-1), {
      instance: "b",
      op: "fetch",
      paths: ["data/m/raw"],
      deleted: [],
    });
  });
});

Deno.test("fetchContent: rejects a path that is absolute or has a dot-dot segment", async () => {
  await withTempDir(async (dir) => {
    const { remote, b } = await twoMachines(dir);
    const before = remote.ops().length;
    for (
      const relPath of [
        "../outside",
        "data/../raw",
        "data\\..\\raw",
        "/data/raw",
        "\\data\\raw",
        "C:/data/raw",
      ]
    ) {
      await assertRejects(
        () => b.fetchContent!(relPath),
        Error,
        "Path traversal rejected",
      );
    }
    assertEquals(remote.ops().length, before);
  });
});

Deno.test("fetchContent: rejects while offline and on an injected fetch failure", async () => {
  await withTempDir(async (dir) => {
    const { remote, b } = await twoMachines(dir);
    remote.offline(true);
    await assertRejects(() => b.fetchContent!("data/m/raw"), Error, "offline");
    remote.offline(false);

    remote.failNext("fetch", new Error("fetch broke"));
    await assertRejects(
      () => b.fetchContent!("data/m/raw"),
      Error,
      "fetch broke",
    );
    assertEquals(await b.fetchContent!("data/m/raw"), null);
  });
});

Deno.test("fetchContent: is absent when the connect option turns it off", async () => {
  await withTempDir((dir) => {
    const remote = createInMemoryRemote();
    const without = remote.connect(join(dir, "c"), { fetchContent: false });
    assertEquals(without.fetchContent, undefined);
    assertEquals(
      typeof remote.connect(join(dir, "d")).fetchContent,
      "function",
    );
    return Promise.resolve();
  });
});

Deno.test("fetchContent: reads a name with a colon that is not a drive letter path", async () => {
  await withTempDir(async (dir) => {
    const { b } = await twoMachines(dir);
    assertEquals(await b.fetchContent!("a:b/raw"), null);
  });
});

Deno.test("createInMemoryRemote: pins that a service keeps the namespace of its first pull or push (S3SYNC:668-686)", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote();
    const solo = remote.connect(join(dir, "solo"));
    await solo.pullChanged();
    await assertRejects(
      () => solo.pushChanged({ namespace: "team" }),
      Error,
      'Namespace mismatch: bound to undefined but called with "team"',
    );
    await assertRejects(
      () => solo.preparePush({ namespace: "team" }),
      Error,
      "Namespace mismatch",
    );
    assertEquals(await solo.pullChanged(), 0);

    const team = remote.connect(join(dir, "team"));
    await team.pushChanged({ namespace: "team" });
    await assertRejects(
      () => team.pullChanged(),
      Error,
      'Namespace mismatch: bound to "team" but called with undefined',
    );
    assertEquals(await team.pullChanged({ namespace: "team" }), 0);
    // markDirty and fetchContent take no part in the binding.
    await team.markDirty({ relPath: "x", namespace: "other" });
    assertEquals(await team.fetchContent!("x", { namespace: "other" }), null);
  });
});

Deno.test("createInMemoryRemote: an empty namespace and an unset one are the same binding", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote();
    const empty = remote.connect(join(dir, "empty"));
    await empty.pullChanged({ namespace: "" });
    assertEquals(await empty.pushChanged(), 0);

    const unset = remote.connect(join(dir, "unset"));
    await unset.pullChanged();
    assertEquals(await unset.pushChanged({ namespace: "" }), 0);
    await assertRejects(
      () => unset.pullChanged({ namespace: "team" }),
      Error,
      'Namespace mismatch: bound to undefined but called with "team"',
    );
  });
});

Deno.test("createInMemoryRemote: pins that a pull, push or prepare that fails still binds its namespace (S3SYNC:2432-2434, 2985-2987, 3526-3528)", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote();
    remote.offline(true);
    const pulled = remote.connect(join(dir, "pulled"));
    await assertRejects(
      () => pulled.pullChanged({ namespace: "team" }),
      Error,
      "offline",
    );
    const pushed = remote.connect(join(dir, "pushed"));
    await write(join(dir, "pushed"), "x", "1");
    await assertRejects(
      () => pushed.pushChanged({ namespace: "team" }),
      Error,
      "offline",
    );
    const prepared = remote.connect(join(dir, "prepared"));
    await write(join(dir, "prepared"), "x", "1");
    await assertRejects(
      () => prepared.preparePush({ namespace: "team" }),
      Error,
      "offline",
    );
    remote.offline(false);

    for (const service of [pulled, pushed, prepared]) {
      await assertRejects(
        () => service.pullChanged(),
        Error,
        'Namespace mismatch: bound to "team" but called with undefined',
      );
      await service.pullChanged({ namespace: "team" });
    }
  });
});

/** A and B both synced to `files`, pushed by A and pulled by B. */
async function syncedPair(
  dir: string,
  files: Record<string, string>,
  options?: Parameters<typeof createInMemoryRemote>[0],
) {
  const machines = await twoMachines(dir, options);
  for (const [rel, text] of Object.entries(files)) {
    await write(machines.aCache, rel, text);
    await machines.a.markDirty({ relPath: rel });
  }
  await machines.a.pushChanged();
  await machines.b.pullChanged();
  return machines;
}

/** A deletes `rels` and pushes the deletions. */
async function peerDeletes(
  machines: Awaited<ReturnType<typeof twoMachines>>,
  rels: string[],
): Promise<void> {
  for (const rel of rels) {
    await remove(machines.aCache, rel);
    await machines.a.markDirty({ relPath: rel });
  }
  await machines.a.pushChanged();
}

async function exists(cache: string, rel: string): Promise<boolean> {
  try {
    await Deno.stat(join(cache, ...rel.split("/")));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("createInMemoryRemote: pins that a pull removes an unchanged file a peer deleted and leaves it out of its count (S3SYNC:2537-2543, 2875)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", keep: "k" });
    const { remote, b, bCache } = machines;
    await peerDeletes(machines, ["f"]);

    assertEquals(await b.pullChanged(), 0);
    assertEquals(await read(bCache, "f"), undefined);
    assertEquals(await read(bCache, "keep"), "k");
    assertEquals(remote.ops().at(-1), {
      instance: "b",
      op: "pull",
      paths: [],
      deleted: ["f"],
    });
  });
});

Deno.test("createInMemoryRemote: a pull keeps a peer-deleted file that changed or is marked locally (S3SYNC:4260-4301)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, {
      changed: "1",
      marked: "2",
      keep: "k",
    });
    const { b, bCache } = machines;
    await write(bCache, "changed", "local edit");
    await b.markDirty({ relPath: "marked" });
    await peerDeletes(machines, ["changed", "marked"]);

    await b.pullChanged();
    assertEquals(await read(bCache, "changed"), "local edit");
    assertEquals(await read(bCache, "marked"), "2");
  });
});

Deno.test("createInMemoryRemote: pins that a pull removes nothing when no committed key is left (S3SYNC:4197-4214)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1" });
    await peerDeletes(machines, ["f"]);

    assertEquals(await machines.b.pullChanged(), 0);
    assertEquals(await read(machines.bCache, "f"), "1");
  });
});

Deno.test("createInMemoryRemote: a first pull removes nothing, having no last sync to compare with", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote();
    const aCache = join(dir, "a");
    const cCache = join(dir, "c");
    const a = remote.connect(aCache, { instance: "a" });
    await write(aCache, "keep", "k");
    await a.markDirty({ relPath: "keep" });
    await a.pushChanged();

    await write(cCache, "local", "l");
    const c = remote.connect(cCache, { instance: "c" });
    assertEquals(await c.pullChanged(), 1);
    assertEquals(await read(cCache, "local"), "l");
  });
});

Deno.test("createInMemoryRemote: a lost sidecar keeps the last sync, so the next pull still removes peer deletes", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", keep: "k" });
    machines.remote.resetSidecar(machines.bCache);
    await peerDeletes(machines, ["f"]);

    await machines.b.pullChanged();
    assertEquals(await read(machines.bCache, "f"), undefined);
  });
});

Deno.test("createInMemoryRemote: pins that a subdir-scoped pull removes peer deletes outside its subdirs (S3SYNC:2537-2539)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, {
      "config/x": "c",
      "data/y": "d",
    });
    await peerDeletes(machines, ["data/y"]);

    await machines.b.pullChanged({ subdirs: ["config"] });
    assertEquals(await read(machines.bCache, "data/y"), undefined);
  });
});

Deno.test("createInMemoryRemote: pins that a pull removes the directories a removal empties, up to the top level (S3SYNC:4310-4324)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, {
      "data/t/m/v/raw": "1",
      keep: "k",
    });
    await peerDeletes(machines, ["data/t/m/v/raw"]);

    await machines.b.pullChanged();
    assertEquals(await exists(machines.bCache, "data/t"), false);
    assertEquals(await exists(machines.bCache, "data"), true);
  });
});

Deno.test("createInMemoryRemote: pins that a bulk push removes a peer-deleted file instead of uploading it again (S3SYNC:3103-3109)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", keep: "k" });
    const { remote, b, bCache } = machines;
    await peerDeletes(machines, ["f"]);

    await b.markDirty();
    await b.pushChanged();
    assertEquals(remote.files().has("f"), false);
    assertEquals(await read(bCache, "f"), undefined);
    assertEquals(remote.ops().at(-1)?.removed, ["f"]);
  });
});

Deno.test("createInMemoryRemote: pins that a bulk push uploads a peer-deleted file again with extensions 2026.10.01.1 and earlier (swamp-club#2999)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", keep: "k" }, {
      semantics: EXTENSION_2026_10_01_SEMANTICS,
    });
    await peerDeletes(machines, ["f"]);

    await machines.b.markDirty();
    await machines.b.pushChanged();
    assertEquals(remoteText(machines.remote, "f"), "1");
  });
});

Deno.test("createInMemoryRemote: pins that preparePush removes peer deletes and commitPush does not (S3SYNC:3635-3641)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", g: "2", keep: "k" });
    const { remote, b, bCache } = machines;
    await peerDeletes(machines, ["f"]);

    await b.markDirty();
    const manifest = await b.preparePush();
    assertEquals(await read(bCache, "f"), undefined);
    assertEquals(remote.ops().at(-1)?.removed, ["f"]);

    await peerDeletes(machines, ["g"]);
    await b.commitPush(manifest);
    assertEquals(await read(bCache, "g"), "2");
    assertEquals(remote.ops().at(-1)?.removed, undefined);
  });
});

Deno.test("createInMemoryRemote: pins that a clean push removes nothing, taking the fast path (S3SYNC:1945-1954)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", keep: "k" });
    await peerDeletes(machines, ["f"]);

    assertEquals(await machines.b.pushChanged(), 0);
    assertEquals(await read(machines.bCache, "f"), "1");
  });
});

Deno.test("createInMemoryRemote: pins that a scoped push reconciles only the shards its marks read (S3SYNC:1548-1610, 4174-4182)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, {
      "data/t/m1/a": "1",
      "data/t/m1/b": "2",
      "data/t/m2/c": "3",
      "data/t/m2/d": "4",
    });
    const { b, bCache } = machines;
    await peerDeletes(machines, ["data/t/m1/b", "data/t/m2/c"]);

    await write(bCache, "data/t/m1/a", "edited");
    await b.markDirty({ relPath: "data/t/m1/a" });
    await b.pushChanged();
    assertEquals(await read(bCache, "data/t/m1/b"), undefined);
    assertEquals(await read(bCache, "data/t/m2/c"), "3");
  });
});

Deno.test("createInMemoryRemote: pins that a marked directory reads every shard below it (S3SYNC:1590-1606)", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, {
      "data/t/m1/a": "1",
      "data/t/m1/b": "2",
      "data/t/m2/c": "3",
      "data/t/m2/d": "4",
    });
    const { b, bCache } = machines;
    await peerDeletes(machines, ["data/t/m1/b", "data/t/m2/c"]);

    await b.markDirty({ relPath: "data/t" });
    await b.pushChanged();
    assertEquals(await read(bCache, "data/t/m1/b"), undefined);
    assertEquals(await read(bCache, "data/t/m2/c"), undefined);
  });
});

Deno.test("createInMemoryRemote: a full push records the whole remote as synced, a scoped push only its own changes (S3SYNC:2289-2344)", async () => {
  for (const scoped of [false, true]) {
    await withTempDir(async (dir) => {
      const { remote, a, b, aCache, bCache } = await twoMachines(dir);
      await write(aCache, "peer", "same");
      await write(aCache, "keep", "k");
      await a.markDirty({ relPath: "peer" });
      await a.markDirty({ relPath: "keep" });
      await a.pushChanged();

      // B holds the same bytes without having pulled them.
      await write(bCache, "peer", "same");
      await write(bCache, "own", "o");
      if (scoped) await b.markDirty({ relPath: "own" });
      else await b.markDirty();
      await b.pushChanged();
      assertEquals(remoteText(remote, "own"), "o");

      await remove(aCache, "peer");
      await a.markDirty({ relPath: "peer" });
      await a.pushChanged();
      await b.pullChanged();
      assertEquals(
        await read(bCache, "peer"),
        scoped ? "same" : undefined,
        scoped ? "scoped" : "full",
      );
    });
  }
});

Deno.test("createInMemoryRemote: pins that a pull of a moved remote keeps the pending push with extensions 2026.10.01.1 (swamp-club#2888)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir, {
      semantics: EXTENSION_2026_10_01_SEMANTICS,
    });
    await write(bCache, "mine", "b");
    await b.markDirty({ relPath: "mine" });
    await write(aCache, "theirs", "a");
    await a.markDirty({ relPath: "theirs" });
    await a.pushChanged();

    await b.pullChanged();
    assertEquals(await b.pushChanged(), 1);
    assertEquals(remote.files().has("mine"), true);
  });
});

Deno.test("createInMemoryRemote: pullDeletes decides what a pull removes, counting it, while pushes still remove peer deletes", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", keep: "k" }, {
      semantics: { pullDeletes: true },
    });
    await peerDeletes(machines, ["f"]);
    assertEquals(await machines.b.pullChanged(), 1);
    assertEquals(await read(machines.bCache, "f"), undefined);
  });
});

Deno.test("createInMemoryRemote: pendingPush leaves out a copy the push removes before it walks", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", keep: "k" });
    const { remote, b, bCache } = machines;
    await peerDeletes(machines, ["f"]);
    await write(bCache, "new", "n");
    await b.markDirty();

    const pending = await remote.pendingPush(bCache);
    assertEquals(pending.uploads, ["new"]);
    assertEquals(await read(bCache, "f"), "1", "pendingPush removes nothing");
    await b.pushChanged();
    assertEquals(remote.ops().at(-1)?.paths, pending.uploads);
  });
});

Deno.test("createInMemoryRemote: a push after a lost sidecar still removes peer deletes before its full walk", async () => {
  await withTempDir(async (dir) => {
    const machines = await syncedPair(dir, { f: "1", keep: "k" });
    const { remote, b, bCache } = machines;
    await peerDeletes(machines, ["f"]);
    remote.resetSidecar(bCache);

    await b.pushChanged();
    assertEquals(remote.files().has("f"), false);
    assertEquals(await read(bCache, "f"), undefined);
  });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) =>
  data === null ? null : new TextDecoder().decode(data);

Deno.test("createInMemoryRemote: without controlPlane, services have no control-plane store and unchanged capabilities", () => {
  const service = createInMemoryRemote().connect("/cache/a");
  assertEquals(service.controlPlaneStore, undefined);
  assertEquals(service.capabilities?.(), { twoPhaseSync: true });
});

Deno.test("createInMemoryRemote: the control-plane store passes the conformance suite", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  assertEquals(remote.connect("/c").capabilities?.(), {
    twoPhaseSync: true,
    controlPlane: true,
  });
  await assertControlPlaneStoreConformance(() =>
    remote.connect("/cache/conformance").controlPlaneStore!()
  );
});

Deno.test("createInMemoryRemote: a service that has not pulled reads datastore-wide control records", async () => {
  await withTempDir(async (dir) => {
    const remote = createInMemoryRemote({ controlPlane: true });
    remote.seedControlPlane("datastore-format", bytes("root"));
    remote.seedControlPlane("datastore-format", bytes("ns"), {
      namespace: "infra",
    });

    const fresh = remote.connect(join(dir, "fresh"));
    assertEquals(
      text(await fresh.controlPlaneStore!().get("datastore-format")),
      "root",
    );
    // The first control-plane call bound no namespace, so a namespaced
    // pull on the same service is refused, as in the extensions.
    await assertRejects(
      () => fresh.pullChanged({ namespace: "infra" }),
      Error,
      "Namespace mismatch",
    );

    const bound = remote.connect(join(dir, "bound"));
    await bound.pullChanged({ namespace: "infra" });
    assertEquals(
      text(await bound.controlPlaneStore!().get("datastore-format")),
      "ns",
    );
  });
});

Deno.test("createInMemoryRemote: control-plane writes are recorded and listed by full key; reads are not", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  const store = remote.connect("/cache/a", { instance: "a" })
    .controlPlaneStore!();
  await store.get("missing");
  assertEquals(remote.ops(), []);

  await store.put("heartbeats/1", bytes("x"));
  assertEquals(await store.putIfAbsent!("heartbeats/1", bytes("y")), false);
  await store.delete("heartbeats/1");
  assertEquals(remote.ops(), [
    {
      instance: "a",
      op: "controlPlane",
      paths: ["_control/heartbeats/1"],
      deleted: [],
    },
    {
      instance: "a",
      op: "controlPlane",
      paths: [],
      deleted: ["_control/heartbeats/1"],
    },
  ]);
  assertEquals([...remote.controlPlaneRecords().keys()], []);
});

Deno.test("createInMemoryRemote: control-plane calls fail while offline and on an injected failure", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  const store = remote.connect("/cache/a").controlPlaneStore!();
  remote.failNext("controlPlane", new Error("boom"));
  await assertRejects(() => store.get("k"), Error, "boom");
  remote.offline(true);
  await assertRejects(() => store.get("k"), Error, "offline");
  remote.offline(false);
  assertEquals(await store.get("k"), null);
});

Deno.test("createInMemoryRemote: counts connections and lists every control-plane read, failed ones too", async () => {
  const remote = createInMemoryRemote({ controlPlane: true });
  assertEquals(remote.connections(), 0);
  const solo = remote.connect("/cache/a", { instance: "a" })
    .controlPlaneStore!();
  const team = remote.connect("/cache/b", { instance: "b" });
  await team.pullChanged({ namespace: "team" });
  assertEquals(remote.connections(), 2);

  await solo.get("datastore-format");
  remote.failNext("controlPlane", new Error("boom"));
  await assertRejects(() => team.controlPlaneStore!().get("k"), Error, "boom");
  assertEquals(remote.controlPlaneReads(), [
    { instance: "a", key: "_control/datastore-format" },
    { instance: "b", key: "team/_control/k" },
  ]);
  assertEquals(remote.ops().filter((op) => op.op === "controlPlane"), []);
});

Deno.test("createInMemoryRemote: seedControlPlane needs the controlPlane option", () => {
  assertThrows(
    () => createInMemoryRemote().seedControlPlane("k", bytes("x")),
    Error,
    "controlPlane option",
  );
});
