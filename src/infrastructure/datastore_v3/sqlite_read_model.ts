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
 * The v3 read model (swamp-club#3239): brings one checkout's local files, its
 * v3 catalog and the live-record index up to date with the commit store.
 * Dormant: nothing in production opens it yet.
 *
 * - **Order of effects.** For each commit: files first (written durably),
 *   then the catalog, then one state transaction holding the index, the
 *   partition's applied seq and the cursor. Every effect is idempotent, so a
 *   crash anywhere is repaired by catching up again from the unchanged
 *   cursor, and the index and cursor are never ahead of the files.
 * - **Repositories write the same files.** In Phase 3 repositories still
 *   write local files themselves; applying a commit this process just made
 *   rewrites the same bytes.
 * - **Serialized.** Calls queue in the process, and an exclusive lock on
 *   `read_model.lock` in the state directory serializes processes, so a slow
 *   catch-up never rewrites a file a faster one already removed.
 * - **Rebuilds.** When the catalog's generation changes (it was rebuilt
 *   empty or invalidated), or the catalog is not marked populated (its file
 *   was deleted and created afresh), the state is reset and every commit is
 *   applied again.
 *
 * @module
 */

import { getLogger } from "@logtape/logtape";
import { dirname, join } from "@std/path";
import {
  type CatalogProjection,
  projectCatalog,
} from "../../domain/datastore_v3/catalog_projection.ts";
import type { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  type CommitChange,
  CommitsCompactedError,
  type CommitStore,
} from "../../domain/datastore_v3/commit_store.ts";
import type { PutOp } from "../../domain/datastore_v3/op.ts";
import {
  decideFile,
  finalKeyStates,
  type KeyChange,
} from "../../domain/datastore_v3/materialisation.ts";
import type { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import {
  type CatchUpResult,
  type LiveRecord,
  type ReadModel,
  ReadModelApplyError,
  ReadModelIncompleteError,
} from "../../domain/datastore_v3/read_model.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  type Namespace,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import { cleanupEmptyParentDirs } from "../persistence/directory_cleanup.ts";
import {
  assertContainedPath,
  assertSafePath,
  PathTraversalError,
} from "../persistence/safe_path.ts";
import { syncDirectory, writeFileDurably } from "./atomic_stream_write.ts";
import {
  type AppliedRecord,
  type FileOwnership,
  ReadModelState,
} from "./read_model_state.ts";
import { refusedKeyReason } from "./record_path_guard.ts";
import { type ReadModelCatalog, V3Catalog } from "./v3_catalog.ts";

const logger = getLogger(["swamp", "datastore", "read-model"]);

/** Commits read per page by default. */
export const DEFAULT_READ_MODEL_PAGE_SIZE = 500;

/** The v3 catalog's file in the state directory. */
export const CATALOG_V3_FILE = "_catalog_v3.db";

/** The state database's file in the state directory. */
export const READ_MODEL_STATE_FILE = "_read_model_v3.db";

/** The lock file in the state directory. */
export const READ_MODEL_LOCK_FILE = "read_model.lock";

/** Options for {@link SqliteReadModel.open}. */
export interface SqliteReadModelOptions {
  /** The commit store to read; never written. */
  readonly commitStore: CommitStore;
  /** Where put content stored as chunks is read from. */
  readonly chunkStore: ChunkStore;
  /** The cache directory a namespace's record keys are relative to. */
  readonly cacheRoot: (namespace: string) => string;
  /**
   * The read model's own directory (`readModelStateDir(repoDir)` in
   * `record_path_guard.ts`): the catalog, the state and the lock.
   */
  readonly stateDir: string;
  /** Commits read per page; {@link DEFAULT_READ_MODEL_PAGE_SIZE}. */
  readonly pageSize?: number;
  /** The catalog to write; `_catalog_v3.db` in the state directory by default. */
  readonly catalog?: ReadModelCatalog;
}

/** The {@link ReadModel} over SQLite state and the local filesystem. */
export class SqliteReadModel implements ReadModel {
  readonly #commitStore: CommitStore;
  readonly #chunkStore: ChunkStore;
  readonly #cacheRoot: (namespace: string) => string;
  readonly #stateDir: string;
  readonly #pageSize: number;
  readonly #catalog: ReadModelCatalog;
  readonly #state: ReadModelState;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  private constructor(
    options: SqliteReadModelOptions,
    pageSize: number,
    catalog: ReadModelCatalog,
    state: ReadModelState,
  ) {
    this.#commitStore = options.commitStore;
    this.#chunkStore = options.chunkStore;
    this.#cacheRoot = options.cacheRoot;
    this.#stateDir = options.stateDir;
    this.#pageSize = pageSize;
    this.#catalog = catalog;
    this.#state = state;
  }

  /** Opens the read model, creating its state directory and files when absent. */
  static open(options: SqliteReadModelOptions): SqliteReadModel {
    const pageSize = options.pageSize ?? DEFAULT_READ_MODEL_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new Error(`pageSize must be a positive integer: ${pageSize}`);
    }
    const state = ReadModelState.open(
      join(options.stateDir, READ_MODEL_STATE_FILE),
    );
    try {
      const catalog = options.catalog ??
        V3Catalog.open(join(options.stateDir, CATALOG_V3_FILE));
      return new SqliteReadModel(options, pageSize, catalog, state);
    } catch (error) {
      state.close();
      throw error;
    }
  }

  catchUp(signal: AbortSignal): Promise<CatchUpResult> {
    return this.#exclusive(async () => {
      let applied = 0;
      for (;;) {
        signal.throwIfAborted();
        let page;
        try {
          page = await this.#commitStore.changesSince(
            this.#state.cursor(),
            this.#pageSize,
          );
        } catch (error) {
          if (!(error instanceof CommitsCompactedError)) throw error;
          await this.#loadBase(signal);
          continue;
        }
        for (const change of page) {
          signal.throwIfAborted();
          if (await this.#apply(change, true, signal)) applied++;
        }
        if (page.length < this.#pageSize) break;
      }
      // The whole feed is applied: the index holds every live record. This is
      // its own transaction; a crash before it leaves the index marked
      // incomplete until the next catch-up, which only delays reads.
      this.#state.markComplete();
      return { applied, cursor: this.#state.cursor() };
    });
  }

  catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<CatchUpResult> {
    return this.#exclusive(async () => {
      let applied = 0;
      for (;;) {
        signal.throwIfAborted();
        const from = this.#state.appliedSeq(namespace, partition.toString()) +
          1;
        let page;
        try {
          page = await this.#commitStore.readPartition(
            namespace,
            partition,
            from,
            this.#pageSize,
          );
        } catch (error) {
          if (!(error instanceof CommitsCompactedError)) throw error;
          await this.#loadBase(signal);
          continue;
        }
        for (const change of page) {
          signal.throwIfAborted();
          if (await this.#apply(change, false, signal)) applied++;
        }
        if (page.length < this.#pageSize) break;
      }
      return { applied, cursor: this.#state.cursor() };
    });
  }

  liveRecords(
    namespace: string,
    partition: PartitionKey,
  ): Promise<readonly LiveRecord[]> {
    if (this.#closed) return Promise.reject(closedError());
    const records = this.#state.liveRecordsIfComplete(
      namespace,
      partition.toString(),
    );
    return records === undefined
      ? Promise.reject(new ReadModelIncompleteError())
      : Promise.resolve(records);
  }

  chunksInUse(namespace: string): Promise<ReadonlySet<string>> {
    if (this.#closed) return Promise.reject(closedError());
    const chunks = this.#state.chunksInUseIfComplete(namespace);
    return chunks === undefined
      ? Promise.reject(new ReadModelIncompleteError())
      : Promise.resolve(chunks);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    this.#catalog.close();
    this.#state.close();
  }

  /**
   * Runs `body` after every earlier call, holding the process lock, after
   * resetting the state if the catalog was rebuilt.
   */
  #exclusive<T>(body: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(closedError());
    const run = this.#queue.then(async () => {
      await Deno.mkdir(this.#stateDir, { recursive: true });
      const lock = await Deno.open(join(this.#stateDir, READ_MODEL_LOCK_FILE), {
        read: true,
        write: true,
        create: true,
      });
      try {
        await lock.lock(true);
        // A catalog rebuilt, invalidated or created afresh holds none of the
        // commits the state says are applied: start over.
        const generation = this.#catalog.generation();
        if (
          this.#state.catalogGeneration() !== generation ||
          !this.#catalog.isPopulated()
        ) {
          this.#state.reset(generation);
          this.#catalog.markPopulated(generation);
        }
        return await body();
      } finally {
        lock.close();
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Applies one commit; false when the partition already holds it. A feed
   * catch-up (`advance`) moves the store-wide cursor to the change's
   * position; a partition catch-up leaves it alone.
   */
  async #apply(
    change: CommitChange,
    advance: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const commit = change.commit;
    const cursor = advance ? change.cursor : undefined;
    const namespace = commit.namespace;
    const partition = commit.partition.toString();
    const appliedSeq = this.#state.appliedSeq(namespace, partition);
    if (commit.seq <= appliedSeq) {
      if (cursor !== undefined) this.#state.recordSkipped(cursor);
      return false;
    }
    const fail = (detail: string, cause?: unknown) =>
      new ReadModelApplyError(namespace, partition, commit.seq, detail, {
        cause,
      });
    if (commit.seq !== appliedSeq + 1) {
      throw fail(
        `the read model has applied seq ${appliedSeq} of this partition, so the next commit must be seq ${
          appliedSeq + 1
        }`,
      );
    }
    try {
      const records = new Map<string, AppliedRecord | null>();
      const files = new Map<string, FileOwnership>();
      for (const keyChange of finalKeyStates(commit)) {
        signal.throwIfAborted();
        const key = keyChange.key.toString();
        records.set(key, appliedRecord(keyChange.put));
        const file = await this.#materialise(
          commit,
          change.cursor,
          keyChange,
          signal,
        );
        if (file !== undefined) files.set(key, file);
      }
      const projection: CatalogProjection = projectCatalog(
        commit.ops,
        (name) => this.#state.liveVersions(namespace, partition, name),
      );
      this.#catalog.apply(namespace, commit.partition, projection.actions);
      this.#state.recordApplied({
        namespace,
        partition,
        seq: commit.seq,
        cursor,
        records,
        live: projection.live,
        files,
      });
      return true;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ReadModelApplyError) throw error;
      throw fail(errorMessage(error), error);
    }
  }

  /**
   * Writes or removes one key's file, and returns the file's new ownership;
   * undefined when the file was left alone.
   *
   * The file follows the change feed, not the order commits are applied in
   * (swamp-club#3256). Two partitions can write one key (a same-key
   * definition rename), and a partition catch-up applies one partition's
   * commits ahead of the feed. So a put writes only when it is newer in the
   * feed (`position`) than the put the file shows, and a tombstone removes
   * the file only while it shows the tombstoning partition's own put. The
   * removed put's position stays as the mark, so an older put of another
   * partition cannot bring the file back. A key only one partition writes
   * behaves as before: its positions only grow and it has one owner. A key
   * with no ownership (no put of it was applied) is removed as before.
   *
   * The decision reads the ownership as it was before this commit, which
   * {@link ReadModelState.recordApplied} replaces only after every file, so a
   * retry after a crash decides the same way.
   */
  async #materialise(
    commit: Commit,
    position: number,
    change: KeyChange,
    signal: AbortSignal,
  ): Promise<FileOwnership | undefined> {
    const key = change.key.toString();
    const path = await this.#target(
      commit.namespace,
      change.key,
      change.put !== null,
      `commit ${commit.seq} of ${commit.partition.toString()}`,
    );
    if (path === undefined) return undefined;

    const owner = commit.partition.toString();
    const decision = decideFile(
      this.#state.fileOwnership(commit.namespace, key),
      owner,
      position,
      change.put !== null,
    );
    if (decision.kind === "keep") return undefined;
    if (decision.kind === "remove" || change.put === null) {
      await removeRecordFile(path);
      await cleanupEmptyParentDirs(path, this.#cacheRoot(commit.namespace));
      return decision.kind === "remove" ? decision.next : undefined;
    }
    const blob = "blob" in change.put.content
      ? change.put.content.blob
      : undefined;
    if (blob?.legacyKey !== undefined) {
      throw new ReadModelApplyError(
        commit.namespace,
        commit.partition.toString(),
        commit.seq,
        legacyBlobDetail(key, blob.legacyKey.toString()),
      );
    }
    await this.#writeContent(
      commit.namespace,
      path,
      change.put.content,
      signal,
    );
    return decision.next;
  }

  /**
   * The path to write (`isPut`) or remove a key at, or undefined when the
   * key must be left alone: a refused key, a file and a directory claiming
   * one path, or a path resolving into the state directory. `source` names
   * where the change came from, for the log.
   */
  async #target(
    namespace: string,
    recordKey: RecordKey,
    isPut: boolean,
    source: string,
  ): Promise<string | undefined> {
    const root = this.#cacheRoot(namespace);
    const key = recordKey.toString();
    const skip = (reason: string): undefined => {
      logger.warn`Not materialising ${key} from ${source}: ${reason}`;
      return undefined;
    };
    const refused = refusedKeyReason(recordKey, root, this.#stateDir);
    if (refused !== undefined) return skip(refused);
    assertContainedPath(key, root);
    const segments = key.split("/");
    const path = join(root, ...segments);
    // A file and a directory claiming one path is permanent: retrying would
    // block every later commit. A put is skipped like a refused key, and stays
    // indexed. Under a file, a tombstone has nothing to remove.
    const conflict = await pathConflict(root, segments);
    if (conflict?.kind === "under-file") {
      return isPut ? skip(conflict.reason) : undefined;
    }
    if (conflict?.kind === "directory" && isPut) {
      return skip(conflict.reason);
    }
    await assertSafePath(path, root);
    // The lexical guard cannot see a symlink already in the cache that leads
    // into the state directory; the resolved path can.
    if (await resolvesInside(path, this.#stateDir)) {
      return skip("it resolves into the read model's state directory");
    }
    return path;
  }

  /**
   * Loads the compacted base (swamp-club#3258), for a checkout whose cursor
   * is below the compaction point, or a partition catch-up from at or below
   * its compacted seq. The commits it needs are gone, so it reconciles with
   * the base instead and leaves the cursor at the point:
   *
   * 1. Stage the base in the state database, page by page. A page read at
   *    another compaction point means the base changed mid-read: start
   *    again.
   * 2. Files: record which keys it is about to touch, then remove the files
   *    the base does not show, and write those whose put differs from the
   *    state's, through the same guards as a commit.
   * 3. Catalog: record which names it is about to touch, then replace each
   *    name's rows and forward with the base's.
   * 4. One state transaction swaps the base in and moves the cursor.
   *
   * Each step can run again, and the state moves last, so a crash anywhere
   * repeats the load. The touched keys and names make a retry against a
   * newer base reconcile what an earlier attempt wrote.
   */
  async #loadBase(signal: AbortSignal): Promise<void> {
    let point: number | undefined;
    for (let staged = false; !staged;) {
      this.#state.beginLoad();
      point = undefined;
      let after: string | undefined;
      staged = true;
      do {
        signal.throwIfAborted();
        const page = await this.#commitStore.readCompactedBase(
          after,
          this.#pageSize,
        );
        if (point !== undefined && page.point !== point) {
          staged = false;
          break;
        }
        point = page.point;
        this.#state.stageBase(page.entries);
        after = page.next;
      } while (after !== undefined);
    }
    if (point === undefined) return;

    const removals = this.#state.loadRemovals();
    const writes = this.#state.loadWrites();
    this.#state.touchKeys([...removals, ...writes]);
    for (const { namespace, record_key } of removals) {
      signal.throwIfAborted();
      const path = await this.#target(
        namespace,
        RecordKey.create(record_key),
        false,
        "the compacted base",
      );
      if (path === undefined) continue;
      await removeRecordFile(path);
      await cleanupEmptyParentDirs(path, this.#cacheRoot(namespace));
    }
    for (const { namespace, record_key } of writes) {
      signal.throwIfAborted();
      const content = this.#state.loadContent(namespace, record_key);
      if (content === undefined) {
        throw new Error(
          `The compacted base shows ${record_key} present but holds no record for it`,
        );
      }
      if ("blob" in content && content.blob.legacyKey !== undefined) {
        throw new Error(
          legacyBlobDetail(record_key, content.blob.legacyKey.toString()),
        );
      }
      const path = await this.#target(
        namespace,
        RecordKey.create(record_key),
        true,
        "the compacted base",
      );
      if (path === undefined) {
        // A replay never records ownership of a key the guards skip; the
        // fold judged it from the key string alone, so forget it here.
        this.#state.dropLoadFile(namespace, record_key);
        continue;
      }
      await this.#writeContent(namespace, path, content, signal);
    }

    const names = this.#state.loadCatalogNames();
    this.#state.touchNames(names);
    for (const name of names) {
      signal.throwIfAborted();
      const partition = PartitionKey.parse(name.partition);
      if (partition.identity.kind !== "model") continue;
      const state = this.#state.loadCatalogName(name);
      this.#catalog.apply(name.namespace, partition, [
        { kind: "remove-name", name: name.name },
        { kind: "end-forward", name: name.name },
        ...state.rows.map((metadata) => ({
          kind: "upsert-version" as const,
          metadata,
        })),
        ...(state.forward === undefined
          ? []
          : [{ kind: "forward" as const, name: name.name, to: state.forward }]),
      ]);
    }
    this.#state.finishLoad(point);
  }

  /** Writes a record's content durably at `path`: inline bytes, or its chunks. */
  async #writeContent(
    namespace: string,
    path: string,
    content: { readonly blob: BlobRef } | { readonly inline: string },
    signal: AbortSignal,
  ): Promise<void> {
    if ("inline" in content) {
      await writeFileDurably(path, decodeBase64(content.inline), signal);
      return;
    }
    await writeFileDurably(
      path,
      this.#chunkStore.read(namespaceOf(namespace), content.blob, signal),
      signal,
    );
  }
}

function appliedRecord(put: PutOp | null): AppliedRecord | null {
  if (put === null) return null;
  return "blob" in put.content
    ? { sha256: put.sha256, blob: put.content.blob }
    : { sha256: put.sha256 };
}

/**
 * Removes a record's file. A missing file is fine. A directory at the key (a
 * tombstone of a name directory) is removed only when empty: its files are
 * other records.
 */
async function removeRecordFile(path: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  if (info.isDirectory) {
    for await (const _ of Deno.readDir(path)) return;
  }
  await Deno.remove(path);
  await syncDirectory(dirname(path));
}

/** A file and a directory claiming one path: which one, and why. */
interface PathConflict {
  /** `under-file`: an ancestor is a file. `directory`: the path is one. */
  readonly kind: "under-file" | "directory";
  readonly reason: string;
}

/** The conflict at `segments` under `root`, or undefined when there is none. */
async function pathConflict(
  root: string,
  segments: readonly string[],
): Promise<PathConflict | undefined> {
  for (let i = 1; i <= segments.length; i++) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(join(root, ...segments.slice(0, i)));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    const at = segments.slice(0, i).join("/");
    if (i < segments.length && !info.isDirectory) {
      return {
        kind: "under-file",
        reason: `${at} is a file, so it cannot hold a record`,
      };
    }
    if (i === segments.length && info.isDirectory) {
      return { kind: "directory", reason: `${at} is a directory` };
    }
  }
  return undefined;
}

/** True when `path`, symlinks followed, lies in or at `dir`. */
async function resolvesInside(path: string, dir: string): Promise<boolean> {
  try {
    await assertSafePath(path, dir);
    return true;
  } catch (error) {
    if (error instanceof PathTraversalError) return false;
    throw error;
  }
}

function legacyBlobDetail(key: string, legacyKey: string): string {
  return `the put of ${key} names a blob still in a pre-v3 layout (${legacyKey}), which the read model cannot read`;
}

function namespaceOf(namespace: string): Namespace {
  return namespace === "" ? SOLO_NAMESPACE : restoreNamespace(namespace);
}

function decodeBase64(inline: string): Uint8Array {
  const binary = atob(inline);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function closedError(): Error {
  return new Error("The read model is closed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
