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
// swamp-extensions@5368cb002:datastore/s3/extensions/datastores/_lib/s3_cache_sync.ts.
// Each "pins" test asserts today's extension behaviour, including the gaps,
// so a change to the fake's semantics fails here on purpose.

import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import { createInMemoryRemote } from "./in_memory_remote.ts";
import { assertSyncServiceConformance } from "./datastore_conformance.ts";

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

Deno.test("createInMemoryRemote: pins that a bulk mark uploads everything and deletes nothing (S3SYNC:3095-3165)", async () => {
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

Deno.test("createInMemoryRemote: pins that path marks after a bulk mark are dropped (S3SYNC:1752)", async () => {
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

Deno.test("createInMemoryRemote: pins that an overflowed dirty set deletes on its full walk (S3SYNC:1775-1782, 3148-3159)", async () => {
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

Deno.test("createInMemoryRemote: pins that a write that was never marked is never pushed (S3SYNC:1913-1922)", async () => {
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

Deno.test("createInMemoryRemote: pins that a pull never deletes local files by default (S3SYNC:2555-2561)", async () => {
  await withTempDir(async (dir) => {
    const { a, b, aCache, bCache } = await twoMachines(dir);
    await write(aCache, "f", "1");
    await a.markDirty({ relPath: "f" });
    await a.pushChanged();
    await b.pullChanged();

    await remove(aCache, "f");
    await a.markDirty({ relPath: "f" });
    await a.pushChanged();
    assertEquals(await b.pullChanged(), 0);
    assertEquals(await read(bCache, "f"), "1");
  });
});

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

Deno.test("createInMemoryRemote: pins that a pull overwrites a locally dirty file (S3SYNC:2312-2316)", async () => {
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

Deno.test("createInMemoryRemote: pins that a pull of a moved remote drops the pending push (S3SYNC:2742, 2759)", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir);
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

Deno.test("createInMemoryRemote: a pull of an unchanged remote keeps the pending push (S3SYNC:1852-1864)", async () => {
  await withTempDir(async (dir) => {
    const { remote, b, bCache } = await twoMachines(dir);
    await write(bCache, "mine", "b");
    await b.markDirty({ relPath: "mine" });

    assertEquals(await b.pullChanged(), 0);
    assertEquals(await b.pushChanged(), 1);
    assertEquals(remote.files().has("mine"), true);
  });
});

Deno.test("createInMemoryRemote: pullClearsPendingPush false keeps the pending push across a pull", async () => {
  await withTempDir(async (dir) => {
    const { remote, a, b, aCache, bCache } = await twoMachines(dir, {
      semantics: { pullClearsPendingPush: false },
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

Deno.test("createInMemoryRemote: pins that commit clears marks made after prepare (S3SYNC:3918)", async () => {
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

Deno.test("createInMemoryRemote: pins that a push failing after its uploads loses the recorded deletes (S3SYNC:2822, 3194-3196)", async () => {
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
