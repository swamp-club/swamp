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
  CheckoutCopyAtRiskError,
  ReadModelApplyError,
  ReadModelCatchUpUnreachableError,
} from "../../domain/datastore_v3/read_model.ts";
import { isNetworkFailure } from "./network_failure.ts";
import {
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../../domain/datastore/unit_of_work.ts";
import {
  DEFAULT_DATASTORE_SUBDIRS,
  getDatastoreDirectories,
  isAlwaysLocal,
} from "../../domain/datastore/datastore_config.ts";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  DATASTORE_FORMAT_MARKER_MAX_BYTES,
  isBlankDatastoreFormatMarker,
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
import {
  type CommitOutbox,
  COMPACTED_TXN_RETENTION_MS,
} from "../../domain/datastore_v3/commit_outbox.ts";
import type {
  CommitStore,
  CompactionReport,
} from "../../domain/datastore_v3/commit_store.ts";
import {
  compactionBound,
  compactionTarget,
  DEFAULT_COMPACTION_POLICY,
  retentionOf,
} from "../../domain/datastore_v3/compaction_policy.ts";
import type { CommitWriter } from "../../domain/datastore_v3/commit.ts";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { CatalogStore } from "../persistence/catalog_store.ts";
import { writeDatastoreFormatMarker } from "../persistence/datastore_format_marker_writer.ts";
import { FileSystemStorage } from "../persistence/fs_datastore_storage.ts";
import { syncDirectory } from "../persistence/sync_directory.ts";
import { swampPath } from "../persistence/paths.ts";
import type {
  CommitLogEngine,
  CommitLogRootRunOptions,
  CommitLogRootView,
  OpenUnitCheckpoint,
} from "../persistence/repo_unit_of_work.ts";
import { currentUnitOfWork } from "../persistence/unit_of_work_scope.ts";
import {
  checkpointFrom,
  commitLogParentFor,
  createCommitLogUnitOfWork,
  type UnitTracker,
} from "./commit_log_unit_of_work.ts";
import { PartitionsRefusedError } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { recoverySince } from "./interrupted_writer_recovery.ts";
import { runInCommitLogRoot, wasThrownAfterCommit } from "./commit_log_root.ts";
import {
  createOutboxCommitSink,
  type OutboxCommitSink,
} from "./outbox_commit_sink.ts";
import { SqliteCommitOutbox } from "./sqlite_commit_outbox.ts";
import { registerOwnCommitWriter } from "./commit_outbox_recovery.ts";
import { localProcess } from "./process_identity.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { readModelStateDir, v3CatalogPath } from "./record_path_guard.ts";
import { reconcileRefusedRuns } from "./refused_run_records.ts";
import {
  COMMIT_STORE_SCHEMA_VERSION,
  SqliteCommitStore,
} from "./sqlite_commit_store.ts";
import {
  NOT_RELEASED,
  READ_MODEL_STATE_FILE,
  SqliteReadModel,
} from "./sqlite_read_model.ts";
import { ReadModelState } from "./read_model_state.ts";
import { V3Catalog } from "./v3_catalog.ts";
import {
  litestreamStateDirName,
  replicationDirName,
} from "./litestream/replication_files.ts";
import type { DatastoreStorage } from "../../domain/datastore/datastore_storage.ts";
import {
  V3_LOCAL_COPIES_DIR,
  v3BucketBindingAt,
  v3ReplicaFor,
} from "./v3_datastore_binding.ts";

export { V3_LOCAL_COPIES_DIR };

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

/**
 * Which of `hashes` the stored commits, the compacted base or the pending
 * commits of `namespace` name, released chunks never counting: the chunks
 * the checkout-copy guard stores again (swamp-club#3617). The outbox is
 * asked first: a writer prepares a commit in the outbox, appends it to
 * commits.db, then settles its entry, so asking commits.db first could
 * read it before the append and the outbox after the settle, and miss a
 * commit that named the chunk throughout.
 */
export async function referencedChunksOf(
  commitStore: Pick<CommitStore, "referencedChunks">,
  outbox: Pick<CommitOutbox, "referencedChunks">,
  namespace: string,
  hashes: readonly string[],
): Promise<Set<string>> {
  const names = await outbox.referencedChunks(namespace, hashes);
  const rest = hashes.filter((hash) => !names.has(hash));
  for (
    const hash of await commitStore.referencedChunks(
      namespace,
      rest,
      NOT_RELEASED,
    )
  ) {
    names.add(hash);
  }
  return names;
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
 * The `commits.db` the checkout at `repoDir` uses for the v3 datastore at
 * `datastorePath`. Without replication, the datastore's own, shared by
 * every checkout. While the internal replica setting names a replica
 * (swamp-club#3482), the checkout's own copy under `.swamp/`, keyed by the
 * datastore's canonical path: each copy is restored from the replica and
 * its writer replicates it, as each machine's copy is on a bucket. A v3
 * datastore on a bucket (swamp-club#3534) has only copies: its local root
 * is the copy's directory.
 */
export function v3CommitsDbPath(
  datastorePath: string,
  repoDir: string,
): string {
  if (v3BucketBindingAt(datastorePath) !== undefined) {
    return join(resolve(datastorePath), COMMITS_DB_FILE);
  }
  if (v3ReplicaFor(datastorePath) === undefined) {
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
 * The `commits.db` a filesystem v3 datastore's chunks are ordered before
 * (swamp-club#3737): its own, when only this machine's disk makes a commit
 * durable. Undefined, every chunk sync is a full one: on a bucket the
 * chunks are not on the filesystem, and while replicating Litestream ships
 * the commit to the replica before an ordering barrier has put its chunks
 * on the disk, so a power loss could leave the replica naming a lost chunk.
 */
export function v3ChunksOrderedBefore(
  datastorePath: string,
  commitsDbPath: string,
): string | undefined {
  if (v3BucketBindingAt(datastorePath) !== undefined) return undefined;
  if (v3ReplicaFor(datastorePath) !== undefined) return undefined;
  return commitsDbPath;
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

/** Error code for {@link V3CheckoutFilterChangedError}. */
export const V3_CHECKOUT_FILTER_CHANGED_CODE =
  "datastore_v3_directories_changed";

/**
 * The checkout filter inputs a v3 checkout's projection is built with
 * (swamp-club#3691), as stored: the configured directories (order and
 * duplicates aside; `null` for the default set, whether omitted or listed,
 * so a swamp that changes the default does not refuse its own checkouts)
 * and the exclude patterns. Without a `!` pattern every match excludes, so
 * order and duplicates do not matter and are dropped; with one, the last
 * match wins, so the patterns keep their order and a reordering is refused.
 */
function checkoutFilterInputs(
  directories: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): string {
  // Setup writes the default set out in full while an override such as
  // SWAMP_DATASTORE gives none: both are the default set.
  const listed = directories === undefined
    ? undefined
    : [...new Set(directories)].sort();
  const defaults = [...new Set<string>(DEFAULT_DATASTORE_SUBDIRS)].sort();
  const isDefault = listed === undefined ||
    (listed.length === defaults.length &&
      listed.every((dir, i) => dir === defaults[i]));
  // As compilePatterns reads them: trimmed, blank and comment lines dropped.
  const patterns = (exclude ?? []).map((p) => p.trim())
    .filter((p) => p !== "" && !p.startsWith("#"));
  return JSON.stringify({
    directories: isDefault ? null : listed,
    exclude: patterns.some((p) => p.startsWith("!"))
      ? patterns
      : [...new Set(patterns)].sort(),
  });
}

/**
 * The subdirectories a checkout built with the stored filter `inputs` keeps
 * local: the default datastore subdirectories its directories leave out.
 */
function localSubdirsOf(inputs: string): string[] {
  try {
    const parsed = JSON.parse(inputs) as { directories: string[] | null };
    if (parsed.directories === null) return [];
    const listed = new Set(parsed.directories);
    return DEFAULT_DATASTORE_SUBDIRS.filter((dir) =>
      !listed.has(dir) && !isAlwaysLocal(dir)
    );
  } catch {
    return [];
  }
}

/** Stored checkout filter inputs as a reader sees them. */
function describeCheckoutFilter(inputs: string): string {
  try {
    const parsed = JSON.parse(inputs) as {
      directories: string[] | null;
      exclude: string[];
    };
    const directories = parsed.directories === null
      ? "the default directories"
      : `directories [${parsed.directories.join(", ")}]`;
    return parsed.exclude.length === 0
      ? `${directories} and no exclude patterns`
      : `${directories} and exclude [${parsed.exclude.join(", ")}]`;
  } catch {
    return inputs;
  }
}

/**
 * Thrown when a v3 checkout is opened with other directories or exclude
 * patterns than its projection was built with (swamp-club#3691). The read
 * model never projects the keys the filter keeps local, and a rebuild would
 * lose the checkout's ownership of its files, so there is no re-projection.
 */
export class V3CheckoutFilterChangedError extends UserError {
  constructor(repoDir: string, projected: string, current: string) {
    const local = localSubdirsOf(projected);
    const localFiles = local.length === 0
      ? "the files its exclude patterns keep out of the datastore"
      : `${
        local.map((dir) => join(repoDir, ".swamp", dir)).join(", ")
      } and any file its exclude patterns keep out of the datastore`;
    super(
      `Changing directories on an existing v3 checkout is not supported ` +
        `yet. The repository's datastore config now gives ` +
        `${describeCheckoutFilter(current)}, but the checkout at ${repoDir} ` +
        `was built with ${describeCheckoutFilter(projected)}. The config is ` +
        `committed with the repository, so every existing checkout of it ` +
        `refuses on its next command until the two match again. Nothing was ` +
        `changed. Restore the previous directories (and exclude patterns) in ` +
        `the repository's datastore config. Otherwise, make a fresh checkout ` +
        `of the repository: it will not have this checkout's local-only ` +
        `files (${localFiles}), which were never committed, so copy them ` +
        `out of this checkout first.`,
      V3_CHECKOUT_FILTER_CHANGED_CODE,
    );
    this.name = "V3CheckoutFilterChangedError";
  }
}

/**
 * Refuses a checkout whose filter changed since its projection was built,
 * and records the filter of one that has none recorded (a projection from
 * before swamp-club#3691). Runs before anything of the datastore is
 * opened, so a refusal leaves nothing open and nothing written but the
 * state's own schema.
 *
 * @throws V3CheckoutFilterChangedError when the filter changed
 */
function assertCheckoutFilterUnchanged(
  repoDir: string,
  directories: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): void {
  const current = checkoutFilterInputs(directories, exclude);
  const state = ReadModelState.open(
    join(readModelStateDir(repoDir), READ_MODEL_STATE_FILE),
  );
  let projected: string;
  try {
    projected = state.stampFilterInputs(current);
  } finally {
    state.close();
  }
  if (projected !== current) {
    throw markErrorPaths(
      new V3CheckoutFilterChangedError(repoDir, projected, current),
      [repoDir],
    );
  }
}

/**
 * Why the v3 checkout at `repoDir` refuses to open with `directories` and
 * `exclude` ({@link V3CheckoutFilterChangedError}), or undefined when it
 * opens (`doctor datastores`). Reads its state without opening the
 * datastore, and records nothing.
 */
export function v3CheckoutFilterRefusal(
  repoDir: string,
  directories: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): string | undefined {
  let path: string;
  try {
    path = join(
      readModelStateDir(Deno.realPathSync(repoDir)),
      READ_MODEL_STATE_FILE,
    );
    if (!Deno.statSync(path).isFile) return undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  let projected: string | undefined;
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkout_filter'",
    ).get();
    if (table === undefined) return undefined;
    projected = (db.prepare(
      "SELECT inputs FROM checkout_filter WHERE only = 0",
    ).get() as { inputs: string } | undefined)?.inputs;
  } finally {
    db.close();
  }
  const current = checkoutFilterInputs(directories, exclude);
  return projected === undefined || projected === current
    ? undefined
    : new V3CheckoutFilterChangedError(repoDir, projected, current).message;
}

/** What {@link V3Datastore.collectChunks} verifies before it sweeps. */
export interface V3ChunkVerify {
  /** How many bytes of chunks to read and check. */
  readonly bytes: number;
  /** The shard prefix to start from; a random one unless given (tests). */
  readonly from?: string;
}

/** A random two-hex-digit shard prefix, where a verify pass starts. */
function randomShardPrefix(): string {
  const [byte] = crypto.getRandomValues(new Uint8Array(1));
  return byte.toString(16).padStart(2, "0");
}

/** One checkout's handle on a v3 datastore. */
export interface V3Datastore {
  readonly datastorePath: string;
  /** The `commits.db` this handle opened: {@link v3CommitsDbPath}. */
  readonly commitsDbPath: string;
  readonly commitStore: SqliteCommitStore;
  /** The commit outbox beside the commit store (swamp-club#3490). */
  readonly outbox: SqliteCommitOutbox;
  /**
   * The chunk storage: the datastore's own `_blobs/` on a filesystem, the
   * provider's `storage()` on a bucket (swamp-club#3534).
   */
  readonly storage: DatastoreStorage;
  readonly chunkStore: ChunkStore;
  readonly readModel: SqliteReadModel;
  /** The checkout's v3 catalog, shared by the read model and the repositories. */
  readonly catalogStore: CatalogStore;
  readonly namespace: string;
  readonly writer: CommitWriter;
  /** Applies every commit this checkout has not applied yet. */
  catchUp(signal?: AbortSignal): Promise<void>;
  /**
   * Records that this process took the writer lease at `fence`: notes the
   * fence in the outbox, raises the commit store's writer fence and records
   * the fence in the outbox's chain (swamp-club#3490, swamp-club#3586). The
   * two files share no transaction; the note lets the next record tell this
   * copy's own fence from another copy's when the record is lost. Every
   * lease taken on this copy goes through it.
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
   * this process holds the writer lock. With `verify`, first reads and
   * checks up to `verify.bytes` of chunks from a random shard prefix
   * (serve's maintenance timer, swamp-club#3617).
   */
  collectChunks(
    signal: AbortSignal,
    verify?: V3ChunkVerify,
  ): Promise<ChunkCollectionReport>;
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
  /**
   * Moves with every drop recorded (swamp-club#3586), so a recovery clears
   * only what was dropped before it started.
   */
  droppedGeneration: number;
  /**
   * The data version directories the dropped units created, by namespace
   * (swamp-club#3736): their recovery sweeps them whatever the mtimes.
   */
  droppedDirs: Map<string, Set<string>>;
  /** The recovery running now, which new roots wait for. */
  recovering?: Promise<unknown>;
}

const checkoutUnits = new Map<string, CheckoutUnits>();

/**
 * The chunk sweep batch running on each outbox's copy in this process, by
 * outbox path (swamp-club#3586). A sweep runs only under the writer lease,
 * so a writer that may overlap one is in the same process.
 */
const sweepBatches = new Map<string, Promise<void>>();

/** Resolves once the sweep batch running on the outbox at `path` is done. */
function sweepBatchAt(path: string): Promise<void> {
  return sweepBatches.get(path) ?? Promise.resolve();
}

/** Faults a test wraps around what {@link openV3Datastore} opens next. */
export interface V3DatastoreFaults {
  /** Wraps the chunk storage, as an unreachable bucket would fail it. */
  readonly wrapStorage?: (storage: DatastoreStorage) => DatastoreStorage;
  /** Wraps the commit sink, so a commit can fail where it appends. */
  readonly wrapSink?: (sink: OutboxCommitSink) => OutboxCommitSink;
}

let faultsForTesting: V3DatastoreFaults | undefined;

/**
 * Test seam: wraps the chunk storage and commit sink of every datastore
 * opened from now on; undefined restores the real ones.
 */
export function setV3DatastoreFaultsForTesting(
  faults: V3DatastoreFaults | undefined,
): void {
  faultsForTesting = faults;
}

/** Error code for {@link DroppedWorkRecoveryRunningError}. */
export const DROPPED_WORK_RECOVERY_RUNNING_CODE =
  "datastore_v3_dropped_work_recovery_running";

/** Thrown for a root opened while the checkout's dropped work is recovered. */
export class DroppedWorkRecoveryRunningError extends UserError {
  constructor() {
    super(
      "Swamp is still removing unfinished writes from this checkout, so a " +
        "change started now was refused and nothing from it was written. " +
        "Run the command again once the current one has finished.",
      DROPPED_WORK_RECOVERY_RUNNING_CODE,
    );
    this.name = "DroppedWorkRecoveryRunningError";
  }
}

function checkoutUnitsFor(stateDir: string): CheckoutUnits {
  let units = checkoutUnits.get(stateDir);
  if (units === undefined) {
    units = { open: 0, droppedGeneration: 0, droppedDirs: new Map() };
    checkoutUnits.set(stateDir, units);
  }
  return units;
}

/**
 * Opens the v3 datastore at `options.datastorePath` for the checkout at
 * `options.repoDir`. Creates `commits.db` when absent (setup created the
 * marker first) and the checkout's read-model state directory.
 *
 * @throws V3CheckoutFilterChangedError when the checkout's directories or
 *   exclude patterns changed since its projection was built
 */
export function openV3Datastore(options: OpenV3DatastoreOptions): V3Datastore {
  // SQLite cannot open a database through a symlinked directory here, so the
  // stores open on canonical paths: a checkout or datastore reached through
  // a symlink works as its target does.
  ensureDirSync(readModelStateDir(options.repoDir));
  const repoDir = Deno.realPathSync(options.repoDir);
  const datastorePath = Deno.realPathSync(options.datastorePath);
  const namespace = options.namespace ?? "";
  // Before anything else opens: the read model must never catch up, load
  // or recover under another filter than it projected with
  // (swamp-club#3691).
  assertCheckoutFilterUnchanged(repoDir, options.directories, options.exclude);
  const writer = options.writer ?? processCommitWriter();
  // Its outbox entries belong to units of this process (swamp-club#3490).
  registerOwnCommitWriter(writer);
  const admits = datastoreKeyFilter(options.directories, options.exclude);
  const commitsDbPath = v3CommitsDbPath(datastorePath, repoDir);
  ensureDirSync(dirname(commitsDbPath));
  const commitStore = SqliteCommitStore.open(commitsDbPath);
  const outbox = new SqliteCommitOutbox(v3OutboxPath(commitsDbPath), {
    // Recovery judges whether this process still runs by it
    // (swamp-club#3564).
    writerProcess: async () => (await localProcess()).identity,
  });
  const bucket = v3BucketBindingAt(datastorePath);
  // A filesystem datastore's storage also sweeps its stale temp files; a
  // provider's storage has none to sweep.
  const fsStorage = bucket === undefined
    ? new FileSystemStorage(datastorePath, {
      orderedBefore: v3ChunksOrderedBefore(datastorePath, commitsDbPath),
    })
    : undefined;
  const baseStorage: DatastoreStorage = bucket?.storage ?? fsStorage!;
  const storage = faultsForTesting?.wrapStorage?.(baseStorage) ?? baseStorage;
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
    // Never written onto this checkout's local tier (swamp-club#3691).
    checkout: { namespace, admits },
    // The checkout-copy guard stores again the chunks stored commits, the
    // compacted base or pending commits name, never released ones
    // (swamp-club#3617).
    referencedChunks: (ns, hashes) =>
      referencedChunksOf(commitStore, outbox, ns, hashes),
  });
  // One sink for every engine on this handle: units serialize appends to a
  // partition per sink, so contexts that share the handle queue behind each
  // other. It refuses a commit, and its preparation, once the process's
  // writer lease is lost, and keeps each commit in the outbox until it
  // landed (swamp-club#3490).
  const baseSink: OutboxCommitSink = createOutboxCommitSink({
    commitStore,
    outbox,
    sweepBatch: () => sweepBatchAt(outbox.path),
    ...(options.assertWriterCurrent !== undefined
      ? { assertWriterCurrent: options.assertWriterCurrent }
      : {}),
  });
  const sink = faultsForTesting?.wrapSink?.(baseSink) ?? baseSink;
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
    dropped: (openedAt, versionDirs) => {
      units.droppedSince = Math.min(units.droppedSince ?? openedAt, openedAt);
      units.droppedGeneration++;
      if (versionDirs.length === 0) return;
      let dirs = units.droppedDirs.get(namespace);
      if (dirs === undefined) {
        dirs = new Set();
        units.droppedDirs.set(namespace, dirs);
      }
      for (const dir of versionDirs) dirs.add(dir);
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
      try {
        await readModel.catchUp(signal ?? lifetime.signal);
      } catch (error) {
        // Cut off from the storage, the catch-up changed nothing past what
        // it applied, and the next one finishes it (swamp-club#3802).
        if (
          error instanceof ReadModelApplyError &&
          !(error instanceof CheckoutCopyAtRiskError) &&
          isNetworkFailure(error)
        ) {
          throw new ReadModelCatchUpUnreachableError(error);
        }
        throw error;
      }
    },
    async raiseWriterFence(fence) {
      // Noted first: a writer killed, or failing, before the record leaves
      // the note, and the next record continues the chain over it rather
      // than dropping this copy's prepared commits as another copy's.
      await outbox.notePendingFence(fence);
      await commitStore.raiseWriterFence(fence);
      // Only a copy of its own per checkout can meet another copy's fences.
      await outbox.recordFence(fence, {
        replicated: bucket !== undefined ||
          v3ReplicaFor(datastorePath) !== undefined,
      });
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
      const generation = units.droppedGeneration;
      if (since === undefined) return "clean";
      if (units.open > 0) return "busy";
      const recovery = readModel.recover(namespace, {
        since: recoverySince(since),
        admits,
        signal: signal ?? lifetime.signal,
        droppedDirs: [...units.droppedDirs.get(namespace) ?? []],
      });
      units.recovering = recovery;
      try {
        await recovery;
      } finally {
        units.recovering = undefined;
      }
      // A drop recorded while it ran stays owed to the next recovery.
      if (units.droppedGeneration === generation) {
        units.droppedSince = undefined;
        units.droppedDirs.clear();
      }
      return "recovered";
    },
    forgetDroppedWork() {
      units.droppedSince = undefined;
      units.droppedDirs.clear();
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
          const parent = currentUnitOfWork();
          // A root opening while dropped work is recovered would write into
          // a checkout the recovery is rewriting; it cannot wait, being
          // synchronous, so it is refused (swamp-club#3586). The recovery
          // runs at teardown, so only a straggler meets this. A child rolls
          // up into a root that is open, so no recovery is running.
          if (
            units.recovering !== undefined &&
            commitLogParentFor(markDirty, parent) === undefined
          ) {
            throw new DroppedWorkRecoveryRunningError();
          }
          return createCommitLogUnitOfWork(markDirty, {
            ...unitOptions,
            ...fenced(),
            parent,
          });
        },
        hasOpenUnit(): boolean {
          return commitLogParentFor(markDirty, currentUnitOfWork()) !==
            undefined;
        },
        async checkpointOpenUnit(): Promise<OpenUnitCheckpoint> {
          const unit = commitLogParentFor(markDirty, currentUnitOfWork());
          if (unit === undefined) return "no-unit";
          try {
            return await checkpointFrom(unit) ? "committed" : "no-unit";
          } catch (error) {
            if (error instanceof PartitionsRefusedError) return "refused";
            throw error;
          }
        },
        committedBeforeThrowing(error: unknown): boolean {
          return wasThrownAfterCommit(error);
        },
        async runRoot<T>(
          rootOptions: CommitLogRootRunOptions<T>,
          fn: (root: CommitLogRootView) => Promise<T>,
        ): Promise<T> {
          // A recovery of dropped work rewrites the checkout: no root opens
          // while it runs (swamp-club#3553). The root counts as open from
          // the call, so no recovery starts while it waits; its unit opens
          // synchronously once the count is handed over.
          units.open++;
          try {
            await units.recovering?.catch(() => {});
          } finally {
            units.open--;
          }
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
            ...(rootOptions.onEnded !== undefined
              ? { onEnded: rootOptions.onEnded }
              : {}),
          }, (root) => fn(root));
        },
      };
    },
    async collectChunks(signal, verify) {
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
        ...(fsStorage !== undefined ? { tempFiles: fsStorage } : {}),
        sweep: {
          begin: () => outbox.beginSweep(sweeper, Date.now()),
          heartbeat: () => outbox.heartbeatSweep(sweeper, Date.now()),
          end: () => outbox.endSweep(sweeper),
          // Writers that may overlap a batch wait for it (swamp-club#3586).
          async batch(run) {
            const done = run();
            const settled = done.then(() => {}, () => {});
            sweepBatches.set(outbox.path, settled);
            try {
              return await done;
            } finally {
              if (sweepBatches.get(outbox.path) === settled) {
                sweepBatches.delete(outbox.path);
              }
            }
          },
        },
        ...(options.assertCopyCurrent !== undefined
          ? { assertMayDelete: options.assertCopyCurrent }
          : {}),
        clock,
      }).collect(unitNamespace, {
        signal,
        ...(verify !== undefined && verify.bytes > 0
          ? {
            verifyBytes: verify.bytes,
            verifyFrom: verify.from ?? randomShardPrefix(),
          }
          : {}),
      });
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
 *
 * A setup that stopped before its marker reached the disk may have lost it
 * (swamp-club#3617): a missing or blank marker is taken only under a
 * stricter check, so that no datastore with history passes for a skeleton:
 * a `commits.db` that is a regular file holding a v3 commit log with no
 * partition heads and a compaction point of 0, or only what setup's open
 * leaves before the schema is written (no pages, or WAL mode and no
 * schema), and no replication or Litestream state.
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
  const names = new Set<string>();
  for await (const entry of Deno.readDir(datastorePath)) {
    if (!allowed.has(entry.name)) return false;
    names.add(entry.name);
  }
  const marker = await v3MarkerState(datastorePath);
  if (marker === "other") return false;
  const lost = marker !== "v3";
  if (
    lost && (names.has(replicationDirName(COMMITS_DB_FILE)) ||
      names.has(litestreamStateDirName(COMMITS_DB_FILE)))
  ) {
    return false;
  }
  // Without a regular-file commits.db nothing tells a lost marker's
  // skeleton from another directory; checked before the outbox is opened,
  // which would create it.
  if (lost) {
    try {
      const info = await Deno.lstat(join(datastorePath, COMMITS_DB_FILE));
      if (!info.isFile) return false;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
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
  if (lost) {
    try {
      const facts = readCommitLogFacts(join(datastorePath, COMMITS_DB_FILE));
      return facts.schemaVersion <= COMMIT_STORE_SCHEMA_VERSION &&
        facts.compactionPoint === 0 &&
        (facts.partitionHeads === 0 || facts.unschemaed);
    } catch (error) {
      logger
        .debug`The commit log of ${datastorePath} could not be read, so it is not a fresh skeleton: ${error}`;
      return false;
    }
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
 * completes a skeleton without writing its marker again, or writes the
 * marker a crash lost (swamp-club#3617).
 *
 * The marker is durable before `commits.db` exists (swamp-club#3617): the
 * parent of each directory this creates is synced first, the marker write
 * syncs the datastore directory, and only then is `commits.db` created.
 */
export async function initializeV3Datastore(
  datastorePath: string,
  writtenBy: string,
  options: {
    /** How a directory is synced (tests). */
    readonly syncDirectory?: (dir: string) => Promise<void>;
    /** How a blank marker is moved aside to remove it (tests). */
    readonly rename?: (from: string, to: string) => Promise<void>;
  } = {},
): Promise<void> {
  const syncDir = options.syncDirectory ?? syncDirectory;
  const created = await absentDirectories(datastorePath);
  await Deno.mkdir(datastorePath, { recursive: true });
  for (const dir of created) await syncDir(dirname(dir));
  const resuming = await isFreshV3Skeleton(datastorePath);
  const marker = resuming ? await v3MarkerState(datastorePath) : "absent";
  if (marker === "v3") {
    // A marker an older swamp linked without syncing the directory.
    await syncDir(datastorePath);
  } else {
    // A setup resuming beside this one may remove the blank marker and
    // write the v3 one first, as a racing restore may.
    if (marker === "blank") {
      await removeBlankMarker(datastorePath, options.rename);
    }
    try {
      await writeDatastoreFormatMarker(datastorePath, {
        format: V3_DATASTORE_FORMAT,
        minReaderFormat: V3_DATASTORE_FORMAT,
        writtenBy,
      }, { syncDirectory: syncDir });
    } catch (error) {
      // Only a resume lost a race: a fresh setup still refuses a marker
      // that appeared meanwhile.
      if (
        !resuming || !(error instanceof UserError) ||
        await v3MarkerState(datastorePath) !== "v3"
      ) {
        throw error;
      }
      // Durable before commits.db, whether or not the winner has synced.
      await syncDir(datastorePath);
    }
  }
  // While replicating, each checkout keeps its own copy (swamp-club#3482):
  // the datastore holds no commits.db.
  if (v3ReplicaFor(datastorePath) === undefined) {
    const store = SqliteCommitStore.open(
      join(datastorePath, COMMITS_DB_FILE),
    );
    await store.close();
  }
  await Deno.mkdir(join(datastorePath, "_blobs"), { recursive: true });
}

/**
 * Restores the format marker of the filesystem v3 datastore at
 * `datastorePath` that a crash lost (swamp-club#3617), for
 * `swamp doctor datastores --repair -y` in a repository whose config says
 * format 3. `commits.db` must be a regular file holding a v3 commit log at
 * a schema this swamp reads; it is opened read-write, without changing its
 * schema, so SQLite recovers a write-ahead log a crash left. A blank marker
 * is replaced. A valid v3 marker, there already or written meanwhile by
 * another restore, counts as restored. Resolves with the marker's path.
 *
 * @throws UserError when the datastore is not one whose marker can be
 *   restored, or something else is at the marker path
 */
export async function restoreV3FormatMarker(
  datastorePath: string,
  writtenBy: string,
  /** The marker writer's seams, and how a blank marker is moved aside (tests). */
  options: Parameters<typeof writeDatastoreFormatMarker>[2] & {
    readonly rename?: (from: string, to: string) => Promise<void>;
  } = {},
): Promise<string> {
  const commitsDb = join(datastorePath, COMMITS_DB_FILE);
  const markerPath = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  const refuse = (reason: string) =>
    markErrorPaths(
      new UserError(
        `The format marker of ${datastorePath} was not restored: ${reason}. ` +
          "Nothing was changed.",
      ),
      [datastorePath],
    );
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(commitsDb);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw refuse(`${commitsDb} does not exist`);
    }
    throw error;
  }
  if (!info.isFile) throw refuse(`${commitsDb} is not a regular file`);
  let facts: CommitLogFacts;
  try {
    facts = readCommitLogFacts(commitsDb);
  } catch (error) {
    throw refuse(
      `${commitsDb} could not be read as a v3 commit log (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (facts.schemaVersion > COMMIT_STORE_SCHEMA_VERSION) {
    throw refuse(
      `${commitsDb} is at schema version ${facts.schemaVersion}, newer than ` +
        `this swamp's ${COMMIT_STORE_SCHEMA_VERSION}: upgrade swamp`,
    );
  }
  if (facts.schemaVersion < 1 || facts.partitionHeads === undefined) {
    throw refuse(`${commitsDb} is not a v3 commit log`);
  }
  const marker = await v3MarkerState(datastorePath);
  if (marker === "v3") return markerPath;
  if (marker === "other") {
    throw refuse(`${markerPath} is not a marker a crash left blank`);
  }
  if (marker === "blank") {
    await removeBlankMarker(datastorePath, options.rename);
  }
  try {
    await writeDatastoreFormatMarker(datastorePath, {
      format: V3_DATASTORE_FORMAT,
      minReaderFormat: V3_DATASTORE_FORMAT,
      writtenBy,
    }, options);
  } catch (error) {
    // Another restore won the race: it wrote what this one would have.
    if (
      error instanceof UserError &&
      await v3MarkerState(datastorePath) === "v3"
    ) {
      return markerPath;
    }
    throw error;
  }
  return markerPath;
}

/**
 * Removes the blank marker of the datastore at `datastorePath`, which a
 * check found blank (swamp-club#3617). Another setup or restore may have
 * replaced it with a valid marker since, so it is first moved aside, and
 * deleted only if what was moved is still blank; anything else is put back
 * and left for the marker write that follows to find. Gone already is
 * fine: another process removed it.
 */
async function removeBlankMarker(
  datastorePath: string,
  rename: (from: string, to: string) => Promise<void> = Deno.rename,
): Promise<void> {
  const path = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  const aside = join(datastorePath, `.${crypto.randomUUID()}.tmp`);
  try {
    await rename(path, aside);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const bytes = await Deno.readFile(aside);
  if (!isBlankDatastoreFormatMarker(bytes)) {
    // Another process's marker: put back without replacing one written
    // meanwhile, which then stands instead.
    try {
      await Deno.link(aside, path);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) {
        // A filesystem without hard links: an exclusive create.
        await Deno.writeFile(path, bytes, { createNew: true }).catch(
          (createError) => {
            if (!(createError instanceof Deno.errors.AlreadyExists)) {
              throw createError;
            }
          },
        );
      }
    }
  }
  await Deno.remove(aside);
}

/**
 * What is at a filesystem datastore's format marker path: a marker that
 * says format 3 (`v3`), none (`absent`), a blank file a crash left
 * (`blank`, swamp-club#3617), or anything else (`other`).
 */
async function v3MarkerState(
  datastorePath: string,
): Promise<"v3" | "absent" | "blank" | "other"> {
  const path = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  let bytes: Uint8Array;
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile || info.size > DATASTORE_FORMAT_MARKER_MAX_BYTES) {
      return "other";
    }
    bytes = await Deno.readFile(path);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? "absent" : "other";
  }
  if (isBlankDatastoreFormatMarker(bytes)) return "blank";
  try {
    const marker = parseDatastoreFormatMarker(
      bytes,
      DATASTORE_FORMAT_MARKER_FILE,
    );
    return marker.format === V3_DATASTORE_FORMAT ? "v3" : "other";
  } catch {
    return "other";
  }
}

/** What a `commits.db` file says about its history (swamp-club#3617). */
interface CommitLogFacts {
  /** `PRAGMA user_version`: 0 for a file no schema was written to. */
  readonly schemaVersion: number;
  /** Rows in `partition_heads`; undefined when there is no such table. */
  readonly partitionHeads: number | undefined;
  /** The compaction point; 0 when there is none. */
  readonly compactionPoint: number;
  /**
   * Whether the file holds only what opening a new `commits.db` leaves
   * before its schema transaction commits: no schema at `user_version` 0,
   * and no pages or WAL mode. An unrelated SQLite file is neither.
   */
  readonly unschemaed: boolean;
}

/**
 * Reads {@link CommitLogFacts} from the `commits.db` file at `path`, which
 * must exist. It is opened read-write, so SQLite recovers a write-ahead log
 * a crash left, which a read-only open refuses to do, and its schema is
 * never changed.
 *
 * @throws when the file is not an SQLite database
 */
function readCommitLogFacts(path: string): CommitLogFacts {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const schemaVersion =
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    const hasTable = (name: string) =>
      db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(name) !== undefined;
    const partitionHeads = hasTable("partition_heads")
      ? Number(
        (db.prepare("SELECT COUNT(*) AS n FROM partition_heads").get() as {
          n: number;
        }).n,
      )
      : undefined;
    const compactionPoint = hasTable("compaction")
      ? Number(
        (db.prepare("SELECT point FROM compaction WHERE id = 1").get() as
          | { point: number }
          | undefined)?.point ?? 0,
      )
      : 0;
    const get = (pragma: string) =>
      Object.values(db.prepare(pragma).get() as Record<string, unknown>)[0];
    const unschemaed = schemaVersion === 0 &&
      Number(get("SELECT COUNT(*) FROM sqlite_master")) === 0 &&
      (Number(get("PRAGMA page_count")) === 0 ||
        get("PRAGMA journal_mode") === "wal");
    return { schemaVersion, partitionHeads, compactionPoint, unschemaed };
  } finally {
    db.close();
  }
}

/**
 * The directories from `dir` up that do not exist yet, deepest first: the
 * ones `mkdir` with `recursive` creates.
 */
async function absentDirectories(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (let current = resolve(dir);; current = dirname(current)) {
    try {
      await Deno.lstat(current);
      return missing;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    missing.push(current);
    if (dirname(current) === current) return missing;
  }
}
