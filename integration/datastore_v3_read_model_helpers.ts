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
 * Shared harness for the v3 read model's integration tests
 * (swamp-club#3239): a temp repository with a real `commits.db`, the
 * filesystem `storage/1` and a read model, plus readers for what the read
 * model produced.
 */

import { join, relative, SEPARATOR } from "@std/path";
import { walk } from "@std/fs";
import { DatabaseSync } from "node:sqlite";
import { ChunkStore } from "../src/domain/datastore_v3/chunk_store.ts";
import { checkCommitBindings } from "../src/domain/datastore_v3/commit_authorization.ts";
import { CommitsCompactedError } from "../src/domain/datastore_v3/commit_store.ts";
import { Commit, type CommitProps } from "../src/domain/datastore_v3/commit.ts";
import type { Op } from "../src/domain/datastore_v3/op.ts";
import type {
  DatastoreStorage,
  StorageCapabilities,
} from "../src/domain/datastore/datastore_storage.ts";
import { FileSystemStorage } from "../src/infrastructure/persistence/fs_datastore_storage.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import {
  CATALOG_V3_FILE,
  SqliteReadModel,
  type SqliteReadModelOptions,
} from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import {
  READ_MODEL_STATE_DIR,
  readModelStateDir,
} from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import type { PartitionKey } from "../src/domain/datastore_v3/partition_key.ts";

/** The chunk size the tests store with, so content spans several chunks. */
export const TEST_CHUNK_BYTES = 1024;

/** A `storage/1` that delegates to another but reports smaller chunks. */
export class SmallChunkStorage implements DatastoreStorage {
  readonly contract = "storage/1" as const;
  readonly touch?: DatastoreStorage["touch"];

  constructor(readonly inner: DatastoreStorage) {
    const touch = inner.touch;
    if (touch !== undefined) {
      this.touch = (namespace, hashes, signal) =>
        touch.call(inner, namespace, hashes, signal);
    }
  }

  capabilities(): StorageCapabilities {
    return { ...this.inner.capabilities(), maxChunkBytes: TEST_CHUNK_BYTES };
  }
  has(namespace: string, hashes: readonly string[], signal: AbortSignal) {
    return this.inner.has(namespace, hashes, signal);
  }
  put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) {
    return this.inner.put(namespace, sha256, bytes, signal);
  }
  get(namespace: string, sha256: string, signal: AbortSignal) {
    return this.inner.get(namespace, sha256, signal);
  }
  list(namespace: string, signal: AbortSignal) {
    return this.inner.list(namespace, signal);
  }
  delete(namespace: string, sha256: string, signal: AbortSignal) {
    return this.inner.delete(namespace, sha256, signal);
  }
}

/** One repository's v3 pieces: commit store, chunk store and directories. */
export interface V3Env {
  readonly dir: string;
  readonly repoDir: string;
  readonly stateDir: string;
  readonly store: SqliteCommitStore;
  readonly storage: SmallChunkStorage;
  readonly chunkStore: ChunkStore;
  /** The cache directory of a namespace: `.swamp/` or `.swamp/<namespace>`. */
  cacheRoot(namespace: string): string;
  /** Opens a read model over this repository. */
  openReadModel(
    overrides?: Partial<SqliteReadModelOptions>,
  ): SqliteReadModel;
}

/** Runs `fn` with a fresh temp repository, removing it after. */
export async function withV3Env(
  fn: (env: V3Env) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-read-model-" });
  const repoDir = join(dir, "repo");
  const store = SqliteCommitStore.open(join(dir, "commits.db"));
  const storage = new SmallChunkStorage(
    new FileSystemStorage(join(dir, "datastore")),
  );
  const chunkStore = new ChunkStore(storage);
  const cacheRoot = (namespace: string) =>
    namespace === "" ? swampPath(repoDir) : swampPath(repoDir, namespace);
  const env: V3Env = {
    dir,
    repoDir,
    stateDir: readModelStateDir(repoDir),
    store,
    storage,
    chunkStore,
    cacheRoot,
    openReadModel: (overrides = {}) =>
      SqliteReadModel.open({
        commitStore: store,
        chunkStore,
        cacheRoot,
        stateDir: readModelStateDir(repoDir),
        ...overrides,
      }),
  };
  try {
    await fn(env);
  } finally {
    await store.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/**
 * Every file under `root`, by forward-slash path relative to it, skipping
 * the read model's state directory.
 */
export async function readTree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  try {
    for await (const entry of walk(root, { includeDirs: false })) {
      const rel = relative(root, entry.path).split(SEPARATOR).join("/");
      if (rel.split("/")[0] === READ_MODEL_STATE_DIR) continue;
      files.set(rel, await sha256Hex(await Deno.readFile(entry.path)));
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** A catalog's rows and rename forwards, in key order, tags normalised. */
export function readCatalog(path: string): {
  rows: Record<string, unknown>[];
  renames: Record<string, unknown>[];
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = (db.prepare(
      "SELECT * FROM catalog ORDER BY namespace, type_normalized, model_id, data_name, version",
    ).all() as Record<string, unknown>[]).map((row) => ({
      ...row,
      // v3 keeps a version's tags in key order (dataVersionOp), v2 in the
      // order they were saved; both mean the same tags.
      tags: sortedJson(row.tags as string),
    }));
    const renames = db.prepare(
      "SELECT * FROM catalog_renames ORDER BY namespace, type_normalized, model_id, data_name",
    ).all() as Record<string, unknown>[];
    return { rows, renames };
  } finally {
    db.close();
  }
}

/** The v3 catalog file of a repository's read model. */
export function catalogV3Path(env: V3Env): string {
  return join(env.stateDir, CATALOG_V3_FILE);
}

/** Everything a read model produced: files, catalog and index. */
export async function observeReadModel(
  env: V3Env,
  readModel: SqliteReadModel,
  partitions: readonly { namespace: string; partition: PartitionKey }[],
): Promise<unknown> {
  const files: Record<string, Record<string, string>> = {};
  for (const { namespace } of partitions) {
    files[namespace] = Object.fromEntries(
      await readTree(env.cacheRoot(namespace)),
    );
  }
  const index: Record<string, unknown> = {};
  for (const { namespace, partition } of partitions) {
    index[`${namespace}|${partition}`] = (await readModel.liveRecords(
      namespace,
      partition,
    )).map((r) => ({
      key: r.key.toString(),
      sha256: r.sha256,
      content: r.content.kind === "blob" ? r.content.blob.toJSON() : r.content,
    }));
  }
  return { files, catalog: readCatalog(catalogV3Path(env)), index };
}

/** Builds a commit with test defaults. */
export function commitOf(
  props: Pick<CommitProps, "seq" | "partition" | "namespace"> & {
    ops: readonly Op[];
  },
): Commit {
  return Commit.create({
    txnId: `txn-${crypto.randomUUID()}`,
    writer: { host: "host-a", pid: 4242, instance: "cli-1" },
    at: "2026-10-11T00:00:00.000Z",
    ...props,
  });
}

/** Canonical base64 of bytes. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sortedJson(text: string): string {
  const value = JSON.parse(text) as Record<string, unknown>;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  );
}

/**
 * {@link withV3Env}, then checks that every commit the scenario landed
 * passes the binding rules serve applies to a forwarded commit
 * (swamp-club#3915): the write-path audit. The staging gates run through
 * it, so a repository write whose key, op kind or data-version pairing a
 * forwarded commit would be refused for fails its gate.
 */
export async function withAuditedV3Env(
  fn: (env: V3Env) => Promise<void>,
): Promise<void> {
  await withV3Env(async (env) => {
    await fn(env);
    await assertCommitsBind(env.store);
  });
}

/** Asserts every commit in `store` passes {@link checkCommitBindings}. */
export async function assertCommitsBind(
  store: SqliteCommitStore,
): Promise<void> {
  let cursor = 0;
  for (;;) {
    let page;
    try {
      page = await store.changesSince(cursor, 1_000);
    } catch (error) {
      // A scenario that compacted its history keeps no feed below the
      // compaction point: what it left above it is still checked.
      if (!(error instanceof CommitsCompactedError)) throw error;
      cursor = error.point;
      continue;
    }
    if (page.length === 0) return;
    for (const { commit } of page) {
      const result = checkCommitBindings(commit.partition, commit.ops);
      if (!result.ok) {
        throw new Error(
          `A repository write would be refused when forwarded: ` +
            `${result.reason}: ${result.message} in ${commit.partition}: ` +
            JSON.stringify(
              commit.toJSON().ops.map((op) => ({ ...op, inline: undefined })),
            ),
        );
      }
    }
    cursor = page[page.length - 1].cursor;
  }
}
