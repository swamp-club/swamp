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

import { assertStorageConformance, waitFor } from "@swamp-club/swamp-testing";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  isChunkDirectorySync,
  isChunkQuarantine,
  isChunkStaging,
  isChunkStatReader,
} from "../../domain/datastore/datastore_storage.ts";
import { FileSystemStorage } from "./fs_datastore_storage.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-fs-storage-test-" });
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

const live = () => new AbortController().signal;
const SHA = "ab" + "0".repeat(62);

Deno.test("FileSystemStorage: conforms to storage/1", async () => {
  await withTempDir(async (dir) => {
    await assertStorageConformance(() => new FileSystemStorage(dir), {
      setLastModified: (namespace, sha256, date) =>
        Deno.utime(
          join(dir, "_blobs", namespace, "sha256", sha256.slice(0, 2), sha256),
          date,
          date,
        ),
    });
  });
});

Deno.test("FileSystemStorage: stores a chunk at _blobs/<namespace>/sha256/<aa>/<hash>", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await storage.put("_default", SHA, new Uint8Array([7]), live());
    assertEquals(
      await Deno.readFile(join(dir, "_blobs", "_default", "sha256", "ab", SHA)),
      new Uint8Array([7]),
    );
  });
});

Deno.test("FileSystemStorage: refuses a namespace or hash that is not one", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    const bytes = new Uint8Array([1]);
    for (
      const namespace of ["..", "a/b", "", "_other", "_solo", "A", "-a", "a\\b"]
    ) {
      await assertRejects(
        () => storage.put(namespace, SHA, bytes, live()),
        Error,
        "Storage namespace",
      );
    }
    for (const sha256 of ["../" + SHA.slice(3), SHA.toUpperCase(), "ab"]) {
      await assertRejects(
        () => storage.get("_default", sha256, live()),
        Error,
        "Chunk hash",
      );
    }
    assertEquals([...Deno.readDirSync(dir)], []);
  });
});

Deno.test("FileSystemStorage: list skips temp files and stray entries", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await storage.put("team", SHA, new Uint8Array([1]), live());
    const shard = join(dir, "_blobs", "team", "sha256", "ab");
    await Deno.writeFile(
      join(shard, `.${crypto.randomUUID()}.tmp`),
      new Uint8Array(),
    );
    await Deno.writeFile(join(shard, "notes.txt"), new Uint8Array());
    await Deno.mkdir(join(dir, "_blobs", "team", "sha256", "zz"));
    assertEquals(
      (await Array.fromAsync(storage.list("team", live()))).map((c) =>
        c.sha256
      ),
      [SHA],
    );
  });
});

Deno.test("FileSystemStorage: an empty or missing namespace lists nothing", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await Array.fromAsync(new FileSystemStorage(dir).list("team", live())),
      [],
    );
  });
});

Deno.test(
  "FileSystemStorage: a failed put accepts only a chunk holding the same bytes",
  {
    // POSIX directory permissions make the temp-file write fail.
    ignore: Deno.build.os === "windows",
  },
  async () => {
    await withTempDir(async (dir) => {
      const storage = new FileSystemStorage(dir);
      const bytes = new Uint8Array([1, 2, 3]);
      await storage.put("team", SHA, bytes, live());
      const shard = join(dir, "_blobs", "team", "sha256", "ab");
      const path = join(shard, SHA);
      await Deno.chmod(shard, 0o500);
      try {
        // The same bytes are in place: the put is satisfied.
        await storage.put("team", SHA, bytes, live());
        // Damaged bytes of the same length: the put must not pretend.
        await Deno.chmod(shard, 0o700);
        await Deno.writeFile(path, new Uint8Array([9, 9, 9]));
        await Deno.chmod(shard, 0o500);
        await assertRejects(() => storage.put("team", SHA, bytes, live()));
      } finally {
        await Deno.chmod(shard, 0o700);
      }
    });
  },
);

Deno.test("FileSystemStorage: refuses a namespace longer than a slug may be", async () => {
  await withTempDir(async (dir) => {
    await assertRejects(
      () => new FileSystemStorage(dir).has("a".repeat(65), [SHA], live()),
      Error,
      "Storage namespace",
    );
  });
});

Deno.test("FileSystemStorage.removeStaleTempFiles: removes old temp files and keeps new ones, chunks and stray files", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await storage.put("acme", SHA, new Uint8Array([7]), live());
    const shard = join(dir, "_blobs", "acme", "sha256", "ab");
    const old = new Date("2026-01-01T00:00:00Z");
    const cutoff = new Date("2026-06-01T00:00:00Z");
    const staleTemp = join(shard, `.${crypto.randomUUID()}.tmp`);
    const newTemp = join(shard, `.${crypto.randomUUID()}.tmp`);
    const stray = join(shard, "notes.tmp");
    for (const path of [staleTemp, newTemp, stray]) {
      await Deno.writeFile(path, new Uint8Array([1]));
    }
    for (const path of [staleTemp, stray, join(shard, SHA)]) {
      await Deno.utime(path, old, old);
    }
    // Another namespace's temp file is not this sweep's.
    await storage.put("other", SHA, new Uint8Array([7]), live());
    const otherTemp = join(
      dir,
      "_blobs",
      "other",
      "sha256",
      "ab",
      `.${crypto.randomUUID()}.tmp`,
    );
    await Deno.writeFile(otherTemp, new Uint8Array([1]));
    await Deno.utime(otherTemp, old, old);

    assertEquals(await storage.removeStaleTempFiles("acme", cutoff, live()), 1);

    const left = (await Array.fromAsync(Deno.readDir(shard)))
      .map((entry) => join(shard, entry.name)).sort();
    assertEquals(left, [join(shard, SHA), newTemp, stray].sort());
    await Deno.stat(otherTemp);
    assertEquals(await storage.removeStaleTempFiles("acme", cutoff, live()), 0);
    assertEquals(
      await storage.removeStaleTempFiles("missing", cutoff, live()),
      0,
    );
  });
});

Deno.test("FileSystemStorage.removeStaleTempFiles: refuses a namespace that is not one, and an aborted signal", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await assertRejects(
      () => storage.removeStaleTempFiles("..", new Date(), live()),
      Error,
      "Storage namespace",
    );
    const controller = new AbortController();
    controller.abort();
    await assertRejects(() =>
      storage.removeStaleTempFiles("acme", new Date(), controller.signal)
    );
  });
});

const SHA_CD = "cd" + "1".repeat(62);

function chunkPath(dir: string, namespace: string, sha256: string): string {
  return join(dir, "_blobs", namespace, "sha256", sha256.slice(0, 2), sha256);
}

/** A storage whose directory syncs are recorded, with its own memo. */
function recordingStorage(dir: string) {
  const synced: string[] = [];
  const storage = new FileSystemStorage(dir, {
    syncDirectory: (d) => {
      synced.push(d);
      return Promise.resolve();
    },
    syncedAncestors: new Map(),
    durableChunks: new Map(),
  });
  return { storage, synced };
}

function ancestorsOf(dir: string, namespace: string): string[] {
  const namespaceDir = join(dir, "_blobs", namespace);
  return [join(namespaceDir, "sha256"), namespaceDir, join(dir, "_blobs"), dir];
}

Deno.test("FileSystemStorage: offers stat, staging, directory sync and quarantine beyond storage/1", () => {
  const storage = new FileSystemStorage("unused");
  assert(isChunkStatReader(storage));
  assert(isChunkStaging(storage));
  assert(isChunkDirectorySync(storage));
  assert(isChunkQuarantine(storage));
  const plain = {};
  assert(!isChunkStatReader(plain));
  assert(!isChunkStaging(plain));
  assert(!isChunkDirectorySync(plain));
  assert(!isChunkQuarantine(plain));
});

Deno.test("FileSystemStorage.put: syncs the temp file, then closes it, then renames it into place", async () => {
  await withTempDir(async (dir) => {
    const path = chunkPath(dir, "team", SHA);
    const seen: string[] = [];
    const storage = new FileSystemStorage(dir, {
      syncFile: async (file) => {
        // Still open (stat works) and not yet renamed into place.
        assertEquals((await file.stat()).size, 3);
        seen.push(`synced; chunk present: ${await exists(path)}`);
        await file.sync();
      },
      syncedAncestors: new Map(),
    });
    await storage.put("team", SHA, new Uint8Array([1, 2, 3]), live());
    assertEquals(seen, ["synced; chunk present: false"]);
    assertEquals(await Deno.readFile(path), new Uint8Array([1, 2, 3]));
    // No temp file is left, and the test's resource sanitizer finds no
    // handle left open.
    assertEquals([...Deno.readDirSync(dirname(path))].map((e) => e.name), [
      SHA,
    ]);
  });
});

Deno.test("FileSystemStorage.put: a failed sync leaves neither the chunk nor a temp file", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir, {
      syncFile: () => Promise.reject(new Error("disk gone")),
      syncedAncestors: new Map(),
    });
    await assertRejects(
      () => storage.put("team", SHA, new Uint8Array([1]), live()),
      Error,
      "disk gone",
    );
    assertEquals(
      [...Deno.readDirSync(dirname(chunkPath(dir, "team", SHA)))],
      [],
    );
  });
});

Deno.test("FileSystemStorage.statChunks: reports stored sizes and leaves out what is not stored", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await storage.put("team", SHA, new Uint8Array([1, 2, 3]), live());
    await storage.put("team", SHA_CD, new Uint8Array([1, 2, 3]), live());
    // A chunk an older swamp left short.
    await Deno.truncate(chunkPath(dir, "team", SHA_CD), 1);
    const at = new Date("2026-01-01T00:00:00Z");
    await Deno.utime(chunkPath(dir, "team", SHA), at, at);
    const missing = "ef" + "2".repeat(62);
    const stats = await storage.statChunks(
      "team",
      [SHA, SHA_CD, missing],
      live(),
    );
    assertEquals([...stats.keys()].sort(), [SHA, SHA_CD]);
    assertEquals(stats.get(SHA), { size: 3, lastModified: at });
    assertEquals(stats.get(SHA_CD)?.size, 1);
    assertEquals((await storage.statChunks("other", [SHA], live())).size, 0);
  });
});

Deno.test("FileSystemStorage.syncChunkDirectories: syncs unique shards of chunks not known durable, and ancestors once, whoever made them", async () => {
  await withTempDir(async (dir) => {
    // Directories and a chunk another process made: this storage did not
    // create any of them.
    await Deno.mkdir(dirname(chunkPath(dir, "team", SHA)), {
      recursive: true,
    });
    await Deno.writeFile(chunkPath(dir, "team", SHA), new Uint8Array([1]));
    const { storage, synced } = recordingStorage(dir);
    const shardAb = dirname(chunkPath(dir, "team", SHA));
    const shardCd = dirname(chunkPath(dir, "team", SHA_CD));

    await storage.syncChunkDirectories("team", [SHA, SHA, SHA_CD], live());
    assertEquals(synced, [shardAb, shardCd, ...ancestorsOf(dir, "team")]);

    // Both are durable now, whoever stored them: nothing to sync again.
    synced.length = 0;
    await storage.syncChunkDirectories("team", [SHA, SHA_CD], live());
    assertEquals(synced, []);

    synced.length = 0;
    await storage.syncChunkDirectories("team", [], live());
    assertEquals(synced, []);
  });
});

Deno.test("FileSystemStorage.syncChunkDirectories: a shard a put creates syncs its parent again", async () => {
  await withTempDir(async (dir) => {
    const { storage, synced } = recordingStorage(dir);
    await storage.put("team", SHA, new Uint8Array([1]), live());
    await storage.syncChunkDirectories("team", [SHA], live());
    synced.length = 0;

    // Same shard: nothing new above it.
    await storage.put("team", SHA, new Uint8Array([1]), live());
    await storage.syncChunkDirectories("team", [SHA], live());
    assertEquals(synced, [dirname(chunkPath(dir, "team", SHA))]);

    synced.length = 0;
    await storage.put("team", SHA_CD, new Uint8Array([1]), live());
    await storage.syncChunkDirectories("team", [SHA_CD], live());
    assertEquals(synced, [
      dirname(chunkPath(dir, "team", SHA_CD)),
      join(dir, "_blobs", "team", "sha256"),
    ]);

    // A new namespace: every ancestor below the root is new.
    synced.length = 0;
    await storage.put("acme", SHA, new Uint8Array([1]), live());
    await storage.syncChunkDirectories("acme", [SHA], live());
    assertEquals(synced, [
      dirname(chunkPath(dir, "acme", SHA)),
      ...ancestorsOf(dir, "acme"),
    ]);
  });
});

Deno.test("FileSystemStorage.syncChunkDirectories: concurrent callers share an ancestor's sync, and a failed one is retried", async () => {
  await withTempDir(async (dir) => {
    const synced: string[] = [];
    let fail = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => release = resolve);
    const storage = new FileSystemStorage(dir, {
      syncDirectory: async (d) => {
        synced.push(d);
        if (d === dir) {
          await gate;
          if (fail) throw new Error("sync refused");
        }
      },
      syncedAncestors: new Map(),
    });
    const first = storage.syncChunkDirectories("team", [SHA], live());
    const second = storage.syncChunkDirectories("team", [SHA_CD], live());
    release();
    await assertRejects(() => first, Error, "sync refused");
    await assertRejects(() => second, Error, "sync refused");
    // Each ancestor was synced once for both callers.
    assertEquals(synced.filter((d) => d === dir).length, 1);
    assertEquals(
      synced.filter((d) => d === join(dir, "_blobs")).length,
      1,
    );

    fail = false;
    synced.length = 0;
    await storage.syncChunkDirectories("team", [SHA], live());
    assertEquals(synced, [dirname(chunkPath(dir, "team", SHA)), dir]);
  });
});

Deno.test("FileSystemStorage.quarantineChunk: moves a chunk aside, then puts it back or removes it", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await storage.put("team", SHA, new Uint8Array([1, 2]), live());

    const aside = await storage.quarantineChunk("team", SHA, live());
    assert(aside !== undefined);
    assertEquals(await storage.get("team", SHA, live()), null);
    assertEquals(await Array.fromAsync(storage.list("team", live())), []);
    assertEquals(await aside.read(live()), new Uint8Array([1, 2]));
    await aside.putBack(live());
    assertEquals(
      await storage.get("team", SHA, live()),
      new Uint8Array([1, 2]),
    );

    const again = await storage.quarantineChunk("team", SHA, live());
    assert(again !== undefined);
    await again.remove(live());
    assertEquals(await storage.get("team", SHA, live()), null);
    assertEquals(
      [...Deno.readDirSync(dirname(chunkPath(dir, "team", SHA)))],
      [],
    );
    assertEquals(
      await storage.quarantineChunk("team", SHA, live()),
      undefined,
    );
  });
});

Deno.test("FileSystemStorage.quarantineChunk: putting back keeps a chunk stored since it was moved aside, and removes the moved-aside copy (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await storage.put("team", SHA, new Uint8Array([9, 9]), live());
    const aside = await storage.quarantineChunk("team", SHA, live());
    assert(aside !== undefined);
    // Another process stores the chunk meanwhile.
    await storage.put("team", SHA, new Uint8Array([1, 2]), live());
    await aside.putBack(live());
    assertEquals(
      await storage.get("team", SHA, live()),
      new Uint8Array([1, 2]),
    );
    assertEquals(
      [...Deno.readDirSync(dirname(chunkPath(dir, "team", SHA)))].map((e) =>
        e.name
      ),
      [SHA],
    );
  });
});

Deno.test("FileSystemStorage.quarantineChunk: a moved-aside chunk another process's sweep removed counts as done", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await storage.put("team", SHA, new Uint8Array([1]), live());
    const aside = await storage.quarantineChunk("team", SHA, live());
    assert(aside !== undefined);
    // Swept as a stale temp file: its mtime was set to now, so only a
    // cutoff in the future removes it.
    assertEquals(
      await storage.removeStaleTempFiles(
        "team",
        new Date(Date.now() + 60_000),
        live(),
      ),
      1,
    );
    assertEquals(await aside.read(live()), null);
    await aside.remove(live());
    await aside.putBack(live());
    assertEquals(await storage.get("team", SHA, live()), null);
  });
});

Deno.test("FileSystemStorage.quarantineChunk: the moved-aside file's mtime is now, so a sweep's grace keeps it", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    await storage.put("team", SHA, new Uint8Array([1]), live());
    const old = new Date("2026-01-01T00:00:00Z");
    await Deno.utime(chunkPath(dir, "team", SHA), old, old);
    const aside = await storage.quarantineChunk("team", SHA, live());
    assert(aside !== undefined);
    assertEquals(
      await storage.removeStaleTempFiles(
        "team",
        new Date("2026-06-01T00:00:00Z"),
        live(),
      ),
      0,
    );
    await aside.putBack(live());
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

const SHA_EF = "ef" + "3".repeat(62);

Deno.test("FileSystemStorage.stageChunks: syncs every staged file together, before any is renamed into place (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const hashes = [SHA, SHA_CD, SHA_EF];
    const paths = hashes.map((sha256) => chunkPath(dir, "team", sha256));
    const seen: number[] = [];
    let entered = 0;
    const storage = new FileSystemStorage(dir, {
      syncFile: async (file) => {
        entered++;
        // Every sync waits for the others: they run at once.
        await waitFor(() => entered === hashes.length, "every sync", {
          timeoutMs: 2_000,
          intervalMs: 1,
        });
        let renamed = 0;
        for (const path of paths) if (await exists(path)) renamed++;
        seen.push(renamed);
        await file.sync();
      },
      syncedAncestors: new Map(),
      durableChunks: new Map(),
    });
    const stage = storage.stageChunks("team");
    try {
      for (const [i, sha256] of hashes.entries()) {
        await stage.put(sha256, new Uint8Array([i, i, i]), live());
      }
      // A staged hash is written once.
      await stage.put(SHA, new Uint8Array([0, 0, 0]), live());
      // Staged, not stored: no reader sees them yet.
      assertEquals(await storage.has("team", hashes, live()), new Set());
      await stage.commit(live());
    } finally {
      await stage.discard();
    }
    assertEquals(seen, [0, 0, 0]);
    for (const [i, path] of paths.entries()) {
      assertEquals(await Deno.readFile(path), new Uint8Array([i, i, i]));
      // No temp file is left beside it.
      assertEquals(
        [...Deno.readDirSync(dirname(path))].map((e) => e.name),
        [hashes[i]],
      );
    }
  });
});

Deno.test("FileSystemStorage.stageChunks: a failed sync stores none of the stage's chunks and leaves no temp file (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    let syncs = 0;
    const storage = new FileSystemStorage(dir, {
      syncFile: async (file) => {
        if (++syncs === 2) throw new Error("disk gone");
        await file.sync();
      },
      syncedAncestors: new Map(),
      durableChunks: new Map(),
    });
    const stage = storage.stageChunks("team");
    try {
      await stage.put(SHA, new Uint8Array([1]), live());
      await stage.put(SHA_CD, new Uint8Array([2]), live());
      await assertRejects(() => stage.commit(live()), Error, "disk gone");
    } finally {
      await stage.discard();
    }
    for (const sha256 of [SHA, SHA_CD]) {
      assertEquals(
        [...Deno.readDirSync(dirname(chunkPath(dir, "team", sha256)))],
        [],
      );
    }
  });
});

Deno.test("FileSystemStorage.stageChunks: concurrent puts of one hash write one temp file, so none is left behind (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir, {
      syncedAncestors: new Map(),
      durableChunks: new Map(),
    });
    const stage = storage.stageChunks("team");
    try {
      await Promise.all([
        stage.put(SHA, new Uint8Array([1, 2]), live()),
        stage.put(SHA, new Uint8Array([1, 2]), live()),
      ]);
      await stage.commit(live());
    } finally {
      await stage.discard();
    }
    const path = chunkPath(dir, "team", SHA);
    assertEquals(await Deno.readFile(path), new Uint8Array([1, 2]));
    assertEquals(
      [...Deno.readDirSync(dirname(path))].map((e) => e.name),
      [SHA],
    );
  });
});

Deno.test("FileSystemStorage.stageChunks: discard removes what was staged, and an ended stage takes no more", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir, {
      syncedAncestors: new Map(),
      durableChunks: new Map(),
    });
    const stage = storage.stageChunks("team");
    await stage.put(SHA, new Uint8Array([1]), live());
    await stage.discard();
    assertEquals(
      [...Deno.readDirSync(dirname(chunkPath(dir, "team", SHA)))],
      [],
    );
    await assertRejects(
      () => stage.put(SHA, new Uint8Array([1]), live()),
      Error,
      "ended",
    );
  });
});

Deno.test("FileSystemStorage.syncChunkDirectories: a chunk put, moved or deleted here is synced again; one made durable is not (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const { storage, synced } = recordingStorage(dir);
    const shard = dirname(chunkPath(dir, "team", SHA));
    await storage.put("team", SHA, new Uint8Array([1]), live());
    await storage.syncChunkDirectories("team", [SHA], live());

    const again = async () => {
      synced.length = 0;
      await storage.syncChunkDirectories("team", [SHA], live());
      return [...synced];
    };
    // A dedupe hit on a chunk this process made durable: nothing to sync.
    assertEquals(await again(), []);
    // Put again: a new rename.
    await storage.put("team", SHA, new Uint8Array([1]), live());
    assertEquals(await again(), [shard]);
    assertEquals(await again(), []);
    // Moved aside and put back: renamed twice.
    const aside = await storage.quarantineChunk("team", SHA, live());
    await aside!.putBack(live());
    assertEquals(await again(), [shard]);
    // Deleted, and stored again by another process.
    await storage.delete("team", SHA, live());
    await Deno.writeFile(chunkPath(dir, "team", SHA), new Uint8Array([1]));
    assertEquals(await again(), [shard]);
  });
});

Deno.test("FileSystemStorage.syncChunkDirectories: a sync that fails, or that a put overtakes, does not mark its chunks durable (swamp-club#3617)", async () => {
  await withTempDir(async (dir) => {
    const shard = dirname(chunkPath(dir, "team", SHA));
    const synced: string[] = [];
    let fail = false;
    let hold: Promise<void> | undefined;
    let entered = false;
    const storage = new FileSystemStorage(dir, {
      syncDirectory: async (d) => {
        synced.push(d);
        if (d !== shard) return;
        entered = true;
        await hold;
        if (fail) throw new Error("sync refused");
      },
      syncedAncestors: new Map(),
      durableChunks: new Map(),
    });
    await storage.put("team", SHA, new Uint8Array([1]), live());

    fail = true;
    await assertRejects(
      () => storage.syncChunkDirectories("team", [SHA], live()),
      Error,
      "sync refused",
    );
    fail = false;
    synced.length = 0;
    await storage.syncChunkDirectories("team", [SHA], live());
    assertEquals(synced, [shard, ...ancestorsOf(dir, "team")]);

    // A put lands while the shard's sync is in flight: that sync may miss
    // its rename.
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => release = resolve);
    entered = false;
    await storage.put("team", SHA, new Uint8Array([1]), live());
    const inFlight = storage.syncChunkDirectories("team", [SHA], live());
    await waitFor(() => entered, "the shard sync to start");
    await storage.put("team", SHA, new Uint8Array([1]), live());
    release();
    await inFlight;
    hold = undefined;

    synced.length = 0;
    await storage.syncChunkDirectories("team", [SHA], live());
    assertEquals(synced, [shard]);
  });
});
