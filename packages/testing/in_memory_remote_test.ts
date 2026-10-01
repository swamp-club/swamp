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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs/ensure-dir";
import { dirname, join } from "@std/path";
import { createInMemoryRemote } from "./in_memory_remote.ts";

async function withCaches(
  fn: (cacheA: string, cacheB: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    const cacheA = join(root, "a");
    const cacheB = join(root, "b");
    await ensureDir(cacheA);
    await ensureDir(cacheB);
    await fn(cacheA, cacheB);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
}

async function writeCache(
  cacheDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  const absPath = join(cacheDir, relPath);
  await ensureDir(dirname(absPath));
  await Deno.writeTextFile(absPath, content);
}

async function readCache(
  cacheDir: string,
  relPath: string,
): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(join(cacheDir, relPath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

function remoteText(
  remote: ReturnType<typeof createInMemoryRemote>,
  relPath: string,
): string | undefined {
  const bytes = remote.read(relPath);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

Deno.test("createInMemoryRemote: a pushed file round-trips to another instance", async () => {
  await withCaches(async (cacheA, cacheB) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA, { instance: "a" });
    const b = remote.connect(cacheB, { instance: "b" });

    await a.markDirty({ relPath: "data/x" });
    await writeCache(cacheA, "data/x", "hello");
    assertEquals(await a.pushChanged(), 1);
    assertEquals(remoteText(remote, "data/x"), "hello");
    assertEquals(a.dirtyPaths(), []);

    assertEquals(await b.pullChanged(), 1);
    assertEquals(await readCache(cacheB, "data/x"), "hello");
    assertEquals(await b.pullChanged(), 0);
  });
});

Deno.test("createInMemoryRemote: a marked path absent on disk is deleted remotely", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    await writeCache(cacheA, "data/x", "hello");
    await a.markDirty({ relPath: "data/x" });
    await a.pushChanged();

    await a.markDirty({ relPath: "data/x" });
    await Deno.remove(join(cacheA, "data/x"));
    assertEquals(await a.pushChanged(), 1);
    assertEquals(remote.read("data/x"), undefined);
  });
});

Deno.test("createInMemoryRemote: pullDeletes false leaves a peer-deleted file on disk", async () => {
  await withCaches(async (cacheA, cacheB) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    const b = remote.connect(cacheB);
    await writeCache(cacheA, "data/x", "hello");
    await a.markDirty({ relPath: "data/x" });
    await a.pushChanged();
    await b.pullChanged();

    await Deno.remove(join(cacheA, "data/x"));
    await a.markDirty({ relPath: "data/x" });
    await a.pushChanged();

    // Today's S3 and GCS behaviour: the pull forgets the path but keeps the file.
    assertEquals(await b.pullChanged(), 0);
    assertEquals(await readCache(cacheB, "data/x"), "hello");

    // Forgotten, so a later full walk uploads it again.
    await b.markDirty();
    assertEquals(await b.pushChanged(), 1);
    assertEquals(remoteText(remote, "data/x"), "hello");
  });
});

Deno.test("createInMemoryRemote: pullDeletes true removes a peer-deleted file unless it is dirty", async () => {
  await withCaches(async (cacheA, cacheB) => {
    const remote = createInMemoryRemote({ pullDeletes: true });
    const a = remote.connect(cacheA);
    const b = remote.connect(cacheB);
    await writeCache(cacheA, "data/x", "x");
    await writeCache(cacheA, "data/y", "y");
    await a.markDirty({ relPath: "data" });
    await a.pushChanged();
    await b.pullChanged();

    await Deno.remove(join(cacheA, "data"), { recursive: true });
    await a.markDirty({ relPath: "data" });
    assertEquals(await a.pushChanged(), 2);

    await b.markDirty({ relPath: "data/y" });
    assertEquals(await b.pullChanged(), 1);
    assertEquals(await readCache(cacheB, "data/x"), undefined);
    assertEquals(await readCache(cacheB, "data/y"), "y");
  });
});

Deno.test("createInMemoryRemote: a marked directory pushes its files and deletes its removed files", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    await writeCache(cacheA, "data/m/one/raw", "1");
    await writeCache(cacheA, "data/m/one/metadata.yaml", "meta");
    await a.markDirty({ relPath: "data/m/one" });
    assertEquals(await a.pushChanged(), 2);

    await Deno.remove(join(cacheA, "data/m/one/raw"));
    await a.markDirty({ relPath: "data/m/one" });
    assertEquals(await a.pushChanged(), 1);
    assertEquals([...remote.files().keys()], ["data/m/one/metadata.yaml"]);

    await Deno.remove(join(cacheA, "data/m/one"), { recursive: true });
    await a.markDirty({ relPath: "data/m/one" });
    assertEquals(await a.pushChanged(), 1);
    assertEquals(remote.files().size, 0);
  });
});

Deno.test("createInMemoryRemote: a push never deletes a peer's file it has not synced", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    remote.write("data/m/peer", "from a peer");

    await writeCache(cacheA, "data/m/mine", "mine");
    await a.markDirty({ relPath: "data/m" });
    await a.pushChanged();
    await a.markDirty({ relPath: "data/m/peer" });
    await a.markDirty();
    await a.pushChanged();

    assertEquals(remoteText(remote, "data/m/peer"), "from a peer");
    assertEquals(remoteText(remote, "data/m/mine"), "mine");
  });
});

Deno.test("createInMemoryRemote: pull skips files under a marked directory and runs while bulk is set", async () => {
  await withCaches(async (_cacheA, cacheB) => {
    const remote = createInMemoryRemote();
    const b = remote.connect(cacheB);
    remote.write("data/m/x", "remote x");
    remote.write("data/other", "remote other");

    await b.markDirty({ relPath: "data/m" });
    await b.markDirty();
    assertEquals(await b.pullChanged(), 1);
    assertEquals(await readCache(cacheB, "data/m/x"), undefined);
    assertEquals(await readCache(cacheB, "data/other"), "remote other");
  });
});

Deno.test("createInMemoryRemote: pull does not overwrite a clean local edit while the remote is unchanged", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    remote.write("data/x", "v1");
    await a.pullChanged();

    await writeCache(cacheA, "data/x", "local edit");
    assertEquals(await a.pullChanged(), 0);
    assertEquals(await readCache(cacheA, "data/x"), "local edit");

    remote.write("data/x", "v2");
    assertEquals(await a.pullChanged(), 1);
    assertEquals(await readCache(cacheA, "data/x"), "v2");
  });
});

Deno.test("createInMemoryRemote: internal cache files never cross the sync boundary", async () => {
  await withCaches(async (cacheA, cacheB) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    const b = remote.connect(cacheB);
    await writeCache(cacheA, "data/_catalog.db", "sqlite");
    await writeCache(cacheA, "data/_catalog.db-wal", "wal");
    await writeCache(cacheA, "data/m/.lock", "lock");
    await writeCache(cacheA, ".datastore-sync-state.json", "{}");
    await writeCache(cacheA, "_index/shard", "index");
    await writeCache(cacheA, "data/m/raw", "content");

    await a.markDirty({ relPath: "data/_catalog.db" });
    await a.markDirty();
    assertEquals(await a.pushChanged(), 1);
    assertEquals([...remote.files().keys()], ["data/m/raw"]);

    remote.write("data/_catalog.db", "foreign catalog");
    await writeCache(cacheB, "data/_catalog.db", "own catalog");
    await b.pullChanged();
    assertEquals(await readCache(cacheB, "data/_catalog.db"), "own catalog");
  });
});

Deno.test("createInMemoryRemote: relPaths that are not cache-relative are recorded and never pushed", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    const bad = ["../outside", "/abs/path", "data\\x", ""];
    for (const relPath of bad) await a.markDirty({ relPath });

    assertEquals(a.violations(), bad);
    assertEquals(a.marks(), bad);
    assertEquals(a.dirtyPaths(), []);
    assertEquals(await a.pushChanged(), 0);
  });
});

Deno.test("createInMemoryRemote: a failed push keeps the path dirty and the next push succeeds", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    await writeCache(cacheA, "data/x", "hello");
    await a.markDirty({ relPath: "data/x" });

    a.failNext("push", new Error("boom"));
    await assertRejects(() => a.pushChanged(), Error, "boom");
    assertEquals(a.dirtyPaths(), ["data/x"]);
    assertEquals(remote.files().size, 0);
    assertEquals(remote.ops(), []);

    assertEquals(await a.pushChanged(), 1);
    assertEquals(a.dirtyPaths(), []);
  });
});

Deno.test("createInMemoryRemote: a bare mark walks the cache, uploads and deletes, then clears", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    await writeCache(cacheA, "data/x", "x");
    await writeCache(cacheA, "data/y", "y");
    await a.markDirty();
    assert(a.isBulkDirty());
    assertEquals(await a.pushChanged(), 2);
    assert(!a.isBulkDirty());

    await Deno.remove(join(cacheA, "data/x"));
    await writeCache(cacheA, "data/z", "z");
    // Rule 8: the bare mark overrides the per-path mark from the same operation.
    await a.markDirty({ relPath: "data/z" });
    await a.markDirty();
    assertEquals(await a.pushChanged(), 2);
    assertEquals([...remote.files().keys()].sort(), ["data/y", "data/z"]);
  });
});

Deno.test("createInMemoryRemote: a mark made while a push runs survives the push", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    await writeCache(cacheA, "data/x", "x");
    await a.markDirty({ relPath: "data/x" });

    const push = a.pushChanged();
    await a.markDirty({ relPath: "data/x" });
    await push;
    assertEquals(a.dirtyPaths(), ["data/x"]);
  });
});

Deno.test("createInMemoryRemote: prepare stages without changes and commit applies and clears", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    await writeCache(cacheA, "data/x", "x");
    await a.markDirty({ relPath: "data/x" });

    const manifest = await a.preparePush();
    assertEquals(remote.files().size, 0);
    assertEquals(a.dirtyPaths(), ["data/x"]);

    await writeCache(cacheA, "data/y", "y");
    await a.markDirty({ relPath: "data/y" });
    assertEquals(await a.commitPush(manifest), 1);
    assertEquals([...remote.files().keys()], ["data/x"]);
    assertEquals(a.dirtyPaths(), ["data/y"]);

    await assertRejects(
      () => a.commitPush(manifest),
      Error,
      "already committed",
    );
  });
});

Deno.test("createInMemoryRemote: a failed commit keeps the paths dirty and can be retried", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    await writeCache(cacheA, "data/x", "x");
    await a.markDirty({ relPath: "data/x" });
    const manifest = await a.preparePush();

    a.failNext("commit");
    await assertRejects(() => a.commitPush(manifest), Error, "Injected commit");
    assertEquals(a.dirtyPaths(), ["data/x"]);
    assertEquals(remote.files().size, 0);

    assertEquals(await a.commitPush(manifest), 1);
    assertEquals(a.dirtyPaths(), []);
  });
});

Deno.test("createInMemoryRemote: offline rejects remote calls while marks still record", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    a.offline(true);
    await a.markDirty({ relPath: "data/x" });
    await assertRejects(() => a.pushChanged(), Error, "offline");
    await assertRejects(() => a.pullChanged(), Error, "offline");
    await assertRejects(() => a.preparePush(), Error, "offline");
    assertEquals(a.dirtyPaths(), ["data/x"]);

    a.offline(false);
    await writeCache(cacheA, "data/x", "x");
    assertEquals(await a.pushChanged(), 1);
  });
});

Deno.test("createInMemoryRemote: ops records successful operations across instances in order", async () => {
  await withCaches(async (cacheA, cacheB) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA, { instance: "a" });
    const b = remote.connect(cacheB, { instance: "b" });
    await writeCache(cacheA, "data/x", "x");
    await a.markDirty({ relPath: "data/x" });
    const manifest = await a.preparePush();
    await a.commitPush(manifest);
    await b.pullChanged();
    await Deno.remove(join(cacheA, "data/x"));
    await a.markDirty({ relPath: "data/x" });
    await a.pushChanged();

    assertEquals(remote.ops(), [
      { instance: "a", op: "prepare", paths: ["data/x"], deleted: [] },
      { instance: "a", op: "commit", paths: ["data/x"], deleted: [] },
      { instance: "b", op: "pull", paths: ["data/x"], deleted: [] },
      { instance: "a", op: "push", paths: [], deleted: ["data/x"] },
    ]);
  });
});

Deno.test("createInMemoryRemote: subdirs restricts the pull", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    const a = remote.connect(cacheA);
    remote.write("config/c", "c");
    remote.write("data/d", "d");
    assertEquals(await a.pullChanged({ subdirs: ["config/"] }), 1);
    assertEquals(await readCache(cacheA, "config/c"), "c");
    assertEquals(await readCache(cacheA, "data/d"), undefined);
  });
});

Deno.test("createInMemoryRemote: fullWalkOnFirstPush walks the cache once", async () => {
  await withCaches(async (cacheA) => {
    const remote = createInMemoryRemote();
    await writeCache(cacheA, "data/unmarked", "u");
    const strict = remote.connect(cacheA);
    assertEquals(await strict.pushChanged(), 0);

    const walking = remote.connect(cacheA, { fullWalkOnFirstPush: true });
    assertEquals(await walking.pushChanged(), 1);
    await writeCache(cacheA, "data/later", "l");
    assertEquals(await walking.pushChanged(), 0);
  });
});

Deno.test("createInMemoryRemote: capabilities default to two-phase and config refresh", () => {
  // connect() does not touch the cache directory.
  const cacheDir = join("unused", "cache");
  assertEquals(createInMemoryRemote().connect(cacheDir).capabilities(), {
    twoPhaseSync: true,
    configRefresh: true,
  });
  assertEquals(
    createInMemoryRemote({ capabilities: {} }).connect(cacheDir)
      .capabilities(),
    {},
  );
});
