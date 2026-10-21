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
 * A materialised file keeps its access (swamp-club#3693). The real data
 * repository writes and chmods content files in a writer checkout and
 * commits them to a real `commits.db` and filesystem `storage/1`; another
 * checkout's read model then catches up, and so does the writer's own on
 * its next command. An executable output stays executable and a private
 * one stays private everywhere, inline-sized or chunked, and through the
 * compacted base. POSIX only: Windows keeps no modes.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Data } from "../src/domain/data/data.ts";
import { SOLO_NAMESPACE } from "../src/domain/data/namespace.ts";
import type {
  ChunkStat,
  ChunkStatReader,
} from "../src/domain/datastore/datastore_storage.ts";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import { MAX_INLINE_BYTES } from "../src/domain/datastore_v3/op.ts";
import {
  MODEL_ID,
  MODEL_TYPE,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { runInCommitLogRoot } from "../src/infrastructure/datastore_v3/commit_log_root.ts";
import {
  contextHook,
  unitOptions,
} from "../src/infrastructure/datastore_v3/commit_log_test_helpers.ts";
import { readModelStateDir } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import type { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import {
  SmallChunkStorage,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

await initializeLogging({});

const IS_WINDOWS = Deno.build.os === "windows";

/** The modes a test writes, by data name. */
const MODES = { exec: 0o755, secret: 0o600, plain: 0o644 } as const;

function data(name: string): Data {
  return Data.create({
    name,
    contentType: "application/octet-stream",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: { type: "resource", modelName: "vpc", specName: "main" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test" },
  });
}

/** Content of `size` bytes: inline-sized or chunked. */
function content(size: number, seed: number): Uint8Array {
  return new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251);
}

/** A writer checkout: the real data repository in its own directory. */
function writerOf(env: V3Env) {
  const dir = join(env.dir, "writer");
  const root = swampPath(dir);
  const hook = contextHook();
  const repo = new FileSystemUnifiedDataRepository(
    dir,
    join(root, "data"),
    new CatalogStore(join(dir, "_catalog.db")),
    hook,
    undefined,
    SOLO_NAMESPACE,
    true,
  );
  /** Writes each name's content, chmods it, and commits it. */
  const write = (size: number) =>
    runInCommitLogRoot(
      { markDirty: hook },
      unitOptions(env.store, env.storage, {
        namespace: SOLO_NAMESPACE,
        signal: AbortSignal.timeout(60_000),
      }),
      async () => {
        let seed = 0;
        for (const [name, mode] of Object.entries(MODES)) {
          const allocated = await repo.allocateVersion(
            MODEL_TYPE,
            MODEL_ID,
            data(name),
          );
          await Deno.writeFile(allocated.contentPath, content(size, seed++));
          await Deno.chmod(allocated.contentPath, mode);
          await repo.finalizeVersion(
            MODEL_TYPE,
            MODEL_ID,
            data(name),
            allocated.version,
            allocated.priorVersions,
          );
        }
      },
    );
  return { dir, root, repo, write };
}

/**
 * Catches up the read model of the checkout at `dir` (its next command),
 * in `boot` when given, so its writes are listed for the reboot check.
 */
async function catchUp(
  env: V3Env,
  dir: string,
  options: { boot?: string; chunkStore?: ChunkStore } = {},
): Promise<void> {
  const readModel = env.openReadModel({
    cacheRoot: () => swampPath(dir),
    stateDir: readModelStateDir(dir),
    ...(options.boot === undefined
      ? {}
      : { bootIdentity: () => Promise.resolve(options.boot!) }),
    ...(options.chunkStore === undefined
      ? {}
      : { chunkStore: options.chunkStore }),
  });
  try {
    await readModel.catchUp(AbortSignal.timeout(60_000));
  } finally {
    await readModel.close();
  }
}

/** Each data name's content-file mode in the checkout whose cache is `root`. */
async function modesIn(
  root: string,
  dataDir: (name: string) => string,
): Promise<Record<string, string>> {
  const modes: Record<string, string> = {};
  for (const name of Object.keys(MODES)) {
    const info = await Deno.stat(join(root, dataDir(name), "1", "raw"));
    modes[name] = (info.mode! & 0o777).toString(8);
  }
  return modes;
}

/** The modes each checkout must show: the writer's, under this umask. */
async function expectedModes(env: V3Env): Promise<Record<string, string>> {
  const probe = join(env.dir, "umask-probe");
  await Deno.writeFile(probe, new Uint8Array());
  const created = (await Deno.stat(probe)).mode! & 0o777;
  const executable = created | ((created & 0o444) >> 2);
  return {
    exec: executable.toString(8),
    secret: (created & 0o600).toString(8),
    plain: created.toString(8),
  };
}

/**
 * The test storage with the filesystem's size reader, so the checkout-copy
 * guard reads a chunked file and keeps one holding the committed bytes.
 */
class StatStorage extends SmallChunkStorage implements ChunkStatReader {
  statChunks(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, ChunkStat>> {
    return (this.inner as FileSystemStorage).statChunks(
      namespace,
      hashes,
      signal,
    );
  }
}

function dataDirOf(name: string): string {
  return join("data", MODEL_TYPE.toDirectoryPath(), MODEL_ID, name);
}

for (
  const [label, size] of [
    ["inline-sized", 100],
    ["chunked", MAX_INLINE_BYTES * 3],
  ] as const
) {
  Deno.test({
    name:
      `v3 file access: ${label} outputs keep their access in another checkout and in the writer's after its next command`,
    ignore: IS_WINDOWS,
    fn: async () => {
      await withV3Env(async (env) => {
        const writer = writerOf(env);
        await writer.write(size);
        const writerModes = await modesIn(writer.root, dataDirOf);
        // The writer's own files are as it wrote them.
        assertEquals(writerModes, { exec: "755", secret: "600", plain: "644" });

        const expected = await expectedModes(env);
        const other = join(env.dir, "other");
        await catchUp(env, other);
        assertEquals(await modesIn(swampPath(other), dataDirOf), expected);

        await catchUp(env, writer.dir);
        assertEquals(await modesIn(writer.root, dataDirOf), writerModes);
      });
    },
  });
}

Deno.test({
  name:
    "v3 file access: a checkout built from the compacted base keeps each output's access",
  ignore: IS_WINDOWS,
  fn: async () => {
    await withV3Env(async (env) => {
      const writer = writerOf(env);
      await writer.write(100);
      await writer.write(MAX_INLINE_BYTES * 3);
      await env.store.compactHistory(Number.MAX_SAFE_INTEGER);
      const expected = await expectedModes(env);
      const fresh = join(env.dir, "fresh");
      await catchUp(env, fresh);
      const modes: Record<string, string> = {};
      for (const name of Object.keys(MODES)) {
        for (const version of ["1", "2"]) {
          const info = await Deno.stat(
            join(swampPath(fresh), dataDirOf(name), version, "raw"),
          );
          modes[`${name}@${version}`] = (info.mode! & 0o777).toString(8);
        }
      }
      assertEquals(modes, {
        "exec@1": expected.exec,
        "exec@2": expected.exec,
        "secret@1": "600",
        "secret@2": "600",
        "plain@1": expected.plain,
        "plain@2": expected.plain,
      });
    });
  },
});

Deno.test({
  name:
    "v3 file access: a kept file holding the right bytes with the wrong access is rewritten with its access",
  ignore: IS_WINDOWS,
  fn: async () => {
    await withV3Env(async (env) => {
      const writer = writerOf(env);
      await writer.write(MAX_INLINE_BYTES * 3);
      // The writer's chunked file changes access after its commit; its
      // bytes are still the committed ones, so the guard would keep it.
      const exec = join(writer.root, dataDirOf("exec"), "1", "raw");
      const before = (await Deno.stat(exec)).ino;
      await Deno.chmod(exec, 0o644);
      const storage = new StatStorage(env.storage.inner);
      await catchUp(env, writer.dir, { chunkStore: new ChunkStore(storage) });
      // Rewritten through a temp file, never chmodded in place.
      assert((await Deno.stat(exec)).ino !== before);
      assertEquals(
        await modesIn(writer.root, dataDirOf),
        await expectedModes(env),
      );
    });
  },
});

Deno.test({
  name:
    "v3 file access: a kept file of a plain put keeps its mode, as before the access was recorded",
  ignore: IS_WINDOWS,
  fn: async () => {
    await withV3Env(async (env) => {
      const writer = writerOf(env);
      await writer.write(MAX_INLINE_BYTES * 3);
      // The plain output was made executable after its commit, as a file
      // committed before swamp-club#3693 recorded no access at all.
      const plain = join(writer.root, dataDirOf("plain"), "1", "raw");
      const before = (await Deno.stat(plain)).ino;
      await Deno.chmod(plain, 0o755);
      const storage = new StatStorage(env.storage.inner);
      await catchUp(env, writer.dir, { chunkStore: new ChunkStore(storage) });
      assertEquals((await Deno.stat(plain)).ino, before);
      assertEquals(((await Deno.stat(plain)).mode! & 0o777).toString(8), "755");
    });
  },
});

Deno.test({
  name:
    "v3 file access: the check after a reboot rewrites a lost file with its access",
  ignore: IS_WINDOWS,
  fn: async () => {
    await withV3Env(async (env) => {
      const writer = writerOf(env);
      await writer.write(100);
      await writer.write(MAX_INLINE_BYTES * 3);
      const other = join(env.dir, "other");
      await catchUp(env, other, { boot: "boot-id:1" });
      // A power loss empties every file the unsynced catch-up wrote.
      for (const name of Object.keys(MODES)) {
        for (const version of ["1", "2"]) {
          const path = join(swampPath(other), dataDirOf(name), version, "raw");
          await Deno.remove(path);
          await Deno.writeFile(path, new Uint8Array());
        }
      }
      await catchUp(env, other, { boot: "boot-id:2" });
      const expected = await expectedModes(env);
      for (const version of ["1", "2"]) {
        const modes: Record<string, string> = {};
        for (const name of Object.keys(MODES)) {
          const path = join(swampPath(other), dataDirOf(name), version, "raw");
          modes[name] = ((await Deno.stat(path)).mode! & 0o777).toString(8);
        }
        assertEquals(modes, expected, `version ${version}`);
      }
    });
  },
});

Deno.test({
  name:
    "v3 file access: an unreadable record written once its chunks are back has its access",
  ignore: IS_WINDOWS,
  fn: async () => {
    await withV3Env(async (env) => {
      const writer = writerOf(env);
      await writer.write(MAX_INLINE_BYTES * 3);
      // The chunks are gone while another checkout catches up, then back.
      const blobs = join(env.dir, "datastore", "_blobs");
      const aside = join(env.dir, "blobs-aside");
      await Deno.rename(blobs, aside);
      const other = join(env.dir, "other");
      const chunkStore = new ChunkStore(new StatStorage(env.storage.inner));
      await catchUp(env, other, { chunkStore });
      await assertRejects(() =>
        Deno.stat(join(swampPath(other), dataDirOf("exec"), "1", "raw"))
      );
      await Deno.rename(aside, blobs);
      await catchUp(env, other, { chunkStore });
      assertEquals(
        await modesIn(swampPath(other), dataDirOf),
        await expectedModes(env),
      );
    });
  },
});
