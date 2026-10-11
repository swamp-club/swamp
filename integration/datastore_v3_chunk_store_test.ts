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
 * The v3 chunk store over the filesystem `storage/1` implementation, on a
 * real temp directory (swamp-club#3237).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../src/domain/data/namespace.ts";
import type { DatastoreStorage } from "../src/domain/datastore/datastore_storage.ts";
import {
  ChunkIntegrityError,
  ChunkMissingError,
  ChunkStore,
} from "../src/domain/datastore_v3/chunk_store.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-chunk-store-" });
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

/** The filesystem storage, reporting a small chunk size. */
function smallChunks(dir: string, maxChunkBytes: number): DatastoreStorage {
  const storage = new FileSystemStorage(dir);
  return {
    contract: storage.contract,
    capabilities: () => ({ ...storage.capabilities(), maxChunkBytes }),
    has: (...args) => storage.has(...args),
    put: (...args) => storage.put(...args),
    get: (...args) => storage.get(...args),
    touch: (...args) => storage.touch(...args),
    list: (...args) => storage.list(...args),
    delete: (...args) => storage.delete(...args),
  };
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  const pieces = await Array.fromAsync(stream);
  const joined = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}

const NS = restoreNamespace("team-a");
const live = () => new AbortController().signal;
const content = Uint8Array.from({ length: 10_000 }, (_, i) => (i * 7) % 251);

function chunkPath(dir: string, namespace: string, sha256: string): string {
  return join(dir, "_blobs", namespace, "sha256", sha256.slice(0, 2), sha256);
}

async function chunkCount(storage: DatastoreStorage, namespace: string) {
  return (await Array.fromAsync(storage.list(namespace, live()))).length;
}

Deno.test("chunk store over the filesystem: writes, dedups and reads back many chunks", async () => {
  await withTempDir(async (dir) => {
    const storage = smallChunks(dir, 1024);
    const store = new ChunkStore(storage);
    const ref = await store.write(NS, content, live());
    assertEquals(ref.parts?.length, 10);
    assertEquals(await readAll(store.read(NS, ref, live())), content);
    for (const part of ref.parts!) {
      assertEquals(
        (await Deno.stat(chunkPath(dir, "team-a", part.sha256))).size,
        part.size,
      );
    }
    const stored = await chunkCount(storage, "team-a");
    const again = await store.write(NS, ReadableStream.from([content]), live());
    assert(again.equals(ref));
    assertEquals(await chunkCount(storage, "team-a"), stored);
  });
});

Deno.test("chunk store over the filesystem: a chunk corrupted on disk fails the read", async () => {
  await withTempDir(async (dir) => {
    const store = new ChunkStore(smallChunks(dir, 1024));
    const ref = await store.write(NS, content, live());
    const path = chunkPath(dir, "team-a", ref.parts![3].sha256);
    const bytes = await Deno.readFile(path);
    bytes[10] ^= 0xff;
    await Deno.writeFile(path, bytes);
    await assertRejects(
      () => readAll(store.read(NS, ref, live())),
      ChunkIntegrityError,
    );
  });
});

Deno.test("chunk store over the filesystem: a deleted chunk is reported missing", async () => {
  await withTempDir(async (dir) => {
    const store = new ChunkStore(smallChunks(dir, 1024));
    const ref = await store.write(NS, content, live());
    await Deno.remove(chunkPath(dir, "team-a", ref.parts![9].sha256));
    await assertRejects(
      () => readAll(store.read(NS, ref, live())),
      ChunkMissingError,
    );
  });
});

Deno.test("chunk store over the filesystem: namespaces are kept apart on disk", async () => {
  await withTempDir(async (dir) => {
    const storage = new FileSystemStorage(dir);
    const store = new ChunkStore(storage);
    const solo = await store.write(SOLO_NAMESPACE, content, live());
    const team = await store.write(NS, content, live());
    assert(solo.equals(team));
    await Deno.stat(chunkPath(dir, "_solo", solo.sha256));
    await Deno.stat(chunkPath(dir, "team-a", team.sha256));
    await storage.delete("_solo", solo.sha256, live());
    assertEquals(await readAll(store.read(NS, team, live())), content);
    await assertRejects(
      () => readAll(store.read(SOLO_NAMESPACE, solo, live())),
      ChunkMissingError,
    );
  });
});
