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
    await storage.put("_solo", SHA, new Uint8Array([7]), live());
    assertEquals(
      await Deno.readFile(join(dir, "_blobs", "_solo", "sha256", "ab", SHA)),
      new Uint8Array([7]),
    );
  });
});

Deno.test("FileSystemStorage: refuses a namespace or hash that is not one", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    const bytes = new Uint8Array([1]);
    for (const namespace of ["..", "a/b", "", "_other", "A", "-a", "a\\b"]) {
      await assertRejects(
        () => storage.put(namespace, SHA, bytes, live()),
        Error,
        "Storage namespace",
      );
    }
    for (const sha256 of ["../" + SHA.slice(3), SHA.toUpperCase(), "ab"]) {
      await assertRejects(
        () => storage.get("_solo", sha256, live()),
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
