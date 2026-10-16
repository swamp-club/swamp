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
 * Opens a v3 datastore for one checkout (swamp-club#3279): the commit store
 * at the datastore path, the chunk store beside it, and the checkout's read
 * model and catalog. It also builds the commit-log engine a repository
 * context commits through.
 *
 * A filesystem v3 datastore holds only its format marker, `commits.db`,
 * `_blobs/` and `_control/`. Every record lives in the checkout that
 * materialised it: the writer's repositories write it while they stage the
 * change, and every other checkout's read model writes it when it catches
 * up. So the cache root of namespace `ns` is `.swamp/` (solo) or
 * `.swamp/<ns>`, the layout `DefaultDatastorePathResolver` already gives a
 * repo-local datastore.
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import { ensureDirSync } from "@std/fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "@std/path";
import {
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import {
  getDatastoreDirectories,
  isAlwaysLocal,
} from "../../domain/datastore/datastore_config.ts";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  parseDatastoreFormatMarker,
  V3_DATASTORE_FORMAT,
} from "../../domain/datastore/datastore_format.ts";
import {
  compilePatterns,
  isExcludedCompiled,
} from "../../domain/datastore/datastore_pattern_matcher.ts";
import {
  type ChunkCollectionReport,
  ChunkCollector,
} from "../../domain/datastore_v3/chunk_collector.ts";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import { COMPACTED_TXN_RETENTION_MS } from "../../domain/datastore_v3/commit_outbox.ts";
import type { CompactionReport } from "../../domain/datastore_v3/commit_store.ts";
import {
  compactionBound,
  compactionTarget,
  DEFAULT_COMPACTION_POLICY,
  retentionOf,
} from "../../domain/datastore_v3/compaction_policy.ts";
import type { CommitWriter } from "../../domain/datastore_v3/commit.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import { CatalogStore } from "../persistence/catalog_store.ts";
import { writeDatastoreFormatMarker } from "../persistence/datastore_format_marker_writer.ts";
import { FileSystemStorage } from "../persistence/fs_datastore_storage.ts";
import { swampPath } from "../persistence/paths.ts";
import type {
  CommitLogEngine,
  CommitLogRootRunOptions,
  CommitLogRootView,
} from "../persistence/repo_unit_of_work.ts";
import { currentUnitOfWork } from "../persistence/unit_of_work_scope.ts";
import {
  commitLogParentFor,
  createCommitLogUnitOfWork,
  type UnitTracker,
} from "./commit_log_unit_of_work.ts";
import { recoverySince } from "./interrupted_writer_recovery.ts";
import { runInCommitLogRoot } from "./commit_log_root.ts";
import {
  createOutboxCommitSink,
  type OutboxCommitSink,
} from "./outbox_commit_sink.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import { registerOwnCommitWriter } from "./commit_outbox_recovery.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { readModelStateDir, v3CatalogPath } from "./record_path_guard.ts";
import { reconcileRefusedRuns } from "./refused_run_records.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import { SqliteReadModel } from "./sqlite_read_model.ts";
import { V3Catalog } from "./v3_catalog.ts";
import {
  litestreamStateDirName,
  replicationDirName,
} from "./litestream/replication_files.ts";
import { v3ReplicaSetting } from "./litestream/replica_setting.ts";

/**
 * Thrown when a read-only command stages a change on a v3 datastore
 * (swamp-club#3279). It holds no writer lock, so the change must not be
 * committed; a read-only command that writes is a bug to fix.
 */
export class ReadOnlyV3WriteError extends Error {
  constructor(readonly key: string) {
    super(
      `A read-only command tried to change ${key} on a v3 datastore; it holds ` +
        "no writer lock, so the change was refused",
    );
    this.name = "ReadOnlyV3WriteError";
  }
}

/** The commit store's file at the root of a filesystem v3 datastore. */
export const COMMITS_DB_FILE = "commits.db";

/**
 * The commit outbox's file (swamp-club#3490), beside whichever `commits.db`
 * a checkout uses: the datastore's, or while replicating its own copy's.
 */
export const COMMIT_OUTBOX_FILE = "commits-outbox.db";

/** The commit outbox beside the `commits.db` at `commitsDbPath`. */
export function v3OutboxPath(commitsDbPath: string): string {
  return join(dirname(commitsDbPath), COMMIT_OUTBOX_FILE);
}

const logger = getSwampLogger(["datastore", "v3"]);

/**
 * The checkout directory that holds its own copies of replicated v3
 * datastores' `commits.db` (swamp-club#3482), one subdirectory per
 * datastore.
 */
export const V3_LOCAL_COPIES_DIR = "_datastore_v3_copies";

/**
 * The `commits.db` the checkout at `repoDir` uses for the v3 datastore at
 * `datastorePath`. Without replication, the datastore's own, shared by
 * every checkout. While the internal replica setting names a replica
 * (swamp-club#3482), the checkout's own copy under `.swamp/`, keyed by the
 * datastore's canonical path: each copy is restored from the replica and
 * its writer replicates it, as each machine's copy is on a bucket.
 */
export function v3CommitsDbPath(
  datastorePath: string,
  repoDir: string,
): string {
  if (v3ReplicaSetting() === undefined) {
    return v3SharedCommitsDbPath(datastorePath);
  }
  const key = createHash("sha256").update(canonicalPath(datastorePath))
    .digest("hex").slice(0, 16);
  return swampPath(
    canonicalPath(repoDir),
    V3_LOCAL_COPIES_DIR,
    key,
    COMMITS_DB_FILE,
  );
}

/**
 * The datastore's own `commits.db`, which every checkout shares while
 * replication is off. While it is on, only the first writer reads it, to
 * seed its copy as the first lineage (swamp-club#3491).
 */
export function v3SharedCommitsDbPath(datastorePath: string): string {
  return join(datastorePath, COMMITS_DB_FILE);
}

/**
 * `path` with symlinks resolved, through its nearest existing parent when it
 * does not exist yet, so the key is the same before and after it is created
 * (`/tmp/x` and `/private/tmp/x` on macOS).
 */
function canonicalPath(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) return resolve(path);
    return join(canonicalPath(parent), basename(path));
  }
}

/** The cache root of namespace `namespace` in a checkout. */
export function v3CacheRoot(repoDir: string, namespace: string): string {
  return namespace === "" ? swampPath(repoDir) : swampPath(repoDir, namespace);
}

/** What {@link openV3Datastore} takes. */
export interface OpenV3DatastoreOptions {
  /** The checkout. */
  readonly repoDir: string;
  /** The filesystem datastore root, where the marker and `commits.db` are. */
  readonly datastorePath: string;
  /** The datastore namespace slug; empty or absent for a solo datastore. */
  readonly namespace?: string;
  /** This process's identity on every commit it writes. */
  readonly writer?: CommitWriter;
  /**
   * The repository's configured `directories` and `exclude`: a record key
   * outside the one or matching the other stays in the checkout and is never
   * committed, as v2 never syncs it (swamp-club#3279).
   */
  readonly directories?: readonly string[];
  readonly exclude?: readonly string[];
  /**
   * The fence of this process's writer lease, or undefined while it holds
   * none (swamp-club#3359). Every commit a unit makes names the fence the
   * lease held when the unit opened.
   */
  readonly writerFence?: () => number | undefined;
  /**
   * Throws when this process's writer lease was taken over or released;
   * checked before each commit is appended.
   */
  readonly assertWriterCurrent?: () => void;
  /**
   * Throws unless this checkout's copy of `commits.db` was made current
   * under the writer lease this process holds (swamp-club#3482): checked
   * before chunk collection, which deletes chunks no commit in the copy
   * names.
   */
  readonly assertCopyCurrent?: () => void;
  /**
   * Throws unless chunks may be collected from this checkout's copy
   * (swamp-club#3491): while replicating, only when no lineage but the
   * copy's current one can still be restored. Awaited after
   * `assertCopyCurrent`.
   */
  readonly assertCollectable?: () => Promise<void>;
  /**
   * The clock compaction and chunk collection read "now" from; the wall
   * clock by default. Tests pass one to age history without sleeping.
   */
  readonly clock?: () => Date;
}

/** What {@link V3Datastore.compactBefore} did. */
export interface CutoffCompaction {
  /**
   * Commits written before this instant are folded: the earlier of the
   * cutoff and the policy's safety window (`compactionBound`).
   */
  readonly bound: Date;
  /** The compaction point after it: the last cursor folded. */
  readonly compactedThrough: number;
  /** What was folded, or undefined when nothing older than `bound` was stored. */
  readonly report: CompactionReport | undefined;
}

/**
 * Whether a record key belongs to the datastore under the given layout: its
 * first segment is a datastore directory, and no exclude pattern matches it.
 * The same rule `DefaultDatastorePathResolver.resolvePath` applies on v2.
 */
export function datastoreKeyFilter(
  directories: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): (key: string) => boolean {
  const subdirs = new Set(
    getDatastoreDirectories({
      type: "filesystem",
      path: "",
      ...(directories !== undefined ? { directories: [...directories] } : {}),
    }),
  );
  const patterns = compilePatterns([...(exclude ?? [])]);
  return (key) => {
    const first = key.split("/")[0];
    if (!subdirs.has(first) || isAlwaysLocal(first)) return false;
    return patterns.length === 0 || !isExcludedCompiled(key, patterns);
  };
}

/** One checkout's handle on a v3 datastore. */
export interface V3Datastore {
  readonly datastorePath: string;
  /** The `commits.db` this handle opened: {@link v3CommitsDbPath}. */
  readonly commitsDbPath: string;
  readonly commitStore: SqliteCommitStore;
  /** The commit outbox beside the commit store (swamp-club#3490). */
  readonly outbox: SqliteCommitOutbox;
  readonly storage: FileSystemStorage;
  readonly chunkStore: ChunkStore;
  readonly readModel: SqliteReadModel;
  /** The checkout's v3 catalog, shared by the read model and the repositories. */
  readonly catalogStore: CatalogStore;
  readonly namespace: string;
  readonly writer: CommitWriter;
  /** Applies every commit this checkout has not applied yet. */
  catchUp(signal?: AbortSignal): Promise<void>;
  /**
   * Records that this process took the writer lease at `fence`: raises the
   * commit store's writer fence and records the fence in the outbox's chain
   * (swamp-club#3490). Every lease taken on this copy goes through it.
   *
   * @throws WriterFencedError when the store has seen a higher fence
   */
  raiseWriterFence(fence: number): Promise<void>;
  /** The commit store's writer fence: the floor for the next lease. */
  writerFence(): number | undefined;
  /**
   * Rebuilds this checkout from the commit log after a writer ended without
   * tearing down, removing the files it wrote since `since` (epoch
   * milliseconds) that no commit owns (swamp-club#3299). Resolves with their
   * record keys. Run it only while this process holds the writer lock.
   */
  recoverInterruptedWriter(
    since: number,
    signal?: AbortSignal,
  ): Promise<string[]>;
  /**
   * The work this checkout's units dropped and have not recovered
   * (swamp-club#3553): a refused commit, an abandon or a failed end left the
   * files their repositories wrote. `openUnits` counts the checkout's units
   * open now. Undefined when nothing was dropped.
   */
  droppedWork():
    | { readonly since: number; readonly openUnits: number }
    | undefined;
  /**
   * Rebuilds this checkout from the commit log with the swamp-club#3299
   * recovery, removing the files dropped work left, once no unit of the
   * checkout is open; roots wait while it runs. Resolves `clean` when
   * nothing was dropped, `busy` when a unit is open (nothing is done),
   * `recovered` otherwise. Run it only while this process holds a current
   * writer lease.
   */
  recoverDroppedWork(
    signal?: AbortSignal,
  ): Promise<"clean" | "busy" | "recovered">;
  /** Forgets the dropped work: the writer marker leaves it to the next command. */
  forgetDroppedWork(): void;
  /**
   * The commit-log engine for a repository context whose hook is
   * `markDirty`; `runRepo` gives the context's workflow run repository,
   * which settles refused run records.
   */
  engineFor(
    markDirty: MarkDirtyHook,
    runRepo: () => WorkflowRunRepository,
    options?: {
      /**
       * A read-only command's context: it never holds the writer lock, so
       * any change staged through it is refused with
       * {@link ReadOnlyV3WriteError} rather than committed.
       */
      readonly readOnly?: boolean;
    },
  ): CommitLogEngine;
  /**
   * Sweeps this datastore's unreferenced chunks in this checkout's namespace
   * past the default grace period (`swamp datastore gc`). Run it only while
   * this process holds the writer lock.
   */
  collectChunks(signal: AbortSignal): Promise<ChunkCollectionReport>;
  /**
   * Folds history the default policy no longer retains into the compacted
   * base, when enough has built up; resolves with what was folded, or
   * undefined when nothing was due. Run it only while this process holds the
   * writer lock: compaction is the single writer's (swamp-club#3258).
   */
  compactIfDue(signal: AbortSignal): Promise<CompactionReport | undefined>;
  /**
   * Folds every commit written before `cutoff` into the compacted base,
   * however few (swamp-club#3473): retention's deletes leave the content
   * they removed in history until it is folded. Never folds a commit newer
   * than `cutoff`, nor one inside the default policy's 7-day safety window
   * (the outbox's retry bound): the bound is the earlier of the two. A
   * remove is folded, and the chunks its content held released, only once
   * the remove itself is older than the bound; a chunk sweep then deletes
   * them past its grace period. Run it only while this process holds the
   * writer lock: like {@link compactIfDue} it passes the writer's fence.
   */
  compactBefore(cutoff: Date, signal: AbortSignal): Promise<CutoffCompaction>;
  /** How much history the commit log stores, for `datastore status`. */
  describe(): Promise<{ storedCommits: number; compactedThrough: number }>;
  /** Aborts in-flight commits and closes the stores. */
  close(): Promise<void>;
}

/** The writer identity of this process: one CLI invocation or one serve. */
export function processCommitWriter(): CommitWriter {
  return {
    host: Deno.hostname(),
    pid: Deno.pid,
    instance: crypto.randomUUID(),
  };
}

/**
 * Each checkout's open units and the dropped work it holds, by read-model
 * state directory (swamp-club#3553): every handle on a checkout shares its
 * files and catalog, and the recovery rebuilds them all.
 */
interface CheckoutUnits {
  open: number;
  /** The earliest open time of a root whose unit dropped work. */
  droppedSince?: number;
  /** The recovery running now, which new roots wait for. */
  recovering?: Promise<unknown>;
}

const checkoutUnits = new Map<string, CheckoutUnits>();

function checkoutUnitsFor(stateDir: string): CheckoutUnits {
  let units = checkoutUnits.get(stateDir);
  if (units === undefined) {
    units = { open: 0 };
    checkoutUnits.set(stateDir, units);
  }
  return units;
}

/**
 * Opens the v3 datastore at `options.datastorePath` for the checkout at
 * `options.repoDir`. Creates `commits.db` when absent (setup created the
 * marker first) and the checkout's read-model state directory.
 */
export function openV3Datastore(options: OpenV3DatastoreOptions): V3Datastore {
  // SQLite cannot open a database through a symlinked directory here, so the
  // stores open on canonical paths: a checkout or datastore reached through
  // a symlink works as its target does.
  ensureDirSync(readModelStateDir(options.repoDir));
  const repoDir = Deno.realPathSync(options.repoDir);
  const datastorePath = Deno.realPathSync(options.datastorePath);
  const namespace = options.namespace ?? "";
  const writer = options.writer ?? processCommitWriter();
  // Its outbox entries belong to units of this process (swamp-club#3490).
  registerOwnCommitWriter(writer);
  const admits = datastoreKeyFilter(options.directories, options.exclude);
  const commitsDbPath = v3CommitsDbPath(datastorePath, repoDir);
  ensureDirSync(dirname(commitsDbPath));
  const commitStore = SqliteCommitStore.open(commitsDbPath);
  const outbox = new SqliteCommitOutbox(v3OutboxPath(commitsDbPath));
  const storage = new FileSystemStorage(datastorePath);
  const chunkStore = new ChunkStore(storage);
  const stateDir = readModelStateDir(repoDir);
  ensureDirSync(stateDir);
  const catalogStore = new CatalogStore(v3CatalogPath(repoDir));
  const readModel = SqliteReadModel.open({
    commitStore,
    chunkStore,
    cacheRoot: (ns) => v3CacheRoot(repoDir, ns),
    stateDir,
    catalog: new V3Catalog(catalogStore),
  });
  // One sink for every engine on this handle: units serialize appends to a
  // partition per sink, so contexts that share the handle queue behind each
  // other. It refuses a commit, and its preparation, once the process's
  // writer lease is lost, and keeps each commit in the outbox until it
  // landed (swamp-club#3490).
  const sink: OutboxCommitSink = createOutboxCommitSink({
    commitStore,
    outbox,
    ...(options.assertWriterCurrent !== undefined
      ? { assertWriterCurrent: options.assertWriterCurrent }
      : {}),
  });
  // Bounds every commit's content uploads for the process's lifetime; close
  // aborts what is still in flight.
  const lifetime = new AbortController();
  const units = checkoutUnitsFor(stateDir);
  const tracker: UnitTracker = {
    opened: () => {
      units.open++;
    },
    ended: () => {
      units.open--;
    },
    dropped: (openedAt) => {
      units.droppedSince = Math.min(units.droppedSince ?? openedAt, openedAt);
    },
  };
  const unitNamespace = namespace === ""
    ? SOLO_NAMESPACE
    : restoreNamespace(namespace);
  let closed = false;
  const clock = options.clock ?? (() => new Date());

  /**
   * Compacts what the default policy no longer retains at `now`, before
   * `before` when given; undefined when nothing was due.
   */
  const compact = async (
    signal: AbortSignal,
    now: Date,
    before?: Date,
  ): Promise<CompactionReport | undefined> => {
    const policy = DEFAULT_COMPACTION_POLICY;
    const through = compactionTarget(
      await commitStore.compactionStatus(retentionOf(policy, now, before)),
      policy,
      before,
    );
    if (through === undefined) return undefined;
    const fence = options.writerFence?.();
    return await commitStore.compactHistory(through, {
      signal,
      clock,
      ...(fence !== undefined ? { fence } : {}),
      // No retry, from a unit or the outbox, is older than the bound.
      pruneTxnsBefore: new Date(now.getTime() - COMPACTED_TXN_RETENTION_MS),
    });
  };

  return {
    // The path as configured: the writer lock and callers key on it.
    datastorePath: options.datastorePath,
    commitsDbPath,
    commitStore,
    outbox,
    storage,
    chunkStore,
    readModel,
    catalogStore,
    namespace,
    writer,
    async catchUp(signal) {
      await readModel.catchUp(signal ?? lifetime.signal);
    },
    async raiseWriterFence(fence) {
      await commitStore.raiseWriterFence(fence);
      await outbox.recordFence(fence);
    },
    writerFence() {
      return commitStore.writerFence();
    },
    recoverInterruptedWriter(since, signal) {
      return readModel.recover(namespace, {
        since,
        admits,
        signal: signal ?? lifetime.signal,
      });
    },
    droppedWork() {
      return units.droppedSince === undefined
        ? undefined
        : { since: units.droppedSince, openUnits: units.open };
    },
    async recoverDroppedWork(signal) {
      const since = units.droppedSince;
      if (since === undefined) return "clean";
      if (units.open > 0) return "busy";
      const recovery = readModel.recover(namespace, {
        since: recoverySince(since),
        admits,
        signal: signal ?? lifetime.signal,
      });
      units.recovering = recovery;
      try {
        await recovery;
      } finally {
        units.recovering = undefined;
      }
      // Work dropped while it ran (none: no root opened) would be newer.
      if (units.droppedSince === since) units.droppedSince = undefined;
      return "recovered";
    },
    forgetDroppedWork() {
      units.droppedSince = undefined;
    },
    engineFor(markDirty, runRepo, engineOptions = {}) {
      const fenced = () => {
        const fence = options.writerFence?.();
        return fence === undefined ? {} : { fence };
      };
      const unitOptions = {
        admits: engineOptions.readOnly === true
          ? (key: string): boolean => {
            throw new ReadOnlyV3WriteError(key);
          }
          : admits,
        sink,
        chunkStore,
        namespace: unitNamespace,
        writer,
        signal: lifetime.signal,
        tracker,
      };
      return {
        openUnit(): UnitOfWork {
          return createCommitLogUnitOfWork(markDirty, {
            ...unitOptions,
            ...fenced(),
            parent: currentUnitOfWork(),
          });
        },
        hasOpenUnit(): boolean {
          return commitLogParentFor(markDirty, currentUnitOfWork()) !==
            undefined;
        },
        async runRoot<T>(
          rootOptions: CommitLogRootRunOptions<T>,
          fn: (root: CommitLogRootView) => Promise<T>,
        ): Promise<T> {
          // A recovery of dropped work rewrites the checkout: no root opens
          // while it runs (swamp-club#3553).
          await units.recovering?.catch(() => {});
          return await runInCommitLogRoot<T>({ markDirty }, {
            ...unitOptions,
            ...fenced(),
            ...(rootOptions.disposition !== undefined
              ? { disposition: rootOptions.disposition }
              : {}),
            ...(rootOptions.reconcileRuns === true
              ? {
                onRefused: (error) => reconcileRefusedRuns(runRepo(), error),
              }
              : {}),
          }, (root) => fn(root));
        },
      };
    },
    async collectChunks(signal) {
      options.assertCopyCurrent?.();
      await options.assertCollectable?.();
      const sweeper = crypto.randomUUID();
      return await new ChunkCollector({
        // A chunk an outbox entry names is about to be committed, or was
        // by a writer that died before its check (swamp-club#3490).
        commitStore: {
          async referencedChunks(ns, hashes, releasedSince) {
            const names = await commitStore.referencedChunks(
              ns,
              hashes,
              releasedSince,
            );
            const rest = hashes.filter((hash) => !names.has(hash));
            for (const hash of await outbox.referencedChunks(ns, rest)) {
              names.add(hash);
            }
            return names;
          },
        },
        storage,
        tempFiles: storage,
        sweep: {
          begin: () => outbox.beginSweep(sweeper, Date.now()),
          heartbeat: () => outbox.heartbeatSweep(sweeper, Date.now()),
          end: () => outbox.endSweep(sweeper),
        },
        ...(options.assertCopyCurrent !== undefined
          ? { assertMayDelete: options.assertCopyCurrent }
          : {}),
        clock,
      }).collect(unitNamespace, { signal });
    },
    compactIfDue(signal) {
      return compact(signal, clock());
    },
    async compactBefore(cutoff, signal) {
      const now = clock();
      const bound = compactionBound(DEFAULT_COMPACTION_POLICY, now, cutoff);
      const report = await compact(signal, now, cutoff);
      return {
        bound,
        compactedThrough: report?.point ??
          (await commitStore.history()).compactedThrough,
        report,
      };
    },
    describe() {
      return commitStore.history();
    },
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      try {
        await sink.retryOwedRemovals();
      } catch (error) {
        logger
          .warn`Discarding outbox entries of failed v3 commits failed again; the next writer may land them: ${error}`;
      }
      await readModel.close();
      await commitStore.close();
      await outbox.close();
    },
  };
}

/**
 * Whether `datastorePath` holds only a fresh v3 skeleton (swamp-club#3279):
 * a format-3 marker, a `commits.db` with no commits and an empty `_blobs/`
 * (any of the last two may be missing), and nothing else. What a setup that
 * stopped after writing the marker leaves; a re-run of setup takes it.
 */
export async function isFreshV3Skeleton(
  datastorePath: string,
): Promise<boolean> {
  const allowed = new Set([
    DATASTORE_FORMAT_MARKER_FILE,
    COMMITS_DB_FILE,
    `${COMMITS_DB_FILE}-wal`,
    `${COMMITS_DB_FILE}-shm`,
    "_blobs",
    // A writer's Litestream sidecar state (swamp-club#3416), present only
    // when replication is on.
    replicationDirName(COMMITS_DB_FILE),
    litestreamStateDirName(COMMITS_DB_FILE),
    // The commit outbox (swamp-club#3490), while it holds no entries.
    COMMIT_OUTBOX_FILE,
    `${COMMIT_OUTBOX_FILE}-wal`,
    `${COMMIT_OUTBOX_FILE}-shm`,
  ]);
  let hasMarker = false;
  for await (const entry of Deno.readDir(datastorePath)) {
    if (!allowed.has(entry.name)) return false;
    if (entry.name === DATASTORE_FORMAT_MARKER_FILE) hasMarker = true;
  }
  if (!hasMarker) return false;
  try {
    const marker = parseDatastoreFormatMarker(
      await Deno.readFile(join(datastorePath, DATASTORE_FORMAT_MARKER_FILE)),
      DATASTORE_FORMAT_MARKER_FILE,
    );
    if (marker.format !== V3_DATASTORE_FORMAT) return false;
  } catch {
    return false;
  }
  try {
    for await (const _ of Deno.readDir(join(datastorePath, "_blobs"))) {
      return false;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const outbox = new SqliteCommitOutbox(
    join(datastorePath, COMMIT_OUTBOX_FILE),
  );
  try {
    if (await outbox.hasEntries()) return false;
  } catch (error) {
    logger
      .debug`The commit outbox of ${datastorePath} could not be read, so it is not a fresh skeleton: ${error}`;
    return false;
  } finally {
    await outbox.close();
  }
  try {
    await Deno.lstat(join(datastorePath, COMMITS_DB_FILE));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return true;
    throw error;
  }
  const store = SqliteCommitStore.open(join(datastorePath, COMMITS_DB_FILE));
  try {
    const history = await store.history();
    return history.storedCommits === 0 && history.compactedThrough === 0;
  } finally {
    await store.close();
  }
}

/**
 * The namespaces that hold commits in the v3 datastore at `datastorePath`
 * (swamp-club#3301), as the checkout at `repoDir` sees it, sorted, the
 * unnamespaced "" left out. Empty when there is no `commits.db` yet. The
 * database is opened read-only, so this never creates, migrates or locks it
 * and runs beside a writer.
 */
export function listV3Namespaces(
  datastorePath: string,
  repoDir: string,
): string[] {
  const path = v3CommitsDbPath(datastorePath, repoDir);
  try {
    Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return queryNamespaces(new DatabaseSync(path, { readOnly: true }));
}

/** The non-empty namespaces of the partition heads in `db`, which it closes. */
function queryNamespaces(db: DatabaseSync): string[] {
  try {
    // A reader can meet a writer's lock while the WAL index is rebuilt.
    db.exec("PRAGMA busy_timeout=5000");
    // A partition head is written with every commit and never deleted, so
    // it names each namespace that ever committed, compacted or not.
    const rows = db.prepare(
      "SELECT DISTINCT namespace FROM partition_heads WHERE namespace != '' " +
        "ORDER BY namespace",
    ).all() as { namespace: string }[];
    return rows.map((row) => row.namespace);
  } finally {
    db.close();
  }
}

/**
 * Creates an empty v3 datastore at `datastorePath` (swamp-club#3279): the
 * format marker first, then `commits.db` and `_blobs/`. A crash part-way
 * leaves either an unmarked empty directory or a fresh skeleton
 * ({@link isFreshV3Skeleton}); a re-run of setup takes either, and here
 * completes a skeleton without writing its marker again.
 */
export async function initializeV3Datastore(
  datastorePath: string,
  writtenBy: string,
): Promise<void> {
  await Deno.mkdir(datastorePath, { recursive: true });
  const resuming = await isFreshV3Skeleton(datastorePath);
  if (!resuming) {
    await writeDatastoreFormatMarker(datastorePath, {
      format: V3_DATASTORE_FORMAT,
      minReaderFormat: V3_DATASTORE_FORMAT,
      writtenBy,
    });
  }
  // While replicating, each checkout keeps its own copy (swamp-club#3482):
  // the datastore holds no commits.db.
  if (v3ReplicaSetting() === undefined) {
    const store = SqliteCommitStore.open(
      join(datastorePath, COMMITS_DB_FILE),
    );
    await store.close();
  }
  await Deno.mkdir(join(datastorePath, "_blobs"), { recursive: true });
}
