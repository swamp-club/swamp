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

/**
 * The read model's durable file writer (swamp-club#3239) and its batch
 * (swamp-club#3337) on a real temp directory.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  DurableWriteBatch,
  writeFileDurably,
} from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-durable-write-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when handles are not yet released.
      // Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const signal = () => AbortSignal.timeout(10_000);

Deno.test("writeFileDurably: writes bytes and streams, creating the directory", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "a", "b", "raw");
    await writeFileDurably(path, new Uint8Array([1, 2, 3]), signal());
    assertEquals(await Deno.readFile(path), new Uint8Array([1, 2, 3]));
    await writeFileDurably(
      path,
      ReadableStream.from([new Uint8Array([4]), new Uint8Array([5, 6])]),
      signal(),
    );
    assertEquals(await Deno.readFile(path), new Uint8Array([4, 5, 6]));
    assertEquals([...Deno.readDirSync(join(dir, "a", "b"))].length, 1);
  });
});

Deno.test("writeFileDurably: cancels a stream it never read when the directory cannot be made", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "file"), "x");
    let cancelled = false;
    const content = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assertRejects(() =>
      writeFileDurably(join(dir, "file", "raw"), content, signal())
    );
    assert(cancelled, "the unread stream was not cancelled");
  });
});

Deno.test("writeFileDurably: a stream that fails part-way leaves the old file and no temp file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "raw");
    await Deno.writeTextFile(path, "old");
    let sent = false;
    const content = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) throw new Error("source failed");
        sent = true;
        controller.enqueue(new Uint8Array([1, 2]));
      },
    });
    await assertRejects(
      () => writeFileDurably(path, content, signal()),
      Error,
      "source failed",
    );
    assertEquals(await Deno.readTextFile(path), "old");
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["raw"]);
  });
});

/** A batch that counts the files it syncs, which it then closes. */
function countingBatch(maxOpenFiles?: number) {
  const counts = { synced: 0 };
  const batch = new DurableWriteBatch({
    maxOpenFiles,
    syncFile: async (file) => {
      await file.sync();
      counts.synced++;
    },
  });
  return { batch, counts };
}

Deno.test("DurableWriteBatch: syncs each touched directory once, deepest first, only at the barrier", async () => {
  await withTempDir(async (dir) => {
    const synced: string[] = [];
    const batch = new DurableWriteBatch({
      syncDirectory: (d) => {
        synced.push(d);
        return Promise.resolve();
      },
    });
    try {
      await batch.write(
        join(dir, "a", "b", "raw"),
        new Uint8Array([1]),
        signal(),
      );
      await batch.write(
        join(dir, "a", "b", "meta"),
        new Uint8Array([2]),
        signal(),
      );
      await batch.write(
        join(dir, "a", "c", "raw"),
        new Uint8Array([3]),
        signal(),
      );
      batch.touch(join(dir, "a", "b"));
      assertEquals(synced, []);
      await batch.barrier();
    } finally {
      batch.discard();
    }
    const expected = [
      join(dir, "a", "b"),
      join(dir, "a", "c"),
      join(dir, "a"),
      dir,
    ];
    assertEquals([...synced].sort(), [...expected].sort());
    // Every directory is synced before each of its ancestors.
    for (const d of synced) {
      for (let up = dirname(d); up !== dirname(up); up = dirname(up)) {
        const at = synced.indexOf(up);
        if (at !== -1) assert(synced.indexOf(d) < at, `${d} after ${up}`);
      }
    }
    assertEquals(
      await Deno.readFile(join(dir, "a", "c", "raw")),
      new Uint8Array([3]),
    );
  });
});

Deno.test("DurableWriteBatch: holds written files until the barrier, syncing early at maxOpenFiles", async () => {
  await withTempDir(async (dir) => {
    const held = countingBatch();
    const capped = countingBatch(2);
    try {
      for (let i = 0; i < 5; i++) {
        await held.batch.write(
          join(dir, "held", `f${i}`),
          new Uint8Array([i]),
          signal(),
        );
      }
      assertEquals(held.counts.synced, 0);
      await held.batch.barrier();
      assertEquals(held.counts.synced, 5);
      const syncedAfter: number[] = [];
      for (let i = 0; i < 5; i++) {
        await capped.batch.write(
          join(dir, "capped", `f${i}`),
          new Uint8Array([i]),
          signal(),
        );
        syncedAfter.push(capped.counts.synced);
      }
      // At most two written files are ever held unsynced.
      assertEquals(syncedAfter, [0, 2, 2, 4, 4]);
      await capped.batch.barrier();
      assertEquals(capped.counts.synced, 5);
    } finally {
      held.batch.discard();
      capped.batch.discard();
    }
    assertEquals(
      await Deno.readFile(join(dir, "capped", "f4")),
      new Uint8Array([4]),
    );
  });
});

Deno.test("DurableWriteBatch: a path written again or released is synced first, and the second content wins", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "raw");
    const other = join(dir, "other");
    const { batch, counts } = countingBatch();
    try {
      await batch.write(path, new Uint8Array([1]), signal());
      await batch.write(path, new Uint8Array([2]), signal());
      assertEquals(counts.synced, 1);
      assertEquals(await Deno.readFile(path), new Uint8Array([2]));
      await batch.write(other, new Uint8Array([3]), signal());
      await batch.release(other);
      assertEquals(counts.synced, 2);
      await Deno.remove(other);
      await batch.release(other);
      await batch.barrier();
      assertEquals(counts.synced, 3);
    } finally {
      batch.discard();
    }
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["raw"]);
  });
});

Deno.test("DurableWriteBatch: discard closes held files unsynced and leaves no temp files", async () => {
  await withTempDir(async (dir) => {
    const { batch, counts } = countingBatch();
    await batch.write(join(dir, "a"), new Uint8Array([1]), signal());
    await batch.write(join(dir, "b"), new Uint8Array([2]), signal());
    batch.discard();
    // A barrier after discard has nothing left to sync.
    await batch.barrier();
    assertEquals(counts.synced, 0);
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name).sort(), [
      "a",
      "b",
    ]);
  });
});

Deno.test("DurableWriteBatch: with sync false writes and renames without syncing anything", async () => {
  await withTempDir(async (dir) => {
    let synced = 0;
    const batch = new DurableWriteBatch({
      sync: false,
      syncFile: () => {
        synced++;
        return Promise.resolve();
      },
      syncDirectory: () => {
        synced++;
        return Promise.resolve();
      },
    });
    try {
      await batch.write(join(dir, "a", "raw"), new Uint8Array([1]), signal());
      await batch.write(join(dir, "a", "raw"), new Uint8Array([2]), signal());
      batch.touch(dir);
      await batch.release(join(dir, "a", "raw"));
      await batch.barrier();
    } finally {
      batch.discard();
    }
    assertEquals(synced, 0);
    assertEquals(
      await Deno.readFile(join(dir, "a", "raw")),
      new Uint8Array([2]),
    );
    assertEquals([...Deno.readDirSync(join(dir, "a"))].map((e) => e.name), [
      "raw",
    ]);
  });
});
