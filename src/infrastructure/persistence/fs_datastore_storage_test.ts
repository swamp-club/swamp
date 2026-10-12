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

import { assertStorageConformance } from "@swamp-club/swamp-testing";
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
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
