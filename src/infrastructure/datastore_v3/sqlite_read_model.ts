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
 * - **Order of effects.** For each commit: files first, then the catalog,
 *   then one state transaction holding the index, the partition's applied
 *   seq and the cursor. Commits are applied a page at a time
 *   (swamp-club#3337), the page's state transactions held in one batch that
 *   commits after the page's files are written. Every effect is idempotent,
 *   so a crash anywhere is repaired by catching up again from the unchanged
 *   cursor, and the index and cursor are never ahead of the files.
 * - **Files are not synced** where the kernel names the boot (Linux,
 *   macOS). Only an OS crash or a power loss can lose a written file, and
 *   either ends the boot. The state lists every file a catch-up wrote or
 *   removed, with the boot; the first open in a later boot checks each
 *   against the state, and a file that does not match resets the state so
 *   every commit is applied again. Elsewhere each page's files are synced
 *   at its barrier.
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
 * - **The checkout-copy guard** (swamp-club#3617). Before a file over the
 *   inline limit that this section did not write is overwritten or removed,
 *   the committed chunks only it may still hold whole are stored again from
 *   it, or the file is moved aside into `at-risk/` in the state directory
 *   when the storage refuses them; a file that already holds the content
 *   stays, and only a copy of it goes aside. A replay over earlier puts
 *   therefore never destroys the only good copy of a torn or lost chunk.
 * - **Unreadable records** (swamp-club#3617). A put whose chunks cannot be
 *   read leaves its file absent and is recorded, instead of failing every
 *   later commit; a later catch-up writes it once its chunk changes.
 * - **What is never projected** (swamp-club#3691). Records of a namespace
 *   named after one of swamp's own `.swamp/` directories, and keys of the
 *   solo namespace or the checkout's own that its datastore filter leaves
 *   out (there `.swamp/` is its local tier), get no file and no catalog row.
 *   They stay in the index, and the cursor moves past them as usual.
 *
 * @module
 */

import { getLogger } from "@logtape/logtape";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, SEPARATOR } from "@std/path";
import {
  type CatalogProjection,
  projectCatalog,
} from "../../domain/datastore_v3/catalog_projection.ts";
import {
  ChunkIntegrityError,
  ChunkMissingError,
  ChunkPutError,
  type ChunkStore,
  type ContentPart,
  type ContentParts,
  type ContentRangeReader,
  storageNamespaceOf,
} from "../../domain/datastore_v3/chunk_store.ts";
import type { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  type CommitChange,
  CommitsCompactedError,
  type CommitStore,
} from "../../domain/datastore_v3/commit_store.ts";
import { MAX_INLINE_BYTES, type PutOp } from "../../domain/datastore_v3/op.ts";
import {
  decideFile,
  finalKeyStates,
  type KeyChange,
  type NetReplayPlan,
  NetReplayPlanner,
} from "../../domain/datastore_v3/materialisation.ts";
import type { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import {
  type CatchUpResult,
  CheckoutCopyAtRiskError,
  type LiveRecord,
  type ReadModel,
  ReadModelApplyError,
  ReadModelBusyError,
  ReadModelIncompleteError,
  type UnreadableRecord,
  unreadableRecordAdvice,
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
  PathTraversalError,
  resolveRealPath,
} from "../persistence/safe_path.ts";
import { DurableWriteBatch, syncDirectory } from "./atomic_stream_write.ts";
import {
  type FileAccess,
  satisfiesAccess,
} from "../../domain/datastore_v3/file_access.ts";
import { currentBootIdentity } from "./boot_identity.ts";
import { CatchUpStats } from "./catch_up_stats.ts";
import { withSpan } from "../tracing/tracer.ts";
import {
  type AppliedRecord,
  type FileOwnership,
  type LoadKey,
  ReadModelState,
  type RecordContent,
  type StoredAtRiskCopy,
  type StoredUnreadableRecord,
  type UnsyncedFile,
  type WrittenFile,
} from "./read_model_state.ts";
import {
  CATALOG_V3_FILE,
  isCheckoutLocalKey,
  isUnprojectedNamespace,
  MATERIALISED_SUBDIRS,
  refusedKeyReason,
} from "./record_path_guard.ts";
import {
  ProjectedCatalog,
  type ReadModelCatalog,
  V3Catalog,
} from "./v3_catalog.ts";

/** How many unsynced files one locked section of syncUnsyncedFiles syncs. */
export const UNSYNCED_SYNC_BATCH = 500;

/** How many batches one syncUnsyncedFiles call runs at most. */
const MAX_UNSYNCED_SYNC_BATCHES = 1_000;

const logger = getLogger(["swamp", "datastore", "read-model"]);

/** Commits read per page by default. */
export const DEFAULT_READ_MODEL_PAGE_SIZE = 500;

export { CATALOG_V3_FILE };

/** The state database's file in the state directory. */
export const READ_MODEL_STATE_FILE = "_read_model_v3.db";

/** The lock file in the state directory. */
export const READ_MODEL_LOCK_FILE = "read_model.lock";

/**
 * The directory in the state directory that checkout files are moved aside
 * into (swamp-club#3617): `at-risk/<storage namespace>/<sha256>`.
 */
export const AT_RISK_DIR = "at-risk";

/** The most bytes of at-risk copies made by copying across devices. */
export const DEFAULT_AT_RISK_COPY_BYTES = 1024 * 1024 * 1024;

/** At-risk copies one applying section tries to store at most. */
const AT_RISK_RETRIES = 8;

/** Unreadable records one catch-up looks at at most. */
const UNREADABLE_RETRIES = 32;

/**
 * How long an at-risk copy, or an unreadable record on a storage that
 * cannot read chunk sizes, waits between tries.
 */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How long a temp file of an at-risk copy (`.<uuid>.tmp`), left by a crash
 * mid-copy, stays before adoption removes it; one this process is still
 * writing is never removed (swamp-club#3617).
 */
export const AT_RISK_TEMP_GRACE_MS = 60 * 60 * 1000;

/**
 * Releases counted as references by the checkout-copy guard: none. A chunk
 * history compaction released may already be gone, and storing it again
 * would only feed the next sweep.
 */
export const NOT_RELEASED = new Date(8.64e15);

/**
 * Where an at-risk copy of content in `namespace` (a commit namespace,
 * `""` unnamespaced) with SHA-256 `sha256` lies under the read model's state
 * directory.
 */
export function atRiskCopyPath(
  stateDir: string,
  namespace: string,
  sha256: string,
): string {
  return join(
    stateDir,
    AT_RISK_DIR,
    storageNamespaceOf(namespaceOf(namespace)),
    sha256,
  );
}

/**
 * The checkout a read model projects into (swamp-club#3691): its own
 * namespace and its datastore key filter.
 */
export interface ReadModelCheckout {
  /** The checkout's namespace; `""` for a solo checkout. */
  readonly namespace: string;
  /**
   * Which record keys the checkout keeps in the datastore
   * (`datastoreKeyFilter`): the rest of its `.swamp/` subdirectories are its
   * local tier.
   */
  readonly admits: (key: string) => boolean;
}

/**
 * Why the read model never writes, removes or catalogues `key` of commit
 * namespace `namespace` (swamp-club#3691), or undefined when it may:
 *
 * - `reserved`: the namespace is named after one of swamp's own `.swamp/`
 *   directories ({@link isUnprojectedNamespace}).
 * - `local`: a key of the solo namespace, or of the checkout's own, that
 *   the checkout's filter leaves out. The solo namespace's cache root is
 *   `.swamp/`, where the checkout's local tier lives, and a checkout of the
 *   same namespace stamps its local rows with the same catalog identity, so
 *   such a key's file and rows are the checkout's own local data.
 */
export function unprojectedReason(
  namespace: string,
  key: string,
  checkout: ReadModelCheckout | undefined,
): "reserved" | "local" | undefined {
  if (isUnprojectedNamespace(namespace)) return "reserved";
  if (
    checkout !== undefined &&
    (namespace === "" || namespace === checkout.namespace) &&
    !checkout.admits(key)
  ) {
    return "local";
  }
  return undefined;
}

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
  /**
   * The checkout projected into (swamp-club#3691). Without it every key of
   * the solo and own namespaces is projected; reserved namespaces never are.
   */
  readonly checkout?: ReadModelCheckout;
  /**
   * Makes the batch each page writes through. By default one that does not
   * sync when the boot can be named, since the files are checked after a
   * reboot instead, and one that syncs when it cannot.
   */
  readonly writeBatch?: () => DurableWriteBatch;
  /** The current boot; {@link currentBootIdentity} by default. */
  readonly bootIdentity?: () => Promise<string | undefined>;
  /**
   * Which of `hashes` stored commits, the compacted base or pending
   * commits of `namespace` name (swamp-club#3617): the chunks the
   * checkout-copy guard stores again. Released chunks never count. By
   * default the commit store's references without releases.
   */
  readonly referencedChunks?: (
    namespace: string,
    hashes: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  /** The clock retries are timed by; the system clock by default. */
  readonly clock?: () => Date;
  /** How a file is moved aside; `Deno.rename` by default. For tests. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** How a directory is synced after a move aside. For tests. */
  readonly syncDirectory?: (dir: string) => Promise<void>;
  /**
   * How the recovery sweep lists a directory; `Deno.readDir` by default.
   * For tests, which list names as HFS+ does (swamp-club#3736).
   */
  readonly readDir?: (dir: string) => AsyncIterable<Deno.DirEntry>;
  /**
   * How a file the guard keeps in place, or links aside, is synced:
   * {@link syncExistingFile} by default. For tests.
   */
  readonly syncFile?: (path: string) => Promise<void>;
  /** {@link DEFAULT_AT_RISK_COPY_BYTES} by default. */
  readonly atRiskCopyBytes?: number;
  /**
   * The platform, which decides whether files the read model wrote are
   * recorded ({@link WrittenFile}); `Deno.build.os` by default. For tests.
   */
  readonly os?: typeof Deno.build.os;
  /**
   * False makes a catch-up from the start of the feed replay every commit in
   * full, as a recovery does; a net replay by default (swamp-club#3803).
   * Tests compare the two.
   */
  readonly netReplay?: boolean;
}

/** Where a guarded change comes from, for {@link CheckoutCopyAtRiskError}. */
interface ChangeSource {
  readonly partition: string;
  readonly seq: number;
}

/** No commit: the compacted base, a restart check or a sweep. */
const NO_COMMIT: ChangeSource = { partition: "", seq: 0 };

/** The {@link ReadModel} over SQLite state and the local filesystem. */
export class SqliteReadModel implements ReadModel {
  readonly #commitStore: CommitStore;
  readonly #chunkStore: ChunkStore;
  readonly #cacheRoot: (namespace: string) => string;
  readonly #stateDir: string;
  readonly #pageSize: number;
  readonly #catalog: ReadModelCatalog;
  readonly #state: ReadModelState;
  readonly #writeBatch: () => DurableWriteBatch;
  readonly #bootIdentity: () => Promise<string | undefined>;
  readonly #referencedChunks: (
    namespace: string,
    hashes: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  readonly #clock: () => Date;
  readonly #recordsWrittenFiles: boolean;
  readonly #rename: (from: string, to: string) => Promise<void>;
  readonly #readDir: (dir: string) => AsyncIterable<Deno.DirEntry>;
  readonly #syncDirectory: (dir: string) => Promise<void>;
  readonly #syncFile: (path: string) => Promise<void>;
  readonly #atRiskCopyBytes: number;
  readonly #netReplay: boolean;
  readonly #checkout: ReadModelCheckout | undefined;
  /** The reserved namespaces whose skipped commits were warned about. */
  readonly #warnedReserved = new Set<string>();
  /**
   * The files this exclusive section wrote, removed, or guarded already:
   * the guard never hashes one twice, nor one this section wrote.
   */
  readonly #guarded = new Set<string>();
  /**
   * Whether this section replays commits over files it did not write: it
   * began with a reset, or is a recovery. The guard then reads stored
   * parts of the right size too, and guards overwrites on a storage that
   * cannot read sizes.
   */
  #replaying = false;
  /** Set once the storage refused an at-risk copy's put as unauthorised. */
  #atRiskRefused = false;
  /** Settles when the page being applied, if any, commits or rolls back. */
  #pageInFlight: Promise<void> | undefined;
  /** The boot of the current exclusive section; undefined when unnamed. */
  #boot: string | undefined;
  /** What the running catch-up did, for its span (swamp-club#3803). */
  #stats: CatchUpStats | undefined;
  /** The running catch-up's net replay, if it is one (swamp-club#3803). */
  #net: NetReplayPlan | undefined;
  readonly #paths = new PathCache();
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
    const checkout = options.checkout;
    this.#checkout = checkout;
    // One filter for every catalog action, from commits and the compacted
    // base alike (swamp-club#3691).
    this.#catalog = new ProjectedCatalog(
      catalog,
      (namespace, key) =>
        unprojectedReason(namespace, key, checkout) !== undefined,
    );
    this.#state = state;
    this.#writeBatch = options.writeBatch ??
      (() => new DurableWriteBatch({ sync: this.#boot === undefined }));
    this.#bootIdentity = options.bootIdentity ?? currentBootIdentity;
    const commitStore = options.commitStore;
    this.#referencedChunks = options.referencedChunks ??
      ((namespace, hashes) =>
        commitStore.referencedChunks(namespace, hashes, NOT_RELEASED));
    this.#clock = options.clock ?? (() => new Date());
    // Deno reports an NTFS file id as a number that loses its low bits past
    // 2^53, so it does not name one file, and SQLite cannot read it back.
    this.#recordsWrittenFiles = (options.os ?? Deno.build.os) !== "windows";
    this.#rename = options.rename ?? Deno.rename;
    this.#readDir = options.readDir ?? Deno.readDir;
    this.#syncDirectory = options.syncDirectory ?? syncDirectory;
    this.#syncFile = options.syncFile ?? syncExistingFile;
    this.#atRiskCopyBytes = options.atRiskCopyBytes ??
      DEFAULT_AT_RISK_COPY_BYTES;
    this.#netReplay = options.netReplay ?? true;
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
    return this.#exclusive(
      () =>
        this.#counted("swamp.datastore.v3.readmodel.catchup", async () => {
          await this.#retryAtRiskCopies(signal);
          return await this.#catchUpFeed(signal, { net: true });
        }),
      signal,
    );
  }

  /** Runs `fn`, timing it as `phase` of the running catch-up, if any. */
  #time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    return this.#stats === undefined ? fn() : this.#stats.time(phase, fn);
  }

  #timeSync<T>(phase: string, fn: () => T): T {
    return this.#stats === undefined ? fn() : this.#stats.timeSync(phase, fn);
  }

  /**
   * Runs `fn` in a span named `name` that carries what it applied and
   * fetched (swamp-club#3803).
   */
  #counted<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return withSpan(name, {}, async (span) => {
      const stats = new CatchUpStats();
      this.#stats = stats;
      try {
        return await fn();
      } finally {
        this.#stats = undefined;
        span.setAttributes(stats.attributes());
      }
    });
  }

  /**
   * For a reader of a checkout another process writes (swamp-club#3803),
   * which reads the files as they are rather than replay older commits over
   * that writer's newer ones: resolves false at once while the index is
   * complete, as before. Otherwise a catch-up is in progress or was cut
   * short, and the files may be anywhere between two commits, so it waits
   * for the read model's lock (`read_model.lock`, the OS lock every
   * catch-up holds, released when its process ends however it ends) up to
   * `lockWaitMs`, then catches up itself if the index is still incomplete,
   * and resolves true.
   *
   * @throws ReadModelBusyError when the lock is not free within `lockWaitMs`
   */
  catchUpUnlessComplete(
    signal: AbortSignal,
    lockWaitMs: number,
  ): Promise<boolean> {
    if (this.#state.isComplete()) return Promise.resolve(false);
    return this.#exclusive(
      async () => {
        if (this.#state.isComplete()) return false;
        await this.#counted(
          "swamp.datastore.v3.readmodel.catchup",
          async () => {
            await this.#retryAtRiskCopies(signal);
            return await this.#catchUpFeed(signal, { net: true });
          },
        );
        return true;
      },
      signal,
      lockWaitMs,
    );
  }

  /**
   * Recovers the checkout of a writer that ended without tearing down
   * (swamp-club#3299): a SIGKILL, a crash or a forced exit left local files
   * and catalog rows its uncommitted units wrote. In one exclusive section,
   * empties the catalog, resets the state and replays every commit, which
   * puts back the committed version of every file the writer overwrote, then
   * removes each file no commit owns that the writer may have written.
   * Resolves with the removed files' record keys.
   *
   * Only the materialised subdirectories of `namespace`'s cache root are
   * swept, and in them only files `admits` admits that the checkout
   * projects ({@link unprojectedReason}, the check every other write and
   * removal makes) and that are not the checkout's own
   * (`isCheckoutLocalKey`: temporary files, locks, run indexes, run logs,
   * pulled extension sources). A file under one of `droppedDirs` (keys of
   * the version directories the dropped units allocated, swamp-club#3736)
   * is removed whatever its mtime: a unit may have moved an old file in.
   * Elsewhere only a file last modified at or after `since` (epoch
   * milliseconds) is, since nothing better is known there: after a crash,
   * or when the dropped work was left to the next command's recovery, no
   * list of allocated directories survives.
   *
   * A listed name is looked up as listed and composed (NFC): HFS+ lists
   * names decomposed while swamp commits them composed, so a committed
   * file must never be taken for an unowned one. A file is kept when either
   * spelling is owned, filtered out or the checkout's own, so on a
   * filesystem that keeps both spellings apart an unowned decomposed
   * sibling of an owned composed name is kept too: a stray file, never a
   * removed record.
   *
   * Run it only while this process holds the writer lock.
   */
  recover(
    namespace: string,
    options: {
      readonly since: number;
      readonly admits: (key: string) => boolean;
      readonly signal: AbortSignal;
      readonly droppedDirs?: readonly string[];
    },
  ): Promise<string[]> {
    return this.#exclusive(
      () =>
        this.#counted("swamp.datastore.v3.readmodel.recover", async () => {
          // Every namespace's rows are judged by this checkout's filter: the
          // replay below rebuilds every namespace, and a checkout writes one.
          const generation = this.#catalog.clear(options.admits);
          this.#reset(generation);
          this.#catalog.markPopulated(generation);
          await this.#retryAtRiskCopies(options.signal);
          await this.#catchUpFeed(options.signal);
          return await this.#sweepUnowned(namespace, options);
        }),
      options.signal,
    );
  }

  /**
   * Applies the feed past the cursor; runs inside {@link #exclusive}. With
   * `net`, a catch-up from the start of the feed is a net replay
   * ({@link #planNetReplay}); a recovery never is, since it replays over
   * files already there.
   */
  async #catchUpFeed(
    signal: AbortSignal,
    options: { readonly net?: boolean } = {},
  ): Promise<CatchUpResult> {
    if (
      options.net === true && this.#netReplay && this.#state.cursor() === 0
    ) {
      this.#net = await this.#planNetReplay(signal);
    }
    try {
      return await this.#catchUpFeedNow(signal);
    } finally {
      this.#net = undefined;
    }
  }

  /**
   * The first pass of a net replay (swamp-club#3803): reads the feed once,
   * up to its end now, and plans which writes and removals the replay may
   * leave off disk ({@link NetReplayPlanner}). The keys it leaves alone are
   * the ones {@link #target} would: unprojected or refused. Undefined when
   * the feed starts below a compaction point, which loads the base instead.
   */
  #planNetReplay(signal: AbortSignal): Promise<NetReplayPlan | undefined> {
    return withSpan(
      "swamp.datastore.v3.readmodel.net_plan",
      {},
      async (span) => {
        const planner = new NetReplayPlanner((namespace, key) =>
          unprojectedReason(namespace, key, this.#checkout) !== undefined ||
          refusedKeyReason(
              RecordKey.create(key),
              this.#cacheRoot(namespace),
              this.#stateDir,
            ) !== undefined
        );
        let cursor = 0;
        let commits = 0;
        for (;;) {
          signal.throwIfAborted();
          let page;
          try {
            page = await this.#commitStore.changesSince(cursor, this.#pageSize);
          } catch (error) {
            if (error instanceof CommitsCompactedError) return undefined;
            throw error;
          }
          for (const change of page) {
            planner.add({
              namespace: change.commit.namespace,
              partition: change.commit.partition.toString(),
              position: change.cursor,
              changes: finalKeyStates(change.commit),
            });
            cursor = change.cursor;
            commits++;
          }
          if (page.length < this.#pageSize) break;
        }
        const absent = new Set<string>();
        for (const { namespace, segment } of planner.directories()) {
          try {
            await Deno.lstat(join(this.#cacheRoot(namespace), segment));
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            absent.add(`${namespace}\0${segment}`);
          }
        }
        const plan = planner.finish((namespace, segment) =>
          absent.has(`${namespace}\0${segment}`)
        );
        span.setAttributes({
          "swamp.datastore.v3.commits": commits,
          "swamp.datastore.v3.bound": plan.bound,
          "swamp.datastore.v3.writes_replaceable": plan.replaceable,
          "swamp.datastore.v3.writes_kept_for_prefix": plan.keptForPrefix,
          "swamp.datastore.v3.writes_kept_for_directory": plan.keptForDirectory,
        });
        return plan;
      },
    );
  }

  async #catchUpFeedNow(signal: AbortSignal): Promise<CatchUpResult> {
    let applied = 0;
    for (;;) {
      signal.throwIfAborted();
      let page;
      try {
        page = await this.#time(
          "feed",
          () =>
            this.#commitStore.changesSince(
              this.#state.cursor(),
              this.#pageSize,
            ),
        );
      } catch (error) {
        if (!(error instanceof CommitsCompactedError)) throw error;
        // The base reconciles files with the state, which a net replay's
        // skipped writes leave ahead of them: the rest replays in full.
        this.#net = undefined;
        await this.#loadBase(signal);
        continue;
      }
      applied += await this.#applyPage(page, true, signal);
      if (page.length < this.#pageSize) break;
    }
    await this.#retryUnreadable(signal);
    // The whole feed is applied: the index holds every live record. This is
    // its own transaction; a crash before it leaves the index marked
    // incomplete until the next catch-up, which only delays reads.
    this.#state.markComplete();
    return { applied, cursor: this.#state.cursor() };
  }

  async #sweepUnowned(
    namespace: string,
    options: {
      readonly since: number;
      readonly admits: (key: string) => boolean;
      readonly signal: AbortSignal;
      readonly droppedDirs?: readonly string[];
    },
  ): Promise<string[]> {
    const root = this.#cacheRoot(namespace);
    const removed: string[] = [];
    const batch = new DurableWriteBatch();
    const droppedDirs = new Set(options.droppedDirs);
    // One lookup per ancestor, so a unit that created many versions does
    // not make the walk quadratic.
    const inDroppedDir = (segments: readonly string[]) => {
      for (let depth = segments.length - 1; depth > 0; depth--) {
        if (droppedDirs.has(segments.slice(0, depth).join("/"))) return true;
      }
      return false;
    };
    const visit = async (dir: string, segments: string[]): Promise<void> => {
      let entries: Deno.DirEntry[];
      try {
        entries = await Array.fromAsync(this.#readDir(dir));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      for (const entry of entries) {
        options.signal.throwIfAborted();
        // A symlink is never followed or removed: the read model writes none.
        if (entry.isSymlink) continue;
        const path = join(dir, entry.name);
        const keySegments = [...segments, entry.name];
        // Both spellings of a listed name are judged (see recover).
        const composed = keySegments.map((segment) => segment.normalize("NFC"));
        if (isCheckoutLocalKey(keySegments) || isCheckoutLocalKey(composed)) {
          continue;
        }
        if (entry.isDirectory) {
          await visit(path, keySegments);
          continue;
        }
        if (!entry.isFile) continue;
        const key = keySegments.join("/");
        const spellings = [...new Set([key, composed.join("/")])];
        if (
          spellings.some((spelling) =>
            !options.admits(spelling) ||
            unprojectedReason(namespace, spelling, this.#checkout) !==
              undefined ||
            this.#state.fileOwnership(namespace, spelling)?.present === true
          )
        ) {
          continue;
        }
        if (!inDroppedDir(keySegments) && !inDroppedDir(composed)) {
          const modified = (await Deno.lstat(path)).mtime?.getTime();
          if (modified === undefined || modified < options.since) continue;
        }
        await this.#removeRecord(
          namespace,
          key,
          path,
          batch,
          options.signal,
          NO_COMMIT,
        );
        removed.push(key);
      }
    };
    try {
      for (const subdir of MATERIALISED_SUBDIRS) {
        await visit(join(root, subdir), [subdir]);
      }
      await batch.barrier();
    } finally {
      batch.discard();
    }
    return removed;
  }

  catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<CatchUpResult> {
    return this.#exclusive(
      () =>
        this.#counted(
          "swamp.datastore.v3.readmodel.catchup_partition",
          () => this.#catchUpPartition(namespace, partition, signal),
        ),
      signal,
    );
  }

  async #catchUpPartition(
    namespace: string,
    partition: PartitionKey,
    signal: AbortSignal,
  ): Promise<CatchUpResult> {
    await this.#retryAtRiskCopies(signal);
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
      applied += await this.#applyPage(page, false, signal);
      if (page.length < this.#pageSize) break;
    }
    return { applied, cursor: this.#state.cursor() };
  }

  liveRecords(
    namespace: string,
    partition: PartitionKey,
  ): Promise<readonly LiveRecord[]> {
    return this.#afterPage(() => {
      const records = this.#state.liveRecordsIfComplete(
        namespace,
        partition.toString(),
      );
      if (records === undefined) throw new ReadModelIncompleteError();
      return records;
    });
  }

  /**
   * Which partition owns a record key's file, as of the last commit this
   * read model applied (swamp-club#3915): serve checks a forwarded put
   * against it, after catching up.
   */
  fileOwner(
    namespace: string,
    key: string,
  ): Promise<FileOwnership | undefined> {
    return this.#afterPage(() => this.#state.fileOwnership(namespace, key));
  }

  chunksInUse(namespace: string): Promise<ReadonlySet<string>> {
    return this.#afterPage(() => {
      const chunks = this.#state.chunksInUseIfComplete(namespace);
      if (chunks === undefined) throw new ReadModelIncompleteError();
      return chunks;
    });
  }

  /**
   * Runs a read once no page is being applied in this process
   * (swamp-club#3337): a page's state is uncommitted until its barrier, so
   * a read in the middle of one would see what a failed page rolls back.
   * It does not wait for the rest of a catch-up, or for another process's
   * lock; other processes only ever see committed state.
   */
  async #afterPage<T>(read: () => T): Promise<T> {
    if (this.#closed) throw closedError();
    while (this.#pageInFlight !== undefined) await this.#pageInFlight;
    if (this.#closed) throw closedError();
    return read();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    this.#catalog.close();
    this.#state.close();
  }

  /**
   * The unreadable record at `recordKey` in `namespace`, if any
   * (swamp-club#3617), once any page in progress has committed; undefined
   * once the read model is closed. A repository content path maps to its
   * record key by taking it relative to the namespace's cache root
   * (`v3CacheRoot(repoDir, namespace)`) with `/` separators: compare the
   * paths as the repository spells them first, and resolve both only when
   * the path is not under the root as written (a checkout reached through a
   * symlink, or macOS's `/tmp`), as `unreadableContentLookup` does.
   */
  async unreadableRecord(
    namespace: string,
    recordKey: string,
  ): Promise<UnreadableRecord | undefined> {
    if (this.#closed) return undefined;
    let stored: StoredUnreadableRecord | undefined;
    try {
      stored = await this.#afterPage(() =>
        this.#state.unreadableRecord(namespace, recordKey)
      );
    } catch (error) {
      if (this.#closed) return undefined;
      throw error;
    }
    if (stored === undefined) return undefined;
    const { chunkSize: _size, chunkMtime: _mtime, ...record } = stored;
    return record;
  }

  /**
   * The unreadable records of `namespace` under the directory `keyPrefix`
   * (keys `<keyPrefix>/...`), in key order, once any page in progress has
   * committed; empty once the read model is closed (swamp-club#3617). For a
   * read that cannot name the record it wants (a lookup by an id its file
   * name does not carry) or that lists a directory. `keyPrefix` maps from a
   * repository directory as {@link unreadableRecord}'s key does from a path.
   */
  async unreadableRecordsUnder(
    namespace: string,
    keyPrefix: string,
  ): Promise<UnreadableRecord[]> {
    if (this.#closed) return [];
    let stored: StoredUnreadableRecord[];
    try {
      stored = await this.#afterPage(() =>
        this.#state.unreadableRecordsUnder(namespace, keyPrefix)
      );
    } catch (error) {
      if (this.#closed) return [];
      throw error;
    }
    return stored.map(({ chunkSize: _size, chunkMtime: _mtime, ...record }) =>
      record
    );
  }

  /**
   * Runs `body` after every earlier call, holding the process lock, after
   * checking the files written unsynced in an earlier boot and resetting
   * the state if the catalog was rebuilt.
   */
  #exclusive<T>(
    body: () => Promise<T>,
    signal?: AbortSignal,
    lockWaitMs?: number,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(closedError());
    const run = this.#queue.then(async () => {
      await Deno.mkdir(this.#stateDir, { recursive: true });
      const lock = await Deno.open(join(this.#stateDir, READ_MODEL_LOCK_FILE), {
        read: true,
        write: true,
        create: true,
      });
      try {
        if (lockWaitMs === undefined) {
          await lock.lock(true);
        } else {
          const until = Date.now() + lockWaitMs;
          while (!await lock.tryLock(true)) {
            signal?.throwIfAborted();
            if (Date.now() >= until) throw new ReadModelBusyError(lockWaitMs);
            await new Promise((done) => setTimeout(done, 50));
          }
        }
        // Another process may have changed the tree since the last section.
        this.#paths.clear();
        this.#guarded.clear();
        this.#replaying = false;
        const generation = this.#catalog.generation();
        // First, so a reset below cannot drop the list unchecked
        // (swamp-club#3617).
        this.#boot = await this.#bootIdentity();
        await this.#checkUnsyncedAfterReboot(
          generation,
          signal ?? new AbortController().signal,
        );
        // A catalog rebuilt, invalidated or created afresh holds none of the
        // commits the state says are applied: start over.
        if (
          this.#state.catalogGeneration() !== generation ||
          !this.#catalog.isPopulated()
        ) {
          this.#reset(generation);
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
   * Makes the files written unsynced durable and forgets them
   * (swamp-club#3416): serve calls it from its maintenance timer, so a
   * long-running serve's first open after a reboot does not hash most of its
   * cache. It works in batches of {@link UNSYNCED_SYNC_BATCH}, each in its
   * own section of the read model's lock, so a long list never holds every
   * other command back for long. In a batch each file is synced, then each
   * of their directories, deepest first; a file that is gone has its
   * directory synced. Resolves with how many files it synced.
   */
  async syncUnsyncedFiles(): Promise<number> {
    let synced = 0;
    // Bounded: entries that keep arriving wait for the next tick.
    for (let batch = 0; batch < MAX_UNSYNCED_SYNC_BATCHES; batch++) {
      const { listed, forgotten } = await this.#exclusive(() =>
        this.#syncUnsyncedBatch()
      );
      synced += forgotten;
      // A short batch was the last; one that forgot nothing holds only
      // files that could not be synced, which stay listed for the reboot
      // check.
      if (listed < UNSYNCED_SYNC_BATCH || forgotten === 0) break;
    }
    return synced;
  }

  /**
   * Syncs one batch of unsynced files and forgets the ones now known to be
   * on disk, or gone; runs inside {@link #exclusive}. A file that cannot be
   * synced stays listed, so the reboot check still covers it.
   */
  async #syncUnsyncedBatch(): Promise<{ listed: number; forgotten: number }> {
    const keys = this.#state.unsyncedKeys(UNSYNCED_SYNC_BATCH);
    const dirs = new Set<string>();
    const done: typeof keys = [];
    for (const key of keys) {
      const path = join(
        this.#cacheRoot(key.namespace),
        ...key.record_key.split("/"),
      );
      dirs.add(dirname(path));
      let handle: Deno.FsFile;
      try {
        // Writable: Windows flushes only a handle opened for writing.
        handle = await Deno.open(path, { read: true, write: true });
      } catch (error) {
        if (
          error instanceof Deno.errors.NotFound ||
          error instanceof Deno.errors.NotADirectory ||
          error instanceof Deno.errors.IsADirectory
        ) {
          // Gone: its directory's sync below makes that durable.
          done.push(key);
          continue;
        }
        if (!(error instanceof Deno.errors.PermissionDenied)) throw error;
        // A read-only file: POSIX syncs a read handle. Windows flushes only
        // a writable one, so there, and for a file that cannot be read
        // either, it stays listed for the reboot check.
        if (Deno.build.os === "windows") continue;
        try {
          handle = await Deno.open(path, { read: true });
        } catch (reopen) {
          if (reopen instanceof Deno.errors.PermissionDenied) continue;
          throw reopen;
        }
      }
      try {
        await handle.sync();
      } finally {
        handle.close();
      }
      done.push(key);
    }
    // A path is longer than any of its ancestors: deepest first.
    for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
      try {
        await syncDirectory(dir);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    this.#state.forgetUnsynced(done);
    return { listed: keys.length, forgotten: done.length };
  }

  /**
   * Resets the state to replay every commit, keeping removal candidates
   * (swamp-club#3617): the unsynced keys too when they were written in
   * another boot or the current one cannot be named. The rest of the
   * section replays.
   */
  #reset(generation: number): void {
    const listed = this.#state.unsyncedBoot();
    this.#state.reset(
      generation,
      listed !== undefined &&
        (this.#boot === undefined || listed !== this.#boot),
    );
    this.#replaying = true;
  }

  /**
   * On the first open in a boot after the one that wrote unsynced files
   * (swamp-club#3337), checks each of them against the state: present with
   * its bytes, or absent. A file a crash lost or tore is rewritten to what
   * the state says, or removed, through a syncing batch (swamp-club#3617),
   * so the catch-up that follows goes on from the cursor. Then the list is
   * cleared. A file whose expected content is unknown, or cannot be read,
   * resets the state instead, and the catch-up applies every commit again.
   * On a storage that reads chunk sizes, a file that matches has its
   * committed chunks guarded.
   */
  async #checkUnsyncedAfterReboot(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const written = this.#state.unsyncedBoot();
    if (written === undefined || written === this.#boot) return;
    if (this.#boot === undefined) {
      // Whether the boot ended is unknown, so the files cannot be trusted
      // and a check proves nothing: apply every commit again, synced.
      logger
        .warn`The current boot cannot be named, so files written unsynced in an earlier one are rewritten`;
      this.#reset(generation);
      return;
    }
    const batch = new DurableWriteBatch();
    const commits = new Map<number, Commit | undefined>();
    try {
      for (const file of this.#state.unsyncedFiles()) {
        signal.throwIfAborted();
        // A key the checkout never projects is skipped, not a reason to
        // apply every commit again: a state from before swamp-club#3691
        // may list one, and its file is the checkout's own now.
        if (this.#unprojected(file.namespace, file.record_key)) continue;
        if (file.expect === "unknown") {
          logger
            .warn`The read model's state has no live record for ${file.record_key}, written before a restart; applying every commit again`;
          this.#reset(generation);
          return;
        }
        const source = file.expect === "present"
          ? { partition: file.owner, seq: 0 }
          : NO_COMMIT;
        const path = await this.#target(
          file.namespace,
          RecordKey.create(file.record_key),
          file.expect === "present",
          "the check after a restart",
        );
        if (path === undefined) {
          logger
            .warn`${file.record_key} cannot be checked after a restart; applying every commit again`;
          this.#reset(generation);
          return;
        }
        // A guarded file that matches stays, its chunks stored or a copy
        // aside; one that changed since it was checked is rewritten below.
        if (
          await holdsExpected(path, file) &&
          (file.expect !== "present" || file.blob === undefined ||
            !this.#chunkStore.readsSizes ||
            await this.#guardExisting(
              file.namespace,
              file.record_key,
              path,
              file.blob,
              signal,
              source,
              false,
            ))
        ) {
          continue;
        }
        logger
          .info`${file.record_key} does not hold what the read model applied, after a restart since it was written; rewriting it`;
        if (file.expect !== "present") {
          await this.#removeRecord(
            file.namespace,
            file.record_key,
            path,
            batch,
            signal,
            source,
          );
          continue;
        }
        const stored = file.blob !== undefined
          ? (file.blob.sha256 === file.sha256 ? { blob: file.blob } : undefined)
          : await this.#inlineAt(file, commits);
        if (stored === undefined) {
          logger
            .warn`The content ${file.record_key} held before a restart cannot be found; applying every commit again`;
          this.#reset(generation);
          return;
        }
        await this.#writeContent(
          file.namespace,
          file.record_key,
          path,
          withAccess(stored, file.access),
          signal,
          batch,
          source,
        );
      }
      await batch.barrier();
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof CheckoutCopyAtRiskError) throw error;
      logger
        .warn`Cannot rewrite the files written before a restart (${error}); applying every commit again`;
      this.#reset(generation);
      return;
    } finally {
      batch.discard();
    }
    this.#state.clearUnsynced();
  }

  /**
   * The inline content of the put a listed file shows, from the commit at
   * its ownership mark (cached by mark), when its SHA-256 matches;
   * undefined when that commit holds no such put. Rejects when the commit
   * was compacted away.
   */
  async #inlineAt(
    file: UnsyncedFile & { readonly expect: "present" },
    commits: Map<number, Commit | undefined>,
  ): Promise<{ readonly inline: string } | undefined> {
    if (!commits.has(file.mark)) {
      const page = await this.#commitStore.changesSince(file.mark - 1, 1);
      commits.set(
        file.mark,
        page[0]?.cursor === file.mark ? page[0].commit : undefined,
      );
    }
    const commit = commits.get(file.mark);
    if (
      commit === undefined || commit.namespace !== file.namespace ||
      commit.partition.toString() !== file.owner
    ) {
      return undefined;
    }
    for (const change of finalKeyStates(commit)) {
      if (change.key.toString() !== file.record_key) continue;
      const content = change.put?.content;
      if (content === undefined || !("inline" in content)) return undefined;
      const digest = createHash("sha256")
        .update(decodeBase64(content.inline))
        .digest("hex");
      return digest === file.sha256 ? { inline: content.inline } : undefined;
    }
    return undefined;
  }

  /**
   * Applies a page of commits; resolves with how many were applied. Their
   * state transactions are held in one batch that commits after the page's
   * barrier: a no-op for the default batch, whose files the reboot check
   * covers, and the sync of every file and directory for a syncing one. On
   * a failure the commits before it are kept: the barrier runs, the batch
   * commits, and the failure is rethrown; if that barrier fails too, the
   * whole page is rolled back and the apply failure is still the one thrown.
   */
  async #applyPage(
    page: readonly CommitChange[],
    advance: boolean,
    signal: AbortSignal,
  ): Promise<number> {
    if (page.length === 0) return 0;
    const batch = this.#writeBatch();
    this.#state.beginBatch();
    this.#catalog.beginBatch();
    // Set only once the batch is open, so the finally below always clears it.
    const settled = Promise.withResolvers<void>();
    this.#pageInFlight = settled.promise;
    try {
      let applied = 0;
      try {
        for (const change of page) {
          signal.throwIfAborted();
          if (await this.#apply(change, advance, signal, batch)) applied++;
        }
      } catch (error) {
        try {
          await batch.barrier();
          this.#catalog.commitBatch();
          this.#state.commitBatch();
        } catch {
          // The page rolls back below; the apply failure is the one to report.
        }
        throw error;
      }
      await this.#time("barrier", () => batch.barrier());
      // The page's catalog actions in one transaction (swamp-club#3803),
      // after its files and before its state: a crash between them leaves
      // the catalog ahead, and the page is applied again.
      this.#timeSync("catalog", () => this.#catalog.commitBatch());
      this.#state.commitBatch();
      if (this.#stats !== undefined) {
        this.#stats.pages++;
        this.#stats.commits += applied;
      }
      return applied;
    } finally {
      batch.discard();
      this.#catalog.rollbackBatch();
      this.#state.rollbackBatch();
      this.#pageInFlight = undefined;
      settled.resolve();
    }
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
    batch: DurableWriteBatch,
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
      const touched = new Set<string>();
      const unreadable = new Map<string, StoredUnreadableRecord>();
      for (const keyChange of finalKeyStates(commit)) {
        signal.throwIfAborted();
        const key = keyChange.key.toString();
        records.set(key, appliedRecord(keyChange.put));
        const file = await this.#materialise(
          commit,
          change.cursor,
          keyChange,
          signal,
          batch,
          touched,
          unreadable,
        );
        if (file !== undefined) files.set(key, file);
      }
      const projection: CatalogProjection = this.#timeSync("catalog", () => {
        const projection = projectCatalog(
          commit.ops,
          (name) => this.#state.liveVersions(namespace, partition, name),
        );
        this.#catalog.apply(namespace, commit.partition, projection.actions);
        for (const action of projection.actions) {
          this.#stats?.bump(`catalog_${action.kind.replaceAll("-", "_")}`);
        }
        return projection;
      });
      this.#timeSync("state", () =>
        this.#state.recordApplied({
          namespace,
          partition,
          seq: commit.seq,
          cursor,
          records,
          live: projection.live,
          files,
          unsynced: this.#boot === undefined
            ? undefined
            : { keys: touched, boot: this.#boot },
          decided: touched,
          unreadable,
        }));
      for (const record of unreadable.values()) warnUnreadable(record);
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
   *
   * A put whose content cannot be read, because a chunk is missing or
   * damaged, does not fail the commit (swamp-club#3617): the key's old file
   * is removed, its ownership still advances, and it is recorded in
   * `unreadable` for a retry once the chunk changes. Only a commit at or
   * below the compaction point fails instead, so the catch-up loads the
   * compacted base.
   */
  async #materialise(
    commit: Commit,
    position: number,
    change: KeyChange,
    signal: AbortSignal,
    batch: DurableWriteBatch,
    touched: Set<string>,
    unreadable: Map<string, StoredUnreadableRecord>,
  ): Promise<FileOwnership | undefined> {
    const key = change.key.toString();
    const path = await this.#time("target", () =>
      this.#target(
        commit.namespace,
        change.key,
        change.put !== null,
        `commit ${commit.seq} of ${commit.partition.toString()}`,
      ));
    if (path === undefined) return undefined;

    const owner = commit.partition.toString();
    const prior = this.#state.fileOwnership(commit.namespace, key);
    const decision = decideFile(prior, owner, position, change.put !== null);
    if (decision.kind === "keep") return undefined;
    touched.add(key);
    const source = { partition: owner, seq: commit.seq };
    // A tombstone of a key no put ever owned names no file of its own. On
    // a case- or normalisation-insensitive filesystem its path can still
    // resolve to another key's file (`WEB.yaml` to `web.yaml`), which the
    // tombstone must not remove (swamp-club#3915).
    if (
      change.put === null && prior === undefined &&
      await isAliasedSpelling(path, this.#cacheRoot(commit.namespace))
    ) {
      this.#stats?.bump("removals_skipped");
      return decision.kind === "remove" ? decision.next : undefined;
    }
    if (decision.kind === "remove" || change.put === null) {
      // Nothing of the key is on disk in a net replay (swamp-club#3803).
      if (this.#net?.skipsRemoval(commit.namespace, key, position) === true) {
        this.#stats?.bump("removals_skipped");
        return decision.kind === "remove" ? decision.next : undefined;
      }
      await this.#removeRecord(
        commit.namespace,
        key,
        path,
        batch,
        signal,
        source,
      );
      return decision.kind === "remove" ? decision.next : undefined;
    }
    const blob = "blob" in change.put.content
      ? change.put.content.blob
      : undefined;
    // A later change of the key in a net replay replaces this content before
    // anything reads it (swamp-club#3803): its chunks are never fetched, so
    // one unreadable is never recorded, and a later decision forgets it in a
    // full replay anyway.
    if (
      blob?.legacyKey === undefined &&
      this.#net?.skipsWrite(commit.namespace, key, position) === true
    ) {
      this.#paths.takeAbsent(path);
      this.#stats?.bump("writes_skipped");
      if (blob !== undefined) this.#stats?.bump("chunked_writes_skipped");
      return decision.next;
    }
    if (blob?.legacyKey !== undefined) {
      throw new ReadModelApplyError(
        commit.namespace,
        commit.partition.toString(),
        commit.seq,
        legacyBlobDetail(key, blob.legacyKey.toString()),
      );
    }
    try {
      await this.#writeContent(
        commit.namespace,
        key,
        path,
        withAccess(change.put.content, change.put.access),
        signal,
        batch,
        source,
      );
    } catch (error) {
      if (blob === undefined || !isChunkError(error) || signal.aborted) {
        throw error;
      }
      if (position <= await this.#commitStore.compactionPoint()) throw error;
      unreadable.set(
        key,
        await this.#unreadable(
          commit.namespace,
          key,
          withAccess(
            { partition: owner, seq: commit.seq, position },
            change.put.access,
          ),
          blob,
          error,
          signal,
        ),
      );
      await this.#removeRecord(
        commit.namespace,
        key,
        path,
        batch,
        signal,
        source,
      );
    }
    return decision.next;
  }

  /**
   * The unreadable record of a put whose blob could not be read: which
   * chunk, why, and how the chunk looks now, so a retry waits for it to
   * change.
   */
  async #unreadable(
    namespace: string,
    key: string,
    put: {
      readonly partition: string;
      readonly seq: number;
      readonly position: number;
      readonly access?: FileAccess;
    },
    blob: BlobRef,
    error: ChunkMissingError | ChunkIntegrityError,
    signal: AbortSignal,
  ): Promise<StoredUnreadableRecord> {
    const ns = namespaceOf(namespace);
    let chunk: string | undefined;
    let reason: "missing" | "damaged" = "missing";
    if (error instanceof ChunkMissingError) {
      chunk = error.sha256;
    } else if (error.sha256 !== undefined) {
      // The read named the chunk of the wrong size or hash: no part needs
      // reading again to find it. As missing() counts it, one held at the
      // wrong size (or not at all) is missing; one of the right size whose
      // bytes are wrong is damaged.
      chunk = error.sha256;
      if (!(await this.#chunkStore.missing(ns, blob, signal)).includes(chunk)) {
        reason = "damaged";
      }
    } else {
      // A whole-content digest mismatch names no chunk: find the one that
      // is missing, or else the first that does not verify.
      chunk = (await this.#chunkStore.missing(ns, blob, signal))[0];
      if (chunk === undefined) {
        reason = "damaged";
        chunk =
          (await this.#chunkStore.verifyParts(ns, partsOf(blob), signal))[0]
            ?.sha256;
      }
    }
    const seen = chunk === undefined
      ? undefined
      : (await this.#chunkStore.stat(ns, [chunk], signal))?.get(chunk);
    return {
      namespace,
      recordKey: key,
      ...put,
      blob,
      ...(chunk === undefined ? {} : { chunk }),
      reason,
      lastAttempt: this.#clock(),
      ...(seen === undefined ? {} : {
        chunkSize: seen.size,
        chunkMtime: seen.lastModified.getTime(),
      }),
    };
  }

  /**
   * Whether the read model leaves `key` of `namespace` alone
   * ({@link unprojectedReason}): logged once per reserved namespace, and
   * only at debug level for a key the checkout keeps local, which is
   * expected on every commit of another checkout.
   */
  #unprojected(namespace: string, key: string): boolean {
    const reason = unprojectedReason(namespace, key, this.#checkout);
    if (reason === "reserved") {
      if (!this.#warnedReserved.has(namespace)) {
        this.#warnedReserved.add(namespace);
        logger
          .warn`Not materialising the records of namespace ${namespace}: it is named after one of swamp's own .swamp directories, so its files would land in that directory. They stay in the datastore, unmaterialised`;
      }
      return true;
    }
    if (reason === "local") {
      logger
        .debug`Not materialising ${key} of namespace ${namespace}: this checkout's directories keep it local`;
      return true;
    }
    return false;
  }

  /**
   * The path to write (`isPut`) or remove a key at, or undefined when the
   * key must be left alone: a key the checkout never projects
   * ({@link #unprojected}), a refused key, a file and a directory claiming
   * one path, or a path resolving into the state directory. `source` names
   * where the change came from, for the log. A key left alone gets no file
   * ownership and stays in the records index.
   */
  async #target(
    namespace: string,
    recordKey: RecordKey,
    isPut: boolean,
    source: string,
  ): Promise<string | undefined> {
    const key = recordKey.toString();
    if (this.#unprojected(namespace, key)) return undefined;
    const root = this.#cacheRoot(namespace);
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
    const { conflict, missingFrom } = await pathConflict(
      root,
      segments,
      this.#paths,
    );
    if (conflict?.kind === "under-file") {
      return isPut ? skip(conflict.reason) : undefined;
    }
    if (conflict?.kind === "directory" && isPut) {
      return skip(conflict.reason);
    }
    // A path whose prefix of `missingFrom` segments does not exist resolves,
    // as `resolveRealPath` resolves it, under its longest existing prefix,
    // and a write must create the directories from that prefix down.
    let resolved: string;
    if (missingFrom === undefined) {
      resolved = await this.#paths.resolve(path);
      if (isPut) this.#paths.noteAbsent(path, []);
    } else {
      resolved = join(
        await this.#paths.resolveDirectory(
          join(root, ...segments.slice(0, missingFrom - 1)),
        ),
        ...segments.slice(missingFrom - 1),
      );
      const absent: string[] = [];
      for (let i = segments.length - 1; i >= missingFrom; i--) {
        absent.push(join(root, ...segments.slice(0, i)));
      }
      if (isPut) this.#paths.noteAbsent(path, absent);
    }
    if (!within(resolved, await this.#paths.resolveDirectory(root))) {
      throw new PathTraversalError(path, root, resolved);
    }
    // The lexical guard cannot see a symlink already in the cache that leads
    // into the state directory; the resolved path can.
    if (within(resolved, await this.#paths.resolveDirectory(this.#stateDir))) {
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
  #loadBase(signal: AbortSignal): Promise<void> {
    return withSpan(
      "swamp.datastore.v3.readmodel.load_base",
      {},
      () => this.#loadBaseNow(signal),
    );
  }

  async #loadBaseNow(signal: AbortSignal): Promise<void> {
    const started = performance.now();
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
    this.#stats?.bump("base_stage_ms", Math.round(performance.now() - started));
    if (point === undefined) return;

    const removals = this.#state.loadRemovals();
    const writes = this.#state.loadWrites();
    this.#state.touchKeys([...removals, ...writes]);
    this.#stats?.bump("base_removals", removals.length);
    this.#stats?.bump("base_writes", writes.length);
    // Unsynced where the kernel names the boot, as a page's files are: the
    // keys are listed with the boot when the load finishes, and the first
    // open in a later boot checks them (swamp-club#3803). Syncing each file
    // made a load slower than replaying the commits it folds.
    const batch = this.#writeBatch();
    let unreadable: StoredUnreadableRecord[];
    const filesStarted = performance.now();
    try {
      unreadable = await this.#loadFiles(removals, writes, batch, signal);
      await batch.barrier();
    } finally {
      batch.discard();
    }
    this.#stats?.bump(
      "base_files_ms",
      Math.round(performance.now() - filesStarted),
    );

    const catalogStarted = performance.now();
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
    this.#stats?.bump("base_names", names.length);
    this.#stats?.bump(
      "base_catalog_ms",
      Math.round(performance.now() - catalogStarted),
    );
    const finishStarted = performance.now();
    this.#state.finishLoad(
      point,
      unreadable,
      batch.syncs || this.#boot === undefined
        ? undefined
        : { keys: [...removals, ...writes], boot: this.#boot },
    );
    this.#stats?.bump(
      "base_finish_ms",
      Math.round(performance.now() - finishStarted),
    );
    for (const record of unreadable) warnUnreadable(record);
  }

  /**
   * The compacted base's file removals and writes, through `batch`.
   * Resolves with the records whose content could not be read: their files
   * are removed, and never fail the load (swamp-club#3617), since no
   * commit is left to retry them from.
   */
  async #loadFiles(
    removals: readonly LoadKey[],
    writes: readonly LoadKey[],
    batch: DurableWriteBatch,
    signal: AbortSignal,
  ): Promise<StoredUnreadableRecord[]> {
    const unreadable: StoredUnreadableRecord[] = [];
    for (const { namespace, record_key } of removals) {
      signal.throwIfAborted();
      const path = await this.#target(
        namespace,
        RecordKey.create(record_key),
        false,
        "the compacted base",
      );
      if (path === undefined) continue;
      await this.#removeRecord(
        namespace,
        record_key,
        path,
        batch,
        signal,
        NO_COMMIT,
      );
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
      const owner = this.#state.loadFile(namespace, record_key);
      const source = { partition: owner?.owner ?? "", seq: 0 };
      try {
        await this.#writeContent(
          namespace,
          record_key,
          path,
          content,
          signal,
          batch,
          source,
        );
      } catch (error) {
        if (
          !("blob" in content) || !isChunkError(error) || signal.aborted ||
          owner === undefined
        ) {
          throw error;
        }
        unreadable.push(
          await this.#unreadable(
            namespace,
            record_key,
            withAccess({ ...source, position: owner.mark }, content.access),
            content.blob,
            error,
            signal,
          ),
        );
        await this.#removeRecord(
          namespace,
          record_key,
          path,
          batch,
          signal,
          source,
        );
      }
    }
    return unreadable;
  }

  /**
   * Removes a record's file and the directories it leaves empty, up to
   * the namespace's cache root, and has `batch` sync the deepest directory
   * still standing: the one whose entry the removal changed. Syncing the
   * file's own directory would do nothing once the cleanup has removed it.
   * The file is guarded first ({@link #guardExisting}).
   */
  #removeRecord(
    namespace: string,
    key: string,
    path: string,
    batch: DurableWriteBatch,
    signal: AbortSignal,
    source: ChangeSource,
  ): Promise<void> {
    return this.#time(
      "remove",
      () => this.#removeRecordNow(namespace, key, path, batch, signal, source),
    );
  }

  async #removeRecordNow(
    namespace: string,
    key: string,
    path: string,
    batch: DurableWriteBatch,
    signal: AbortSignal,
    source: ChangeSource,
  ): Promise<void> {
    await this.#guardExisting(
      namespace,
      key,
      path,
      undefined,
      signal,
      source,
      true,
    );
    const root = this.#cacheRoot(namespace);
    await removeRecordFile(path, batch);
    this.#state.forgetWrittenFile(namespace, key);
    this.#stats?.noteRemoved(namespace, key);
    await cleanupEmptyParentDirs(path, root);
    this.#paths.clear();
    if (!batch.syncs) return;
    for (let dir = dirname(path);; dir = dirname(dir)) {
      if (dir === root || !dir.startsWith(root + SEPARATOR)) {
        batch.touch(root);
        return;
      }
      try {
        await Deno.lstat(dir);
        batch.touch(dir);
        return;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }

  /**
   * Writes a record's content at `path` through `batch`: inline bytes, or
   * its chunks. The file there is guarded first ({@link #guardExisting});
   * one that already holds the content is left as it is, and synced when
   * `batch` syncs, since no later check covers it. When the chunks cannot be
   * read and the guard did not read the file (a bucket outside a replay),
   * it reads it then: a file holding the content is the only copy of a
   * chunk the storage lost, and stays (swamp-club#3617).
   *
   * The file is written with the content's access (swamp-club#3693). A
   * file the guard keeps for its bytes is rewritten all the same when the
   * put records an access the file lacks, through the batch rather than a
   * chmod of the path, which would follow a link put there since the guard
   * looked. A plain put (every put before swamp-club#3693) keeps such a
   * file whatever its mode, as before.
   */
  async #writeContent(
    namespace: string,
    key: string,
    path: string,
    content: RecordContent,
    signal: AbortSignal,
    batch: DurableWriteBatch,
    source: ChangeSource,
  ): Promise<void> {
    const intended = "blob" in content ? content.blob : undefined;
    const keep = async () => {
      if (!batch.syncs) return;
      await this.#syncFile(path);
      batch.touch(dirname(path));
    };
    // A replay runs over files already there (a recovery rewrites every
    // committed file, swamp-club#3893): one already holding its inline
    // bytes, read and compared, and its access stays as it is. Chunked
    // content is compared by the guard below.
    if (
      "inline" in content && this.#replaying &&
      await this.#time(
        "guard",
        () => holdsBytes(path, decodeBase64(content.inline)),
      ) &&
      await hasAccess(path, content.access)
    ) {
      this.#stats?.bump("writes_kept");
      await keep();
      return;
    }
    let wrongAccess = false;
    if (
      await this.#time("guard", () =>
        this.#guardExisting(
          namespace,
          key,
          path,
          intended,
          signal,
          source,
          false,
        ))
    ) {
      wrongAccess = content.access !== undefined &&
        !await hasAccess(path, content.access);
      if (!wrongAccess) {
        await keep();
        return;
      }
    }
    const root = this.#cacheRoot(namespace);
    const absentDirectories = this.#paths.takeAbsent(path);
    const written: { info?: Deno.FileInfo } = {};
    const stats = this.#stats;
    const started = performance.now();
    try {
      const bytes = "inline" in content
        ? decodeBase64(content.inline)
        : this.#chunkStore.read(namespaceOf(namespace), content.blob, signal);
      await batch.write(
        path,
        stats === undefined || bytes instanceof Uint8Array
          ? bytes
          : stats.count(bytes),
        signal,
        {
          absentDirectories,
          written: (info) => {
            written.info = info;
          },
          ...(content.access === undefined ? {} : { access: content.access }),
        },
      );
    } catch (error) {
      // A failed write leaves the file as it was. One that only meant to
      // fix the access keeps the right bytes rather than lose them.
      if (wrongAccess && isChunkError(error) && !signal.aborted) {
        logger
          .warn`${key} holds its committed bytes without its ${content.access} access, and its chunks cannot be read to rewrite it: ${error}`;
        await keep();
        return;
      }
      if (
        intended === undefined || !isChunkError(error) || signal.aborted ||
        this.#guarded.has(path)
      ) {
        throw error;
      }
      if (
        await this.#guardExisting(
          namespace,
          key,
          path,
          intended,
          signal,
          source,
          false,
          true,
        )
      ) {
        await keep();
        return;
      }
      throw error;
    } finally {
      if (stats !== undefined) stats.contentMs += performance.now() - started;
    }
    stats?.noteWritten(namespace, key, intended?.size ?? 0);
    // It holds the chunks' content now: never hashed again this section.
    this.#guarded.add(path);
    if (intended !== undefined && written.info !== undefined) {
      const info = written.info;
      await this.#time(
        "note",
        () => this.#noteWritten(namespace, key, path, intended, info),
      );
    }
    // The write made every directory above the file, up to the root, and
    // the ones it created are real directories under their parents.
    for (const dir of [...absentDirectories ?? []].reverse()) {
      this.#paths.markCreated(dir);
    }
    for (
      let dir = dirname(path);
      dir !== root && dir.startsWith(root + SEPARATOR);
      dir = dirname(dir)
    ) {
      this.#paths.markDirectory(dir);
    }
  }

  /**
   * The checkout-copy guard (swamp-club#3617): before a file is overwritten
   * or removed, committed content whose only copy it may be is stored
   * again. Resolves true when the file already holds `intended`, so the
   * write can be skipped.
   *
   * Only a regular file over {@link MAX_INLINE_BYTES} this section has not
   * written or guarded is looked at: smaller content is inline in its
   * commit. It is read once, cut as the chunk store cuts content, and its
   * parts the storage does not hold (absent, or at the wrong size on a
   * storage that reads sizes) are put again from the file, when a stored
   * commit, the compacted base or a pending commit names them; released
   * chunks never count. A replay ({@link #replaying}) on a storage that
   * reads sizes also reads the referenced parts held at the right size,
   * and puts the damaged ones again. On a storage that cannot read sizes (a
   * bucket, whose puts cannot tear a chunk) an overwrite is guarded only in
   * a replay, so an ordinary catch-up makes no extra requests per file.
   *
   * `force` reads the file whatever the storage or section.
   *
   * A put the storage refuses moves the file aside instead
   * ({@link #moveAside}), and the overwrite or removal goes on; a file that
   * already holds `intended` stays where it is, and only a copy of it goes
   * aside, since nothing will overwrite it.
   */
  async #guardExisting(
    namespace: string,
    key: string,
    path: string,
    intended: BlobRef | undefined,
    signal: AbortSignal,
    source: ChangeSource,
    removal: boolean,
    force = false,
  ): Promise<boolean> {
    if (this.#guarded.has(path)) return false;
    const file = await this.#readGuarded(
      namespace,
      key,
      path,
      intended,
      removal,
      force,
      signal,
    );
    // Not read: unguarded, so a later removal or a failed write still
    // reads it (swamp-club#3617).
    if (file === "skipped") return false;
    if (file === undefined) {
      // Whatever this section writes there next comes from the chunks.
      this.#guarded.add(path);
      return false;
    }
    const ns = namespaceOf(namespace);
    const same = intended !== undefined && file.sha256 === intended.sha256 &&
      file.size === intended.size;
    const missing = new Set(
      await this.#chunkStore.missing(ns, file.ref, signal),
    );
    const absent = uniqueParts(file.parts.filter((p) => missing.has(p.sha256)));
    // Damage of the right size is looked for only in a replay, and never
    // when the file is what is about to be written.
    const held = this.#replaying && !same && this.#chunkStore.readsSizes
      ? uniqueParts(file.parts.filter((p) => !missing.has(p.sha256)))
      : [];
    let toStore: ContentPart[] = [];
    if (absent.length > 0 || held.length > 0) {
      const referenced = await this.#referencedChunks(
        namespace,
        [...absent, ...held].map((part) => part.sha256),
      );
      toStore = absent.filter((part) => referenced.has(part.sha256));
      const named = held.filter((part) => referenced.has(part.sha256));
      if (named.length > 0) {
        for (
          const part of await this.#chunkStore.verifyParts(ns, named, signal)
        ) {
          toStore.push(part);
        }
      }
    }
    // Still in place and unchanged since it was read.
    let kept = true;
    if (toStore.length > 0) {
      try {
        const { stored, changed } = await this.#chunkStore.putParts(
          ns,
          fileRangeReader(path),
          toStore,
          signal,
        );
        await this.#chunkStore.syncStored(ns, stored, signal);
        kept = changed.length === 0;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (!(error instanceof ChunkPutError)) throw error;
        if (same) {
          // The right bytes stay in place; a copy waits for the put.
          await this.#copyAside(namespace, key, path, file, error, signal);
        } else {
          await this.#moveAside(
            namespace,
            key,
            path,
            file,
            error,
            source,
            signal,
          );
          kept = false;
        }
      }
    }
    this.#guarded.add(path);
    return same && kept;
  }

  /**
   * The parts of the file at `path` when the guard must look at it:
   * a regular file over {@link MAX_INLINE_BYTES}, on a storage that reads
   * sizes, or for a `removal`, a `force`d read or in a replay; undefined
   * when there is no such file, and `"skipped"` when it was not looked at.
   *
   * A file this read model wrote whose stat still shows it as written
   * ({@link WrittenFile}) has its blob's parts without being read, unless
   * the read is forced, in a replay, or `intended` is that blob: whether
   * the file already holds the content to write is only ever decided by
   * reading it.
   */
  async #readGuarded(
    namespace: string,
    key: string,
    path: string,
    intended: BlobRef | undefined,
    removal: boolean,
    force: boolean,
    signal: AbortSignal,
  ): Promise<ContentParts | undefined | "skipped"> {
    if (
      !this.#chunkStore.readsSizes && !removal && !force && !this.#replaying
    ) {
      return "skipped";
    }
    let file: Deno.FsFile;
    try {
      const info = await Deno.lstat(path);
      if (!info.isFile || info.size <= MAX_INLINE_BYTES) return undefined;
      if (!force && !this.#replaying && this.#recordsWrittenFiles) {
        const written = this.#state.writtenFile(namespace, key);
        if (
          written !== undefined && stillAsWritten(written, info) &&
          intended?.sha256 !== written.blob.sha256
        ) {
          return contentPartsOf(written.blob);
        }
      }
      file = await Deno.open(path, { read: true });
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.NotADirectory
      ) {
        return undefined;
      }
      throw error;
    }
    return await refOfFile(this.#chunkStore, file, signal);
  }

  /**
   * Records the file this read model just wrote at `path` with `blob`
   * ({@link WrittenFile}), from `temp`, the stat of the temp file it wrote:
   * only when the path still shows that inode, unchanged since, so a file
   * another process put there in between is never taken for this one.
   * On Windows, whose file ids Deno reports only as lossy numbers, and
   * without inode numbers, nothing is recorded, and the guard reads the file.
   */
  async #noteWritten(
    namespace: string,
    key: string,
    path: string,
    blob: BlobRef,
    temp: Deno.FileInfo,
  ): Promise<void> {
    if (
      !this.#recordsWrittenFiles || blob.size <= MAX_INLINE_BYTES ||
      temp.ino === null
    ) {
      return;
    }
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch {
      return;
    }
    if (
      !info.isFile || info.ino !== temp.ino || info.dev !== temp.dev ||
      info.size !== temp.size || info.size !== blob.size ||
      info.mtime === null || info.mtime.getTime() !== temp.mtime?.getTime()
    ) {
      return;
    }
    this.#state.recordWrittenFile({
      namespace,
      recordKey: key,
      blob,
      size: info.size,
      ino: temp.ino,
      dev: info.dev,
      mtime: info.mtime.getTime(),
      ...(info.ctime === null ? {} : { ctime: info.ctime.getTime() }),
    });
  }

  /**
   * Moves a checkout file whose committed chunks the storage refused aside
   * into `at-risk/<storage namespace>/<sha256>` in the state directory,
   * syncs the copy's directories up to the state directory, then the
   * checkout's, and records the copy, so the overwrite or
   * removal that follows destroys nothing (swamp-club#3617). The same bytes
   * already aside, checked by their hash, only remove the file: a copy
   * made by hard link shares its inode with a checkout file, so an edit
   * there in place changes the copy too. Across devices it is copied,
   * synced, then removed, while every copy so far stays within the cap.
   * Throws {@link CheckoutCopyAtRiskError} when the file can be neither
   * moved nor copied.
   */
  async #moveAside(
    namespace: string,
    key: string,
    path: string,
    file: ContentParts,
    cause: ChunkPutError,
    source: ChangeSource,
    signal: AbortSignal,
  ): Promise<void> {
    const target = atRiskCopyPath(this.#stateDir, namespace, file.sha256);
    const dir = dirname(target);
    const fail = (reason: string, error: unknown) =>
      new CheckoutCopyAtRiskError(
        namespace,
        source.partition,
        source.seq,
        path,
        reason,
        { cause: error },
      );
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch (error) {
      throw fail(errorMessage(error), error);
    }
    // The copy's entries, up to the state directory (the mkdir may have
    // made `at-risk/` itself), are durable before the checkout's entry
    // for the file can go.
    const syncTarget = async () => {
      for (const synced of [dir, dirname(dir), this.#stateDir]) {
        await this.#syncDirectory(synced);
      }
    };
    if (
      this.#state.hasAtRiskCopy(namespace, file.sha256) &&
      await this.#holdsContent(target, file, signal)
    ) {
      await syncTarget();
      await Deno.remove(path);
    } else {
      // Across devices the source stays until its copy is durable.
      let copied = false;
      try {
        await this.#rename(path, target);
      } catch (error) {
        if (!isCrossDevice(error)) throw fail(errorMessage(error), error);
        if (this.#state.atRiskBytes() + file.size > this.#atRiskCopyBytes) {
          throw fail(
            `copying it across devices would take the at-risk copies past ${this.#atRiskCopyBytes} bytes`,
            error,
          );
        }
        try {
          await copyDurably(path, target);
        } catch (copyError) {
          throw fail(errorMessage(copyError), copyError);
        }
        copied = true;
      }
      await syncTarget();
      if (copied) await Deno.remove(path);
    }
    await this.#syncDirectory(dirname(path));
    const now = this.#clock();
    this.#state.recordAtRiskCopy({
      namespace,
      sha256: file.sha256,
      recordKey: key,
      blob: file.ref,
      size: file.size,
      createdAt: now,
      lastAttempt: now,
    });
    this.#paths.clear();
    if (!warnedAtRisk) {
      warnedAtRisk = true;
      logger
        .warn`The datastore refused to store chunks only ${key} in this checkout still held (${cause.message}), so the file was moved aside into ${dir}; a later command with write access to the datastore stores them. Run \`swamp doctor datastores\` for details`;
    }
  }

  /**
   * Puts a copy of a checkout file that already holds its committed
   * content, whose chunks the storage refused, into
   * `at-risk/<storage namespace>/<sha256>` and records it, leaving the file
   * in place (swamp-club#3617): the record stays readable, and the retry of
   * at-risk copies stores the chunks once the storage takes them. A hard
   * link costs no space, where a put refused for want of it is likely;
   * where it fails (across devices), the file is copied within the cap. A
   * copy already aside is kept only when its hash shows the same bytes. A
   * copy that cannot be made is only logged: the file stays, and the next
   * guard of it tries again.
   */
  async #copyAside(
    namespace: string,
    key: string,
    path: string,
    file: ContentParts,
    cause: ChunkPutError,
    signal: AbortSignal,
  ): Promise<void> {
    const target = atRiskCopyPath(this.#stateDir, namespace, file.sha256);
    const dir = dirname(target);
    try {
      // A copy of the same bytes may be aside already, recorded or not.
      if (!await this.#holdsContent(target, file, signal)) {
        await Deno.mkdir(dir, { recursive: true });
        await Deno.remove(target).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
        try {
          await Deno.link(path, target);
          // The checkout's bytes may never have been synced.
          await this.#syncFile(target);
        } catch (error) {
          await Deno.remove(target).catch(() => {});
          if (this.#state.atRiskBytes() + file.size > this.#atRiskCopyBytes) {
            throw error;
          }
          await copyDurably(path, target);
        }
        for (const synced of [dir, dirname(dir), this.#stateDir]) {
          await this.#syncDirectory(synced);
        }
      }
    } catch (error) {
      logger
        .warn`The datastore refused to store chunks only ${key} in this checkout still holds (${cause.message}), and no copy of it could be put aside (${error}); the file stays, and a later command stores them`;
      return;
    }
    const now = this.#clock();
    this.#state.recordAtRiskCopy({
      namespace,
      sha256: file.sha256,
      recordKey: key,
      blob: file.ref,
      size: file.size,
      createdAt: now,
      lastAttempt: now,
    });
    if (!warnedAtRisk) {
      warnedAtRisk = true;
      logger
        .warn`The datastore refused to store chunks only ${key} in this checkout still holds (${cause.message}), so a copy of the file was put aside into ${dir}; a later command with write access to the datastore stores them. Run \`swamp doctor datastores\` for details`;
    }
  }

  /**
   * Whether the file at `path` holds `content`, by size and then hash
   * (swamp-club#3617). An at-risk copy made by hard link shares its inode
   * with a checkout file, so an edit there in place changes the copy while
   * it is still named by the old hash; its size alone proves nothing. A
   * missing file holds nothing.
   */
  async #holdsContent(
    path: string,
    content: { readonly sha256: string; readonly size: number },
    signal: AbortSignal,
  ): Promise<boolean> {
    if (await sizeOf(path) !== content.size) return false;
    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, { read: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
    const held = await refOfFile(this.#chunkStore, file, signal);
    return held.sha256 === content.sha256 && held.size === content.size;
  }

  /**
   * Tries to store up to {@link AT_RISK_RETRIES} at-risk copies, the least
   * recently tried first, each at most once per {@link RETRY_INTERVAL_MS}
   * (swamp-club#3617). A copy whose referenced chunks are all stored, or
   * no longer referenced, is deleted without being read; one gone is
   * forgotten. One whose hash no longer matches its name (a hard link whose
   * checkout file was edited in place) holds nothing it can store: it is
   * deleted with a warning. Once the storage refuses a put as unauthorised, no copy is
   * tried again in this process. Never fails the section: a failure is
   * logged and tried again later.
   */
  async #retryAtRiskCopies(signal: AbortSignal): Promise<void> {
    if (this.#atRiskRefused) return;
    try {
      await this.#adoptAtRiskCopies();
    } catch (error) {
      logger.warn`Cannot list the read model's at-risk copies: ${error}`;
    }
    const now = this.#clock().getTime();
    const due = this.#state.atRiskDue(
      AT_RISK_RETRIES,
      now - RETRY_INTERVAL_MS,
    );
    for (const copy of due) {
      signal.throwIfAborted();
      const path = atRiskCopyPath(this.#stateDir, copy.namespace, copy.sha256);
      try {
        if (!await this.#storeAtRiskCopy(copy, path, signal)) {
          logger
            .warn`The at-risk copy ${path} no longer holds the content it is named for, so it cannot store that content's chunks and was deleted`;
        }
        await Deno.remove(path).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
        this.#state.deleteAtRiskCopy(copy.namespace, copy.sha256);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof Deno.errors.NotFound) {
          // Deleted by hand: nothing is left to store.
          this.#state.deleteAtRiskCopy(copy.namespace, copy.sha256);
          continue;
        }
        this.#state.noteAtRiskAttempt(copy.namespace, copy.sha256, now);
        logger.debug`Cannot store the at-risk copy ${path} yet: ${error}`;
        if (error instanceof ChunkPutError && isUnauthorised(error.cause)) {
          this.#atRiskRefused = true;
          return;
        }
      }
    }
  }

  /**
   * Stores the referenced chunks an at-risk copy holds that the storage
   * does not, or holds damaged where it reads sizes; checks the storage
   * before reading the copy. Before storing,
   * checks the copy's hash against its name, and resolves `false`, storing
   * nothing, when they differ. Rejects with `NotFound` when the copy is
   * gone.
   */
  async #storeAtRiskCopy(
    copy: StoredAtRiskCopy,
    path: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const ns = namespaceOf(copy.namespace);
    await Deno.lstat(path);
    // A copy recorded without its reference, after a crash, is cut first.
    const { ref, parts } = copy.blob !== undefined
      ? { ref: copy.blob, parts: partsWithOffsets(copy.blob) }
      : await refOfFile(
        this.#chunkStore,
        await Deno.open(path, { read: true }),
        signal,
      );
    if (copy.blob === undefined && ref.sha256 !== copy.sha256) return false;
    const missing = new Set(await this.#chunkStore.missing(ns, ref, signal));
    const absent = uniqueParts(
      parts.filter((part) => missing.has(part.sha256)),
    );
    // `missing` reports a chunk of the right size as present, so on a
    // storage that reads sizes the rest are read: a copy moved aside for a
    // damaged chunk of the right size is the only good copy of it.
    const held = this.#chunkStore.readsSizes
      ? uniqueParts(parts.filter((part) => !missing.has(part.sha256)))
      : [];
    if (absent.length === 0 && held.length === 0) return true;
    const referenced = await this.#referencedChunks(
      copy.namespace,
      [...absent, ...held].map((part) => part.sha256),
    );
    const need = absent.filter((part) => referenced.has(part.sha256));
    const named = held.filter((part) => referenced.has(part.sha256));
    if (named.length > 0) {
      for (
        const part of await this.#chunkStore.verifyParts(ns, named, signal)
      ) {
        need.push(part);
      }
    }
    if (need.length === 0) return true;
    if (
      copy.blob !== undefined &&
      !await this.#holdsContent(path, copy.blob, signal)
    ) {
      // Gone between the lstat and now reads as gone.
      await Deno.lstat(path);
      return false;
    }
    const { stored, changed } = await this.#chunkStore.putParts(
      ns,
      fileRangeReader(path),
      need,
      signal,
    );
    await this.#chunkStore.syncStored(ns, stored, signal);
    if (changed.length > 0) {
      throw new Error(
        `the copy no longer holds chunk ${changed[0]} at its offset`,
      );
    }
    return true;
  }

  /**
   * Records at-risk copies a crash left without their row: the file was
   * moved aside but its row never committed. Removes the temp files a crash
   * mid-copy left, once older than {@link AT_RISK_TEMP_GRACE_MS} and not
   * being written by this process.
   */
  async #adoptAtRiskCopies(): Promise<void> {
    const root = join(this.#stateDir, AT_RISK_DIR);
    let namespaces: Deno.DirEntry[];
    try {
      namespaces = await Array.fromAsync(Deno.readDir(root));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of namespaces) {
      if (!entry.isDirectory) continue;
      const namespace = entry.name === storageNamespaceOf(SOLO_NAMESPACE)
        ? ""
        : entry.name;
      for await (const copy of Deno.readDir(join(root, entry.name))) {
        if (copy.isFile && AT_RISK_TEMP.test(copy.name)) {
          await this.#removeStaleTemp(join(root, entry.name, copy.name));
          continue;
        }
        if (!copy.isFile || !/^[0-9a-f]{64}$/.test(copy.name)) continue;
        if (this.#state.hasAtRiskCopy(namespace, copy.name)) continue;
        const size = await sizeOf(join(root, entry.name, copy.name));
        if (size === undefined) continue;
        this.#state.recordAtRiskCopy({
          namespace,
          sha256: copy.name,
          recordKey: "",
          size,
          createdAt: this.#clock(),
          lastAttempt: new Date(0),
        });
      }
    }
  }

  /** Removes the at-risk temp file at `path` once it is stale. */
  async #removeStaleTemp(path: string): Promise<void> {
    if (copiesInFlight.has(path)) return;
    try {
      const modified = (await Deno.lstat(path)).mtime?.getTime();
      if (
        modified !== undefined &&
        this.#clock().getTime() - modified < AT_RISK_TEMP_GRACE_MS
      ) {
        return;
      }
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  /**
   * Tries again up to {@link UNREADABLE_RETRIES} unreadable records, the
   * least recently looked at first (swamp-club#3617). On a storage that
   * reads chunk sizes a record is tried only once its chunk appeared or
   * changed; one with no chunk to watch, or on another storage, once per
   * {@link RETRY_INTERVAL_MS} from its last try. Only a record
   * whose key still shows its put is written; its row is then forgotten
   * and its key listed as written unsynced, in one transaction. Never
   * fails the catch-up.
   */
  async #retryUnreadable(signal: AbortSignal): Promise<void> {
    // The tries this pass looked at, written in one transaction at its end,
    // or as it fails.
    const attempts: StoredUnreadableRecord[] = [];
    try {
      await this.#retryUnreadableRecords(signal, attempts);
    } catch (error) {
      try {
        this.#state.noteUnreadableAttempts(attempts);
      } catch (noted) {
        logger.debug`Could not record the unreadable records tried: ${noted}`;
      }
      throw error;
    }
    this.#state.noteUnreadableAttempts(attempts);
  }

  /** One pass of {@link #retryUnreadable}; collects its tries in `attempts`. */
  async #retryUnreadableRecords(
    signal: AbortSignal,
    attempts: StoredUnreadableRecord[],
  ): Promise<void> {
    const now = this.#clock();
    for (const record of this.#state.unreadableDue(UNREADABLE_RETRIES)) {
      signal.throwIfAborted();
      const blob = record.blob;
      const owner = this.#state.fileOwnership(
        record.namespace,
        record.recordKey,
      );
      if (
        owner === undefined || !owner.present ||
        owner.owner !== record.partition || owner.mark !== record.position ||
        // A key the checkout never projects has no file of the read
        // model's to retry; one recorded before swamp-club#3691 is dropped.
        this.#unprojected(record.namespace, record.recordKey)
      ) {
        // The file no longer shows this put. Every commit that moves a
        // key's ownership decides the key and forgets its row with it, so
        // no later commit would: the row would head every retry forever.
        // A compacted-base load drops such rows the same way.
        this.#state.forgetUnreadable(record.namespace, record.recordKey);
        continue;
      }
      let seen: StoredUnreadableRecord = { ...record, lastAttempt: now };
      if (blob === undefined) {
        // Nothing to retry: looked at, so the next catch-up looks at
        // others first.
        attempts.push(seen);
        continue;
      }
      const ns = namespaceOf(record.namespace);
      const chunk = record.chunk;
      if (this.#chunkStore.readsSizes && chunk !== undefined) {
        let stat:
          | { readonly size: number; readonly lastModified: Date }
          | undefined;
        try {
          stat = (await this.#chunkStore.stat(ns, [chunk], signal))?.get(
            chunk,
          );
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          // Looked at: the next catch-up looks at others first, and sees
          // the chunk as it was.
          attempts.push(seen);
          logger
            .debug`Could not look at ${chunk} for ${record.recordKey}: ${error}`;
          continue;
        }
        const { chunkSize: _size, chunkMtime: _mtime, ...rest } = seen;
        seen = stat === undefined ? rest : {
          ...rest,
          chunkSize: stat.size,
          chunkMtime: stat.lastModified.getTime(),
        };
        if (
          seen.chunkSize === record.chunkSize &&
          seen.chunkMtime === record.chunkMtime
        ) {
          // Looked at: the next catch-up looks at others first.
          attempts.push(seen);
          continue;
        }
      } else if (
        // No chunk to watch: once per interval, measured from the last
        // retry, so a skip leaves the time as it was.
        now.getTime() - record.lastAttempt.getTime() < RETRY_INTERVAL_MS
      ) {
        continue;
      }
      let path: string | undefined;
      try {
        path = await this.#target(
          record.namespace,
          RecordKey.create(record.recordKey),
          true,
          "the retry of an unreadable record",
        );
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        logger.warn`Not retrying ${record.recordKey}: ${error}`;
        path = undefined;
      }
      if (path === undefined) {
        attempts.push(seen);
        continue;
      }
      const batch = this.#writeBatch();
      try {
        await this.#writeContent(
          record.namespace,
          record.recordKey,
          path,
          withAccess({ blob }, record.access),
          signal,
          batch,
          { partition: record.partition, seq: record.seq },
        );
        await batch.barrier();
        this.#state.clearUnreadable(
          record.namespace,
          record.recordKey,
          this.#boot,
        );
        logger.info`${record.recordKey} is readable again and was written`;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof CheckoutCopyAtRiskError) throw error;
        attempts.push(await this.#failedRetry(seen, blob, error, signal));
        logger.debug`${record.recordKey} is still unreadable: ${error}`;
      } finally {
        batch.discard();
      }
    }
  }

  /**
   * The unreadable record a failed retry leaves: the chunk the failure
   * names, why, and how it looks now (swamp-club#3617), so the next retry
   * waits for the chunk that is failing now, not one that came back. A
   * failure that names no chunk, or a chunk that cannot be found, keeps
   * `seen`.
   */
  async #failedRetry(
    seen: StoredUnreadableRecord,
    blob: BlobRef,
    error: unknown,
    signal: AbortSignal,
  ): Promise<StoredUnreadableRecord> {
    if (!isChunkError(error)) return seen;
    try {
      const failing = await this.#unreadable(
        seen.namespace,
        seen.recordKey,
        withAccess(
          { partition: seen.partition, seq: seen.seq, position: seen.position },
          seen.access,
        ),
        blob,
        error,
        signal,
      );
      return failing.chunk === undefined ? seen : failing;
    } catch (lookup) {
      if (signal.aborted) throw signal.reason;
      logger
        .debug`Cannot tell which chunk of ${seen.recordKey} fails: ${lookup}`;
      return seen;
    }
  }
}

/** Keys an unreadable-record warning was logged for in this process. */
const warnedUnreadable = new Set<string>();

/** Whether this process warned that a file was moved aside. */
let warnedAtRisk = false;

/** Warns once per process and key that a record cannot be read. */
function warnUnreadable(record: UnreadableRecord): void {
  const id = `${record.namespace}\u0000${record.recordKey}`;
  if (warnedUnreadable.has(id)) return;
  warnedUnreadable.add(id);
  logger.warn`${record.recordKey} cannot be read: chunk ${
    record.chunk ?? "(unknown)"
  } is ${record.reason} in the datastore, so its file is absent from this checkout. ${
    unreadableRecordAdvice(record.recordKey)
  }`;
}

function isChunkError(
  error: unknown,
): error is ChunkMissingError | ChunkIntegrityError {
  return error instanceof ChunkMissingError ||
    error instanceof ChunkIntegrityError;
}

/** A rename refused because the target lies on another device. */
function isCrossDevice(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as { code?: unknown }).code === "EXDEV" ||
    /cross-device|os error 18\b/i.test(error.message) ||
    // ERROR_NOT_SAME_DEVICE; on POSIX 17 is EEXIST.
    (Deno.build.os === "windows" && /os error 17\b/.test(error.message));
}

/** Error codes and names a storage refuses a put for want of rights with. */
const UNAUTHORISED_CODES = new Set([
  "accessdenied",
  "accessdeniedexception",
  "allaccessdisabled",
  "eacces",
  "eperm",
  "forbidden",
  "invalidaccesskeyid",
  "permissiondenied",
  "unauthenticated",
  "unauthorized",
]);

/**
 * A put the storage refused for want of rights, not a passing failure:
 * Deno's `PermissionDenied` (a filesystem's EACCES), or an error, or one of
 * its causes, carrying HTTP status 401 or 403 (`status`, `statusCode`,
 * `httpStatusCode`, `$metadata.httpStatusCode`, `response.status`, a
 * numeric `code`) or an access-denied code or name (S3's `AccessDenied`).
 * A message alone counts only when it names both the status and the
 * refusal, so a 403 that is merely part of a key or a size does not.
 */
function isUnauthorised(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    if (current instanceof Deno.errors.PermissionDenied) return true;
    if (typeof current !== "object") break;
    const fields = current as Record<string, unknown>;
    const nested = (holder: unknown, name: string): unknown =>
      typeof holder === "object" && holder !== null
        ? (holder as Record<string, unknown>)[name]
        : undefined;
    const statuses = [
      fields.status,
      fields.statusCode,
      fields.httpStatusCode,
      fields.code,
      nested(fields.$metadata, "httpStatusCode"),
      nested(fields.response, "status"),
    ];
    if (statuses.some((status) => status === 401 || status === 403)) {
      return true;
    }
    for (const name of [fields.code, fields.Code, fields.name]) {
      if (
        typeof name === "string" && UNAUTHORISED_CODES.has(name.toLowerCase())
      ) {
        return true;
      }
    }
    current = fields.cause;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b40[13]\b.*\b(?:unauthori[sz]ed|forbidden|access ?denied)\b|\b(?:unauthori[sz]ed|forbidden|access ?denied)\b.*\b40[13]\b/i
    .test(message);
}

/** Each part once, first occurrence kept: content can repeat a chunk. */
function uniqueParts(parts: readonly ContentPart[]): ContentPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    if (seen.has(part.sha256)) return false;
    seen.add(part.sha256);
    return true;
  });
}

/** Every part of `ref`, one for content in a single chunk. */
function partsOf(ref: BlobRef): readonly ContentPart[] {
  return partsWithOffsets(ref);
}

/** What a read of a file holding `blob`'s content finds. */
function contentPartsOf(blob: BlobRef): ContentParts {
  return {
    ref: blob,
    sha256: blob.sha256,
    size: blob.size,
    parts: partsWithOffsets(blob),
  };
}

/**
 * Whether `info`, a stat of the file at a written file's path, shows it as
 * the read model wrote it: the same inode, size, and modification and change
 * times. Any write, truncation, rename over it or `utime` changes one.
 */
function stillAsWritten(written: WrittenFile, info: Deno.FileInfo): boolean {
  return info.ino === written.ino && info.dev === written.dev &&
    info.size === written.size &&
    info.mtime?.getTime() === written.mtime &&
    (info.ctime?.getTime() ?? undefined) === written.ctime;
}

/** The parts of `ref` with the offsets they start at. */
function partsWithOffsets(ref: BlobRef): ContentPart[] {
  const parts = ref.parts ?? [{ sha256: ref.sha256, size: ref.size }];
  let offset = 0;
  return parts.map(({ sha256, size }) => {
    const part = { sha256, size, offset };
    offset += size;
    return part;
  });
}

/** Reads a file by byte range, reopening it for each range. */
function fileRangeReader(path: string): ContentRangeReader {
  return async (offset, length, signal) => {
    signal.throwIfAborted();
    const file = await Deno.open(path, { read: true });
    try {
      await file.seek(offset, Deno.SeekMode.Start);
      const bytes = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        signal.throwIfAborted();
        const n = await file.read(bytes.subarray(read));
        if (n === null) break;
        read += n;
      }
      return bytes.subarray(0, read);
    } finally {
      file.close();
    }
  };
}

/**
 * Cuts the open `file` as `chunkStore` would, closing it on every path: its
 * readable closes it when read to the end, and an abort or a failure before
 * or during the read leaves it to this.
 */
async function refOfFile(
  chunkStore: ChunkStore,
  file: Deno.FsFile,
  signal: AbortSignal,
): Promise<ContentParts> {
  try {
    return await chunkStore.refOf(file.readable, signal);
  } finally {
    try {
      file.close();
    } catch {
      // Already closed by its readable.
    }
  }
}

/**
 * Syncs the existing file at `path`: through a writable handle, which
 * Windows needs, or a read handle where it cannot be opened for writing
 * (POSIX syncs either).
 */
async function syncExistingFile(path: string): Promise<void> {
  let handle: Deno.FsFile;
  try {
    handle = await Deno.open(path, { read: true, write: true });
  } catch (error) {
    if (
      !(error instanceof Deno.errors.PermissionDenied) ||
      Deno.build.os === "windows"
    ) {
      throw error;
    }
    handle = await Deno.open(path, { read: true });
  }
  try {
    await handle.sync();
  } finally {
    handle.close();
  }
}

/** A regular file's size; undefined when absent or not a file. */
async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile ? info.size : undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/**
 * Copies `from` to `to` through a synced temp file and a rename in `to`'s
 * directory, so `to` never holds a partial copy.
 */
async function copyDurably(from: string, to: string): Promise<void> {
  const tmp = join(dirname(to), `.${crypto.randomUUID()}.tmp`);
  copiesInFlight.add(tmp);
  try {
    await Deno.copyFile(from, tmp);
    const file = await Deno.open(tmp, { read: true, write: true });
    try {
      await file.sync();
    } finally {
      file.close();
    }
    await Deno.rename(tmp, to);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  } finally {
    copiesInFlight.delete(tmp);
  }
}

/** The name of a temp file {@link copyDurably} writes. */
const AT_RISK_TEMP = /^\.[0-9a-f-]{36}\.tmp$/;

/** Temp files {@link copyDurably} is writing in this process. */
const copiesInFlight = new Set<string>();

function appliedRecord(put: PutOp | null): AppliedRecord | null {
  if (put === null) return null;
  return withAccess(
    "blob" in put.content
      ? { sha256: put.sha256, blob: put.content.blob }
      : { sha256: put.sha256 },
    put.access,
  );
}

/** `value` with `access` as an optional field (swamp-club#3693). */
function withAccess<T extends object>(
  value: T,
  access: FileAccess | undefined,
): T & { readonly access?: FileAccess } {
  return access === undefined ? value : { ...value, access };
}

/**
 * Removes a record's file, after `batch` lets go of it. A missing file is
 * fine. A directory at the key (a tombstone of a name directory) is removed
 * only when empty: its files are other records. The caller has the right
 * directory synced.
 */
async function removeRecordFile(
  path: string,
  batch: DurableWriteBatch,
): Promise<void> {
  await batch.release(path);
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
}

/** A file and a directory claiming one path: which one, and why. */
interface PathConflict {
  /** `under-file`: an ancestor is a file. `directory`: the path is one. */
  readonly kind: "under-file" | "directory";
  readonly reason: string;
}

/**
 * The conflict at `segments` under `root`, if any, and the length of the
 * shortest prefix that does not exist, if any: the path itself is absent, and
 * so is everything under that prefix.
 */
async function pathConflict(
  root: string,
  segments: readonly string[],
  paths: PathCache,
): Promise<{ conflict?: PathConflict; missingFrom?: number }> {
  for (let i = 1; i <= segments.length; i++) {
    const prefix = join(root, ...segments.slice(0, i));
    if (i < segments.length && paths.isDirectory(prefix)) continue;
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(prefix);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { missingFrom: i };
      throw error;
    }
    if (info.isDirectory) paths.markDirectory(prefix);
    const at = segments.slice(0, i).join("/");
    if (i < segments.length && !info.isDirectory) {
      return {
        conflict: {
          kind: "under-file",
          reason: `${at} is a file, so it cannot hold a record`,
        },
      };
    }
    if (i === segments.length && info.isDirectory) {
      return {
        conflict: { kind: "directory", reason: `${at} is a directory` },
      };
    }
  }
  return {};
}

/**
 * Whether `path` is a regular file holding exactly `bytes` (swamp-club#3893).
 * Stat first, as the guard reads a file ({@link SqliteReadModel}'s
 * `#readGuarded`): a link, a directory or a file hard-linked from elsewhere
 * there never holds them.
 */
async function holdsBytes(path: string, bytes: Uint8Array): Promise<boolean> {
  let held: Uint8Array;
  try {
    const info = await Deno.lstat(path);
    // A file linked from elsewhere is replaced, as a write replaces it.
    if (!info.isFile || (info.nlink ?? 1) > 1) return false;
    if (info.size !== bytes.length) return false;
    held = await Deno.readFile(path);
  } catch {
    return false;
  }
  if (held.length !== bytes.length) return false;
  for (let i = 0; i < held.length; i++) {
    if (held[i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Whether the file at `path` has `access` (swamp-club#3693), as
 * {@link satisfiesAccess} judges it. Always true on Windows, which keeps no
 * modes; false when it cannot be stat'ed, so the write that follows finds
 * out why.
 */
async function hasAccess(
  path: string,
  access: FileAccess | undefined,
): Promise<boolean> {
  if (Deno.build.os === "windows") return true;
  try {
    const { mode } = await Deno.lstat(path);
    return mode === null || satisfiesAccess(mode, access);
  } catch {
    return false;
  }
}

/**
 * True when the file at `path` is what the state says: a regular file with
 * the expected SHA-256, or absent (a directory left at a removed key holds
 * other records). A file the state cannot describe, or one that cannot be
 * read (its permissions changed, say), never matches: the replay that
 * follows rewrites it, where an error here would refuse every catch-up.
 */
async function holdsExpected(
  path: string,
  file: UnsyncedFile,
): Promise<boolean> {
  if (file.expect === "unknown") return false;
  try {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      // Under a file, the path cannot exist either.
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.NotADirectory
      ) {
        return file.expect === "absent";
      }
      throw error;
    }
    if (file.expect !== "present") return info.isDirectory;
    if (!info.isFile) return false;
    const hash = createHash("sha256");
    // The readable closes the file when it ends or fails.
    const handle = await Deno.open(path, { read: true });
    for await (const piece of handle.readable) hash.update(piece);
    return hash.digest("hex") === file.sha256;
  } catch (error) {
    logger.warn`Cannot check ${path} after a restart: ${error}`;
    return false;
  }
}

/** True when the resolved `path` lies in or at the resolved `dir`. */
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + SEPARATOR);
}

/**
 * What the key guards learned about directories in one exclusive section,
 * so a page of a thousand files under one directory resolves and stats it
 * once (swamp-club#3337) instead of once per file. Only directories are
 * remembered: a file's own path is always looked at. The read model clears
 * it whenever it removes anything, and at the start of every section, since
 * another process may have changed the tree in between.
 */
class PathCache {
  /** Paths `stat` found to be directories. */
  readonly #directories = new Set<string>();
  /** Directories' real paths, as `resolveRealPath` gives them. */
  readonly #resolved = new Map<string, string>();
  /** Absent directories above a path just checked, for its write. */
  readonly #absent = new Map<string, readonly string[]>();

  isDirectory(path: string): boolean {
    return this.#directories.has(path);
  }

  markDirectory(path: string): void {
    this.#directories.add(path);
  }

  /**
   * Records `dir`, just created by `mkdir`, as a directory whose real path
   * is its parent's and its own name, when its parent's is known.
   */
  markCreated(dir: string): void {
    this.#directories.add(dir);
    const parent = this.#resolved.get(dirname(dir));
    if (parent !== undefined) {
      this.#resolved.set(dir, join(parent, basename(dir)));
    }
  }

  /**
   * Records which directories above `path` the guard found absent, deepest
   * first, for the write that follows; an empty list says they all exist.
   */
  noteAbsent(path: string, dirs: readonly string[]): void {
    this.#absent.set(path, dirs);
  }

  /** What {@link noteAbsent} recorded for `path`, once. */
  takeAbsent(path: string): readonly string[] | undefined {
    const dirs = this.#absent.get(path);
    this.#absent.delete(path);
    return dirs;
  }

  /**
   * `resolveRealPath(path)`. A path that does not exist resolves to its
   * directory's real path and its own name, which is what
   * `resolveRealPath` gives too, so only its directory is remembered. A path
   * that exists is resolved in full: it may be a symlink, and on a
   * case-insensitive filesystem its real name may differ from the key's.
   */
  async resolve(path: string): Promise<string> {
    try {
      await Deno.lstat(path);
      return await resolveRealPath(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const dir = dirname(path);
    if (dir === path) return await resolveRealPath(path);
    return join(await this.resolveDirectory(dir), basename(path));
  }

  /** `resolveRealPath(dir)` for a directory, such as a boundary. */
  async resolveDirectory(dir: string): Promise<string> {
    let real = this.#resolved.get(dir);
    if (real === undefined) {
      real = await resolveRealPath(dir);
      this.#resolved.set(dir, real);
    }
    return real;
  }

  clear(): void {
    this.#directories.clear();
    this.#resolved.clear();
    this.#absent.clear();
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

/**
 * Whether `path` reaches a file only under another spelling: some segment
 * below `root` has no directory entry of exactly its name, and yet `lstat`
 * finds the path, as on a case- or normalisation-insensitive filesystem
 * (APFS, NTFS) where `VPC/1/raw` reaches `vpc/1/raw`. False when nothing is
 * there, or when every segment is spelled exactly.
 */
export async function isAliasedSpelling(
  path: string,
  root: string,
): Promise<boolean> {
  try {
    await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..")) return false;
  let dir = root;
  for (const segment of rel.split(SEPARATOR)) {
    let exact = false;
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === segment) {
        exact = true;
        break;
      }
    }
    if (!exact) return true;
    dir = join(dir, segment);
  }
  return false;
}
