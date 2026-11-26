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
import { dirname, join } from "@std/path";
import {
  DurableWriteBatch,
  writeFileDurably,
} from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import { modeWithAccess } from "../src/domain/datastore_v3/file_access.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-durable-write-" });
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

Deno.test("writeFileDurably: syncs the file, then the directories it created, through the injected seams", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "a", "b", "raw");
    const events: string[] = [];
    await writeFileDurably(path, new Uint8Array([1]), signal(), {
      syncFile: async (file) => {
        await file.sync();
        events.push("file");
      },
      syncDirectory: (d) => {
        events.push(d);
        return Promise.resolve();
      },
    });
    assertEquals(events, [
      "file",
      join(dir, "a", "b"),
      join(dir, "a"),
      dir,
    ]);
    assertEquals(await Deno.readFile(path), new Uint8Array([1]));
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

Deno.test("DurableWriteBatch: a stale hint that the directory exists still creates it", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "gone", "raw");
    const batch = new DurableWriteBatch({ sync: false });
    try {
      await batch.write(path, new Uint8Array([7]), signal(), {
        absentDirectories: [],
      });
    } finally {
      batch.discard();
    }
    assertEquals(await Deno.readFile(path), new Uint8Array([7]));
  });
});

Deno.test({
  name:
    "DurableWriteBatch: gives the file its access before the rename (swamp-club#3693)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const plainPath = join(dir, "plain");
      await writeFileDurably(plainPath, new Uint8Array([1]), signal());
      const created = (await Deno.stat(plainPath)).mode! & 0o777;
      for (const sync of [true, false]) {
        for (
          const access of [
            "executable",
            "private",
            "private-executable",
          ] as const
        ) {
          const path = join(dir, `${access}-${sync}`);
          const batch = new DurableWriteBatch({ sync });
          const seen: number[] = [];
          try {
            await batch.write(
              path,
              ReadableStream.from([new Uint8Array([1, 2])]),
              signal(),
              { access, written: (info) => seen.push(info.mode! & 0o777) },
            );
            await batch.barrier();
          } finally {
            batch.discard();
          }
          const expected = modeWithAccess(created, access);
          assertEquals((await Deno.stat(path)).mode! & 0o777, expected);
          assertEquals(seen, [expected]);
          assertEquals(await Deno.readFile(path), new Uint8Array([1, 2]));
        }
      }
      const path = join(dir, "executable-true");
      await writeFileDurably(path, new Uint8Array([3]), signal());
      assertEquals((await Deno.stat(path)).mode! & 0o777, created);
    });
  },
});

async function withCounted(
  owner: object,
  name: string,
  fn: (calls: () => number) => Promise<void>,
): Promise<void> {
  const slots = owner as Record<string, unknown>;
  const original = slots[name] as (...args: unknown[]) => unknown;
  let calls = 0;
  slots[name] = function (this: unknown, ...args: unknown[]) {
    calls++;
    return original.apply(this, args);
  };
  try {
    await fn(() => calls);
  } finally {
    slots[name] = original;
  }
}

Deno.test("DurableWriteBatch: writes into one new directory share its mkdir, and a later write there looks for nothing", async () => {
  await withTempDir(async (dir) => {
    const made = join(dir, "a", "b");
    const names = ["latest", "metadata.yaml", "out", "raw"];
    const batch = new DurableWriteBatch({ sync: false });
    try {
      await withCounted(Deno, "mkdir", async (mkdirs) => {
        await withCounted(Deno, "lstat", async (lstats) => {
          await Promise.all(
            names.map((name) =>
              batch.write(join(made, name), new Uint8Array([1]), signal(), {
                absentDirectories: [made, join(dir, "a")],
              })
            ),
          );
          await batch.write(join(made, "later"), new Uint8Array([2]), signal());
          assertEquals(mkdirs(), 1);
          assertEquals(lstats(), 0);
        });
      });
    } finally {
      batch.discard();
    }
    assertEquals(
      [...Deno.readDirSync(made)].map((e) => e.name).sort(),
      [...names, "later"].sort(),
    );
  });
});

Deno.test("DurableWriteBatch: a directory removed after the batch made it is made again", async () => {
  await withTempDir(async (dir) => {
    const batch = new DurableWriteBatch({ sync: false });
    try {
      await batch.write(join(dir, "a", "raw"), new Uint8Array([1]), signal());
      await Deno.remove(join(dir, "a"), { recursive: true });
      await batch.write(join(dir, "a", "next"), new Uint8Array([2]), signal());
    } finally {
      batch.discard();
    }
    assertEquals(
      await Deno.readFile(join(dir, "a", "next")),
      new Uint8Array([2]),
    );
  });
});

Deno.test("DurableWriteBatch: a write with no written callback never stats its temp file", async () => {
  await withTempDir(async (dir) => {
    for (const sync of [true, false]) {
      const batch = new DurableWriteBatch({ sync });
      const sizes: number[] = [];
      try {
        await withCounted(Deno.FsFile.prototype, "stat", async (stats) => {
          await batch.write(
            join(dir, `${sync}`, "bytes"),
            new Uint8Array([1, 2]),
            signal(),
          );
          await batch.write(
            join(dir, `${sync}`, "stream"),
            ReadableStream.from([new Uint8Array([3])]),
            signal(),
          );
          assertEquals(stats(), 0);
          await batch.write(
            join(dir, `${sync}`, "noted"),
            new Uint8Array([4, 5, 6]),
            signal(),
            { written: (info) => sizes.push(info.size) },
          );
          assertEquals(stats(), 1);
        });
        await batch.barrier();
      } finally {
        batch.discard();
      }
      assertEquals(sizes, [3]);
      assertEquals(
        await Deno.readFile(join(dir, `${sync}`, "bytes")),
        new Uint8Array([1, 2]),
      );
    }
  });
});

Deno.test("DurableWriteBatch: a directory a failed write made is synced with the file another write put there", async () => {
  await withTempDir(async (dir) => {
    const synced: string[] = [];
    const batch = new DurableWriteBatch({
      syncFile: () => Promise.resolve(),
      syncDirectory: (path) => {
        synced.push(path);
        return Promise.resolve();
      },
    });
    const made = join(dir, "x", "y");
    try {
      await assertRejects(() =>
        batch.write(
          join(made, "failed"),
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("source failed"));
            },
          }),
          signal(),
        )
      );
      await batch.write(join(made, "raw"), new Uint8Array([1]), signal());
      await batch.barrier();
    } finally {
      batch.discard();
    }
    assertEquals(synced, [made, join(dir, "x"), dir]);
  });
});

Deno.test("DurableWriteBatch: an aborted unsynced write leaves the old file and no temp file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "a", "raw");
    const batch = new DurableWriteBatch({ sync: false });
    try {
      await batch.write(path, new Uint8Array([1]), signal());
      const stop = new AbortController();
      stop.abort();
      await assertRejects(() =>
        batch.write(path, new Uint8Array([2]), stop.signal)
      );
    } finally {
      batch.discard();
    }
    assertEquals(await Deno.readFile(path), new Uint8Array([1]));
    assertEquals([...Deno.readDirSync(join(dir, "a"))].map((e) => e.name), [
      "raw",
    ]);
  });
});
