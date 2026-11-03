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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  ARCHIVE_CACHE_MAX_AGE_MS,
  createDefaultExtensionArchiveCache,
  FileExtensionArchiveCache,
} from "./extension_archive_cache.ts";
import { withMockedEnv } from "./path_test_helpers.ts";

async function tempRoot() {
  const dir = await Deno.makeTempDir({ prefix: "swamp_archive_cache_" });
  return {
    dir,
    async [Symbol.asyncDispose]() {
      await Deno.remove(dir, { recursive: true }).catch((error) => {
        if (Deno.build.os !== "windows") throw error;
      });
    },
  };
}

async function archive(text = crypto.randomUUID()) {
  const bytes = new TextEncoder().encode(text);
  return { bytes, key: await computeChecksum(bytes) };
}

function entryPath(root: string, key: string): string {
  return join(root, "sha256", `${key}.tar.gz`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("FileExtensionArchiveCache: returns the bytes it stored under their checksum", async () => {
  await using root = await tempRoot();
  const cache = new FileExtensionArchiveCache(root.dir);
  const { bytes, key } = await archive();
  await cache.put(key, bytes);
  assertEquals(await cache.get(key), bytes);
  assertEquals(await cache.get(key.toUpperCase()), bytes);
});

Deno.test("FileExtensionArchiveCache: reports a miss for an unknown key", async () => {
  await using root = await tempRoot();
  const cache = new FileExtensionArchiveCache(root.dir);
  const { key } = await archive();
  assertEquals(await cache.get(key), null);
});

Deno.test("FileExtensionArchiveCache: removes a corrupt entry and reports a miss", async () => {
  await using root = await tempRoot();
  const cache = new FileExtensionArchiveCache(root.dir);
  const { bytes, key } = await archive();
  await cache.put(key, bytes);
  await Deno.writeFile(entryPath(root.dir, key), new TextEncoder().encode("x"));
  assertEquals(await cache.get(key), null);
  assertEquals(await exists(entryPath(root.dir, key)), false);
});

Deno.test("FileExtensionArchiveCache: refuses to store bytes that do not hash to the key", async () => {
  await using root = await tempRoot();
  const cache = new FileExtensionArchiveCache(root.dir);
  const { key } = await archive();
  const other = await archive();
  await cache.put(key, other.bytes);
  assertEquals(await exists(entryPath(root.dir, key)), false);
});

Deno.test("FileExtensionArchiveCache: an invalid key never touches the filesystem", async () => {
  await using root = await tempRoot();
  const cache = new FileExtensionArchiveCache(root.dir);
  const { bytes } = await archive();
  for (const key of ["../escape", "", "sha256:abc"]) {
    await cache.put(key, bytes);
    assertEquals(await cache.get(key), null);
  }
  assertEquals(await exists(join(root.dir, "sha256")), false);
});

Deno.test("FileExtensionArchiveCache: a symlinked entry is a miss", async () => {
  await using root = await tempRoot();
  const cache = new FileExtensionArchiveCache(root.dir);
  const { bytes, key } = await archive();
  const target = join(root.dir, "planted.tar.gz");
  await Deno.writeFile(target, bytes);
  await Deno.mkdir(join(root.dir, "sha256"));
  await Deno.symlink(target, entryPath(root.dir, key), { type: "file" });
  assertEquals(await cache.get(key), null);
});

Deno.test("FileExtensionArchiveCache: a directory in place of an entry is a miss", async () => {
  await using root = await tempRoot();
  const cache = new FileExtensionArchiveCache(root.dir);
  const { key } = await archive();
  await Deno.mkdir(entryPath(root.dir, key), { recursive: true });
  assertEquals(await cache.get(key), null);
});

Deno.test("FileExtensionArchiveCache: storing a key again replaces the entry", async () => {
  await using root = await tempRoot();
  const cache = new FileExtensionArchiveCache(root.dir);
  const { bytes, key } = await archive();
  await cache.put(key, bytes);
  await cache.put(key, bytes);
  assertEquals(await cache.get(key), bytes);
});

Deno.test("FileExtensionArchiveCache: a store prunes entries unused past the max age and old temp files", async () => {
  await using root = await tempRoot();
  const now = Date.now();
  const cache = new FileExtensionArchiveCache(root.dir, { now: () => now });
  const stale = await archive();
  const fresh = await archive();
  await cache.put(stale.key, stale.bytes);
  const old = new Date(now - ARCHIVE_CACHE_MAX_AGE_MS - 60_000);
  await Deno.utime(entryPath(root.dir, stale.key), old, old);
  const orphan = join(root.dir, "sha256", `.${crypto.randomUUID()}.tmp`);
  await Deno.writeFile(orphan, new Uint8Array([1]));
  await Deno.utime(orphan, old, old);

  await cache.put(fresh.key, fresh.bytes);

  assertEquals(await exists(entryPath(root.dir, stale.key)), false);
  assertEquals(await exists(orphan), false);
  assertEquals(await cache.get(fresh.key), fresh.bytes);
});

Deno.test("FileExtensionArchiveCache: a hit refreshes the entry so the prune keeps it", async () => {
  await using root = await tempRoot();
  let now = Date.now();
  const cache = new FileExtensionArchiveCache(root.dir, { now: () => now });
  const used = await archive();
  await cache.put(used.key, used.bytes);
  const old = new Date(now - ARCHIVE_CACHE_MAX_AGE_MS + 60_000);
  await Deno.utime(entryPath(root.dir, used.key), old, old);
  assertEquals(await cache.get(used.key), used.bytes);

  now += 2 * 60_000;
  const other = await archive();
  await cache.put(other.key, other.bytes);
  assertEquals(await cache.get(used.key), used.bytes);
});

Deno.test("FileExtensionArchiveCache: an unwritable root is a skipped store, not an error", async () => {
  await using root = await tempRoot();
  const blocker = join(root.dir, "file");
  await Deno.writeFile(blocker, new Uint8Array([1]));
  const cache = new FileExtensionArchiveCache(blocker);
  const { bytes, key } = await archive();
  await cache.put(key, bytes);
  assertEquals(await cache.get(key), null);
});

Deno.test("createDefaultExtensionArchiveCache: creates nothing on disk until a store", async () => {
  await using root = await tempRoot();
  const cache = withMockedEnv(
    { SWAMP_HOME: root.dir },
    () => createDefaultExtensionArchiveCache(),
  );
  assert(cache !== undefined);
  assertEquals([...Deno.readDirSync(root.dir)], []);
  const { bytes, key } = await archive();
  await cache.put(key, bytes);
  assert(await exists(join(root.dir, "cache", "extension-archives", "sha256")));
});

Deno.test("createDefaultExtensionArchiveCache: no data dir means no cache", () => {
  const cache = withMockedEnv(
    { SWAMP_HOME: undefined, HOME: undefined, USERPROFILE: undefined },
    () => createDefaultExtensionArchiveCache(),
  );
  assertEquals(cache, undefined);
});
