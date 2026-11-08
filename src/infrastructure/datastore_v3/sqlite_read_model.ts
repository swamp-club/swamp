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
 * per commit: files, then the catalog, then one state transaction; effects are
 * idempotent, so a crash is repaired by catching up from the unchanged cursor,
 * and the index is never ahead of the files
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
import {
  MAX_INLINE_BYTES,
  type PutExpect,
  type PutOp,
} from "../../domain/datastore_v3/op.ts";
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
import { type Span, withSpan } from "../tracing/tracer.ts";
import {
  type AppliedRecord,
  type FileOwnership,
  type LiveRecordWriter,
  type LoadKey,
  ReadModelState,
  type RecordContent,
  REPLAY_PENDING,
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
  foldSpelling,
  probeSpellingFolding,
  type SpellingFolding,
  spellingFoldingOf,
} from "./spelling_folding.ts";
import {
  ProjectedCatalog,
  type ReadModelCatalog,
  V3Catalog,
} from "./v3_catalog.ts";

export const UNSYNCED_SYNC_BATCH = 500;

const MAX_UNSYNCED_SYNC_BATCHES = 1_000;

const logger = getLogger(["swamp", "datastore", "read-model"]);

export const DEFAULT_READ_MODEL_PAGE_SIZE = 500;

export { CATALOG_V3_FILE };

export const READ_MODEL_STATE_FILE = "_read_model_v3.db";

export const READ_MODEL_LOCK_FILE = "read_model.lock";

export const AT_RISK_DIR = "at-risk";

export const DEFAULT_AT_RISK_COPY_BYTES = 1024 * 1024 * 1024;

const AT_RISK_RETRIES = 8;

const UNREADABLE_RETRIES = 32;

export const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * a crash mid-copy leaves a temp file that adoption removes after this long;
 * one this process is still writing is never removed
 */
export const AT_RISK_TEMP_GRACE_MS = 60 * 60 * 1000;

/**
 * Releases counted as references by the checkout-copy guard: none. A chunk
 * history compaction released may already be gone, and storing it again
 * would only feed the next sweep.
 */
export const NOT_RELEASED = new Date(8.64e15);

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

export interface ReadModelCheckout {
  readonly namespace: string;
  readonly admits: (key: string) => boolean;
}

/**
 * reserved: namespace named after one of swamp's .swamp/ directories; local: a
 * solo or own-namespace key the checkout's filter leaves out, whose file and
 * rows are the checkout's own local data
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

export interface SqliteReadModelOptions {
  readonly commitStore: CommitStore;
  readonly chunkStore: ChunkStore;
  readonly cacheRoot: (namespace: string) => string;
  readonly stateDir: string;
  readonly pageSize?: number;
  readonly catalog?: ReadModelCatalog;
  readonly checkout?: ReadModelCheckout;
  /**
   * by default a batch that does not sync when the boot can be named, since
   * files are checked after a reboot instead, and one that syncs when it cannot
   */
  readonly writeBatch?: () => DurableWriteBatch;
  readonly bootIdentity?: () => Promise<string | undefined>;
  /**
   * the chunks the checkout-copy guard stores again; released chunks never
   * count. By default the commit store's references without releases
   */
  readonly referencedChunks?: (
    namespace: string,
    hashes: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  readonly clock?: () => Date;
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly syncDirectory?: (dir: string) => Promise<void>;
  readonly readDir?: (dir: string) => AsyncIterable<Deno.DirEntry>;
  /** lets tests open two read models in one process as two processes */
  readonly pid?: number;
  readonly syncFile?: (path: string) => Promise<void>;
  readonly atRiskCopyBytes?: number;
  readonly os?: typeof Deno.build.os;
  /**
   * false replays every commit in full from the start of the feed, as a
   * recovery does; a net replay by default
   */
  readonly netReplay?: boolean;
  readonly spellingFolding?: SpellingFolding;
  /**
   * a partition's seqs can have holes where serve left out commits the caller
   * may not read, so any commit past the applied seq applies; off by default,
   * since the solo read model refuses a gap
   */
  readonly follower?: boolean;
  /**
   * told the keys whose files a page rewrote or removed, once applied, so
   * repositories can reindex; a file left as it was is not told; a failure is a
   * warning, as the page has landed
   */
  readonly recordsChanged?: (
    namespace: string,
    keys: readonly string[],
  ) => Promise<void>;
  /**
   * when set, a commit of another writer that changes a managed-config file
   * records the digest the file held before, the base a user's later edit
   * expects
   */
  readonly writerInstance?: string;
  /**
   * whether files already hold the commit's changes or newer ones, as a
   * catch-up during an open unit would replay its checkpoint over a later
   * write; state and catalog still apply; never asked in recover
   */
  readonly holdsOwnWork?: (commit: Commit) => boolean;
  /**
   * told once a commit is applied or found applied, which the read model never
   * replays but in a recovery; the caller of holdsOwnWork forgets it then
   */
  readonly ownWorkApplied?: (commit: Commit) => void;
}

interface ChangeSource {
  readonly partition: string;
  readonly seq: number;
}

const NO_COMMIT: ChangeSource = { partition: "", seq: 0 };

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
  readonly #follower: boolean;
  readonly #writerInstance: string | undefined;
  readonly #holdsOwnWork: ((commit: Commit) => boolean) | undefined;
  readonly #ownWorkApplied: ((commit: Commit) => void) | undefined;
  /**
   * set while recover replays: it puts back every file, so no commit is taken
   * for work the files hold; a root waiting on the recovery counts as open
   */
  #recovering = false;
  readonly #recordsChanged:
    | ((namespace: string, keys: readonly string[]) => Promise<void>)
    | undefined;
  #rewritten: Map<string, string | undefined> | undefined;
  /**
   * only the first change in a catch-up can replace what the checkout held, so
   * only it records a base
   */
  #catchUpTouched: Set<string> | undefined;
  #pageChanges: Map<string, Set<string>> | undefined;
  readonly #checkout: ReadModelCheckout | undefined;
  readonly #forcedFolding: SpellingFolding | undefined;
  #probedFolding: SpellingFolding | undefined;
  readonly #rootFolding = new Map<string, SpellingFolding>();
  readonly #warnedReserved = new Set<string>();
  /**
   * The files this exclusive section wrote, removed, or guarded already:
   * the guard never hashes one twice, nor one this section wrote.
   */
  readonly #guarded = new Set<string>();
  /**
   * set when this section replays commits over files it did not write (after a
   * reset, or a recovery): the guard then also reads stored parts of the right
   * size and guards overwrites on storage that cannot read sizes
   */
  #replaying = false;
  #atRiskRefused = false;
  #pageInFlight: Promise<void> | undefined;
  #boot: string | undefined;
  #stats: CatchUpStats | undefined;
  #outsideReset = false;
  #net: NetReplayPlan | undefined;
  /**
   * set while a net catch-up from an empty checkout runs: a compacted base it
   * meets first is netted with the tail after it
   */
  #netBase = false;
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
    // one filter for every catalog action, from commits and the compacted base
    // alike
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
    this.#follower = options.follower === true;
    this.#recordsChanged = options.recordsChanged;
    this.#writerInstance = options.writerInstance;
    this.#holdsOwnWork = options.holdsOwnWork;
    this.#ownWorkApplied = options.ownWorkApplied;
    this.#forcedFolding = options.spellingFolding;
  }

  static open(options: SqliteReadModelOptions): SqliteReadModel {
    const pageSize = options.pageSize ?? DEFAULT_READ_MODEL_PAGE_SIZE;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new Error(`pageSize must be a positive integer: ${pageSize}`);
    }
    const state = ReadModelState.open(
      join(options.stateDir, READ_MODEL_STATE_FILE),
      { pid: options.pid },
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

  cursor(): number {
    return this.#state.cursor();
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

  #time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    return this.#stats === undefined ? fn() : this.#stats.time(phase, fn);
  }

  #timeSync<T>(phase: string, fn: () => T): T {
    return this.#stats === undefined ? fn() : this.#stats.timeSync(phase, fn);
  }

  #counted<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return withSpan(name, {}, async (span) => {
      const stats = new CatchUpStats();
      this.#stats = stats;
      try {
        return await fn();
      } finally {
        this.#stats = undefined;
        span.setAttributes(stats.attributes());
        if (this.#outsideReset) {
          span.setAttributes({
            "swamp.datastore.v3.readmodel.outside_reset": 1,
          });
          this.#outsideReset = false;
        }
      }
    });
  }

  /**
   * synchronous, so a process killed before its next catch-up still replays;
   * catalog rows are kept and the replay rewrites them
   */
  markReplayPending(): void {
    this.#state.markReplayPending();
  }

  #warnOutsideReset(recorded: number, generation: number): void {
    this.#outsideReset = true;
    // On v3 only a catalog schema upgrade should get here, once.
    logger
      .warn`The query catalog was invalidated or rebuilt outside the read model (generation ${recorded}, now ${generation}), so every commit is applied again. This is expected once after a swamp upgrade; if it repeats, report it`;
  }

  /**
   * for a reader of a checkout another process writes: false at once while the
   * index is complete; otherwise waits up to lockWaitMs for the catch-up's
   * lock, then catches up itself if still incomplete
   */
  catchUpUnlessComplete(
    signal: AbortSignal,
    lockWaitMs: number,
    writerPid?: number,
  ): Promise<boolean> {
    if (this.#state.isComplete()) return Promise.resolve(false);
    return this.#exclusive(
      async () => {
        if (this.#state.isComplete()) return false;
        // the live writer left it so mid-command: its files are the newest;
        // a writer catches up in full when its command starts, so an older
        // incomplete state never carries its pid
        if (
          writerPid !== undefined &&
          this.#state.incompletePid() === writerPid
        ) {
          return false;
        }
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
   * replays every commit, then removes files no commit owns that the writer may
   * have written; names are judged as listed and NFC-composed since HFS+ lists
   * decomposed; run only under the writer lock
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
          this.#recovering = true;
          try {
            await this.#catchUpFeed(options.signal);
          } finally {
            this.#recovering = false;
          }
          return await this.#sweepUnowned(namespace, options);
        }),
      options.signal,
    );
  }

  /** a recovery is never a net replay, since it replays over files already there */
  async #catchUpFeed(
    signal: AbortSignal,
    options: { readonly net?: boolean } = {},
  ): Promise<CatchUpResult> {
    if (
      options.net === true && this.#netReplay && this.#state.cursor() === 0
    ) {
      this.#netBase = true;
      this.#net = await this.#planNetReplay(signal);
    }
    try {
      return await this.#catchUpFeedNow(signal);
    } finally {
      this.#net = undefined;
      this.#netBase = false;
    }
  }

  /**
   * undefined when the feed starts below a compaction point, which loads the
   * base instead
   */
  #planNetReplay(signal: AbortSignal): Promise<NetReplayPlan | undefined> {
    return withSpan(
      "swamp.datastore.v3.readmodel.net_plan",
      {},
      (span) => this.#readNetPlan(this.#netPlanner(), 0, signal, span),
    );
  }

  /**
   * undefined when the feed was compacted past point meanwhile: the base then
   * loads in full
   */
  #planBaseNet(
    point: number,
    signal: AbortSignal,
  ): Promise<NetReplayPlan | undefined> {
    return withSpan(
      "swamp.datastore.v3.readmodel.base_net_plan",
      {},
      (span) => {
        const planner = this.#netPlanner();
        for (const file of this.#state.stagedFiles()) {
          planner.seed(file.namespace, file.record_key, {
            owner: file.owner,
            mark: file.mark,
            present: file.present,
          });
        }
        return this.#readNetPlan(planner, point, signal, span);
      },
    );
  }

  #netPlanner(): NetReplayPlanner {
    return new NetReplayPlanner((namespace, key) =>
      unprojectedReason(namespace, key, this.#checkout) !== undefined ||
      refusedKeyReason(
          RecordKey.create(key),
          this.#cacheRoot(namespace),
          this.#stateDir,
        ) !== undefined
    );
  }

  async #readNetPlan(
    planner: NetReplayPlanner,
    from: number,
    signal: AbortSignal,
    span: Span,
  ): Promise<NetReplayPlan | undefined> {
    let cursor = from;
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
  }

  async #catchUpFeedNow(signal: AbortSignal): Promise<CatchUpResult> {
    this.#catchUpTouched = new Set();
    try {
      return await this.#catchUpFeedRun(signal);
    } finally {
      this.#catchUpTouched = undefined;
    }
  }

  async #catchUpFeedRun(signal: AbortSignal): Promise<CatchUpResult> {
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
        // the base reconciles files with the state, which a net replay's
        // skipped writes leave ahead of them: the rest replays in full, unless
        // nothing was applied yet, then the base is netted with the tail
        this.#net = undefined;
        const net = this.#netBase && this.#state.cursor() === 0;
        this.#netBase = false;
        await this.#loadBase(signal, net);
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
          async () => {
            this.#catchUpTouched = new Set();
            try {
              return await this.#catchUpPartition(namespace, partition, signal);
            } finally {
              this.#catchUpTouched = undefined;
            }
          },
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
   * as of the last commit applied; serve checks a forwarded put against it,
   * after catching up
   */
  fileOwner(
    namespace: string,
    key: string,
  ): Promise<FileOwnership | undefined> {
    return this.#afterPage(() => this.#state.fileOwnership(namespace, key));
  }

  /**
   * undefined when no commit replaced it since the user last loaded it or the
   * checkout last committed it
   */
  configBase(
    namespace: string,
    partition: PartitionKey,
    key: string,
  ): PutExpect | undefined {
    return this.#state.configBase(namespace, partition.toString(), key);
  }

  configBases(
    namespace: string,
    partition: PartitionKey,
  ): { readonly key: string; readonly base: PutExpect }[] {
    return this.#state.configBases(namespace, partition.toString());
  }

  clearConfigBases(
    namespace: string,
    partition: PartitionKey,
    key?: string,
  ): void {
    this.#state.clearConfigBases(namespace, partition.toString(), key);
  }

  liveRecord(
    namespace: string,
    partition: PartitionKey,
    key: string,
  ): Promise<LiveRecordWriter | undefined> {
    return this.#afterPage(() =>
      this.#state.liveRecord(namespace, partition.toString(), key)
    );
  }

  holdsRecordsUnder(namespace: string, prefix: string): Promise<boolean> {
    return this.#afterPage(() =>
      this.#state.holdsRecordsUnder(namespace, prefix)
    );
  }

  /**
   * undefined when the partition holds no such record or the checkout's file is
   * absent, unprojected or holds other bytes; serve checks a forwarded edit
   * against these bytes
   */
  async recordBytes(
    namespace: string,
    partition: PartitionKey,
    key: string,
    maxBytes = Number.POSITIVE_INFINITY,
  ): Promise<
    | { readonly record: LiveRecordWriter; readonly bytes: Uint8Array }
    | undefined
  > {
    const record = await this.liveRecord(namespace, partition, key);
    if (record === undefined || this.#unprojected(namespace, key)) {
      return undefined;
    }
    const root = this.#cacheRoot(namespace);
    if (refusedKeyReason(RecordKey.create(key), root, this.#stateDir)) {
      return undefined;
    }
    const path = join(root, ...key.split("/"));
    let bytes: Uint8Array;
    try {
      if ((await Deno.stat(path)).size > maxBytes) return undefined;
      bytes = await Deno.readFile(path);
    } catch {
      return undefined;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    return digest === record.sha256 ? { record, bytes } : undefined;
  }

  chunksInUse(namespace: string): Promise<ReadonlySet<string>> {
    return this.#afterPage(() => {
      const chunks = this.#state.chunksInUseIfComplete(namespace);
      if (chunks === undefined) throw new ReadModelIncompleteError();
      return chunks;
    });
  }

  /**
   * a page's state is uncommitted until its barrier, so a read mid-page would
   * see what a failed page rolls back; it waits for no catch-up and no other
   * process's lock
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
   * compare paths as the repository spells them first, and resolve both only
   * when the path is not under the root as written (a symlinked checkout, macOS
   * /tmp)
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
          if (!await lock.tryLock(true)) {
            logger
              .info`Waiting for another swamp command to finish updating this checkout's read model`;
            await lock.lock(true);
          }
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
        this.#state.forgetFoldedKeys();
        this.#guarded.clear();
        this.#replaying = false;
        this.#outsideReset = false;
        const generation = this.#catalog.generation();
        // first, so a reset below cannot drop the list unchecked
        this.#boot = await this.#bootIdentity();
        await this.#checkUnsyncedAfterReboot(
          generation,
          signal ?? new AbortController().signal,
        );
        // A catalog rebuilt, invalidated or created afresh holds none of the
        // commits the state says are applied: start over.
        const recorded = this.#state.catalogGeneration();
        if (recorded !== generation || !this.#catalog.isPopulated()) {
          if (recorded !== undefined && recorded !== REPLAY_PENDING) {
            this.#warnOutsideReset(recorded, generation);
          }
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
   * works in batches, each in its own lock section so a long list never holds
   * other commands back; in a batch each file is synced, then directories
   * deepest first
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
   * a file that cannot be synced stays listed, so the reboot check still covers
   * it
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
   * resets to replay every commit, keeping removal candidates: the unsynced
   * keys too when written in another boot or the current one cannot be named
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
   * a file a crash lost or tore is rewritten to what the state says, or
   * removed; one whose expected content is unknown or unreadable resets the
   * state so every commit applies again
   */
  async #checkUnsyncedAfterReboot(
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const written = this.#state.unsyncedBoot();
    if (written === undefined || written === this.#boot) return;
    // Whether the boot ended is unknown, so a file that matches may be held
    // only by the page cache: it is synced, never trusted as on disk.
    const unnamed = this.#boot === undefined;
    if (unnamed) {
      logger
        .warn`The current boot cannot be named, so files written unsynced in an earlier one are checked and synced`;
    }
    const batch = new DurableWriteBatch();
    const commits = new Map<number, Commit | undefined>();
    try {
      for (const file of this.#state.unsyncedFiles()) {
        signal.throwIfAborted();
        // a key the checkout never projects is skipped, not a reason to apply
        // every commit again: older state may list one, and its file is the
        // checkout's own now
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
          if (unnamed) {
            if (file.expect === "present") await this.#syncFile(path);
            batch.touch(dirname(path));
          }
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

  async #prefetchBaseChunks(
    writes: readonly { namespace: string; record_key: string }[],
    signal: AbortSignal,
  ): Promise<void> {
    const byNamespace = new Map<string, BlobRef[]>();
    for (const { namespace, record_key } of writes) {
      const content = this.#state.loadContent(namespace, record_key);
      if (content === undefined || !("blob" in content)) continue;
      if (content.blob.legacyKey !== undefined) continue;
      if (unprojectedReason(namespace, record_key, this.#checkout)) continue;
      const owner = this.#state.loadFile(namespace, record_key);
      if (
        owner !== undefined &&
        this.#net?.skipsWrite(namespace, record_key, owner.mark) === true
      ) {
        continue;
      }
      const refs = byNamespace.get(namespace) ?? [];
      refs.push(content.blob);
      byNamespace.set(namespace, refs);
    }
    if (byNamespace.size === 0) return;
    await withSpan("swamp.datastore.v3.readmodel.prefetch", {}, async () => {
      for (const [namespace, refs] of byNamespace) {
        await this.#chunkStore.prefetch(namespaceOf(namespace), refs, signal);
      }
    });
  }

  /**
   * the chunks the page's apply will read, fetched together: never a key this
   * checkout does not project, nor a write a net replay skips
   */
  async #prefetchChunks(
    page: readonly CommitChange[],
    signal: AbortSignal,
  ): Promise<void> {
    const byNamespace = new Map<string, BlobRef[]>();
    for (const change of page) {
      const { commit } = change;
      for (const keyChange of finalKeyStates(commit)) {
        const put = keyChange.put;
        if (put === null || !("blob" in put.content)) continue;
        if (put.content.blob.legacyKey !== undefined) continue;
        const key = keyChange.key.toString();
        if (unprojectedReason(commit.namespace, key, this.#checkout)) continue;
        if (this.#net?.skipsWrite(commit.namespace, key, change.cursor)) {
          continue;
        }
        const refs = byNamespace.get(commit.namespace) ?? [];
        refs.push(put.content.blob);
        byNamespace.set(commit.namespace, refs);
      }
    }
    if (byNamespace.size === 0) return;
    await withSpan("swamp.datastore.v3.readmodel.prefetch", {}, async () => {
      for (const [namespace, refs] of byNamespace) {
        await this.#chunkStore.prefetch(namespaceOf(namespace), refs, signal);
      }
    });
  }

  /**
   * state transactions are held in one batch that commits after the page's
   * barrier; on failure earlier commits are kept, and if the barrier fails too
   * the page rolls back and the apply failure is still thrown
   */
  async #applyPage(
    page: readonly CommitChange[],
    advance: boolean,
    signal: AbortSignal,
  ): Promise<number> {
    if (page.length === 0) return 0;
    this.#paths.forgetListings();
    const batch = this.#writeBatch();
    this.#state.beginBatch();
    this.#catalog.beginBatch();
    // Set only once the batch is open, so the finally below always clears it.
    const settled = Promise.withResolvers<void>();
    this.#pageInFlight = settled.promise;
    const changes = new Map<string, Set<string>>();
    this.#pageChanges = changes;
    const met: Commit[] = [];
    const tellOwnWorkApplied = () => {
      if (this.#ownWorkApplied === undefined) return;
      for (const commit of met) this.#ownWorkApplied(commit);
    };
    try {
      let applied = 0;
      try {
        await this.#prefetchChunks(page, signal);
        for (const change of page) {
          signal.throwIfAborted();
          if (await this.#apply(change, advance, signal, batch)) applied++;
          met.push(change.commit);
        }
      } catch (error) {
        try {
          await batch.barrier();
          this.#catalog.commitBatch();
          this.#state.commitBatch();
          tellOwnWorkApplied();
          // The commits before the failure are kept, with their files.
          this.#pageChanges = undefined;
          await this.#tellRecordsChanged(changes);
        } catch {
          // The page rolls back below; the apply failure is the one to report.
        }
        throw error;
      }
      await this.#time("barrier", () => batch.barrier());
      // the page's catalog actions in one transaction, after its files and
      // before its state: a crash between them leaves the catalog ahead, and
      // the page is applied again
      this.#timeSync("catalog", () => this.#catalog.commitBatch());
      this.#state.commitBatch();
      tellOwnWorkApplied();
      await this.#releaseFetched(signal);
      if (this.#stats !== undefined) {
        this.#stats.pages++;
        this.#stats.commits += applied;
      }
      this.#pageChanges = undefined;
      await this.#tellRecordsChanged(changes);
      return applied;
    } finally {
      this.#pageChanges = undefined;
      batch.discard();
      this.#catalog.rollbackBatch();
      this.#state.rollbackBatch();
      this.#pageInFlight = undefined;
      settled.resolve();
    }
  }

  async #releaseFetched(signal: AbortSignal): Promise<void> {
    try {
      await this.#chunkStore.releaseFetched(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      logger
        .debug`Removing chunks fetched for files already written failed: ${error}`;
    }
  }

  async #noteRewriting(key: string, path: string): Promise<void> {
    const rewritten = this.#rewritten;
    if (rewritten === undefined || rewritten.has(key)) return;
    rewritten.set(key, await fileDigest(path));
  }

  #notePageChange(namespace: string, key: string): void {
    const changes = this.#pageChanges;
    if (changes === undefined || this.#recordsChanged === undefined) return;
    let keys = changes.get(namespace);
    if (keys === undefined) changes.set(namespace, keys = new Set());
    keys.add(key);
  }

  async #tellRecordsChanged(
    changes: ReadonlyMap<string, ReadonlySet<string>>,
  ): Promise<void> {
    const tell = this.#recordsChanged;
    if (tell === undefined) return;
    for (const [namespace, keys] of changes) {
      try {
        await tell(namespace, [...keys]);
      } catch (error) {
        logger
          .warn`Telling the checkout which records of namespace ${namespace} a catch-up changed failed: ${error}`;
      }
    }
  }

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
    if (!this.#follower && commit.seq !== appliedSeq + 1) {
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
      const touchedFolded = new FoldedKeys();
      const unreadable = new Map<string, StoredUnreadableRecord>();
      const isConfig = commit.partition.kind === "config";
      const recordsBases = isConfig && this.#writerInstance !== undefined &&
        commit.writer.instance !== this.#writerInstance;
      const ownWork = !this.#recovering &&
        this.#holdsOwnWork?.(commit) === true;
      for (const keyChange of finalKeyStates(commit)) {
        signal.throwIfAborted();
        const key = keyChange.key.toString();
        // only the first change of a record's bytes in a catch-up replaces what
        // the checkout held; a commit leaving the file's bytes as they are (the
        // checkout's own, replayed) changes nothing
        const touchedId = JSON.stringify([namespace, partition, key]);
        const rewritten = isConfig &&
            this.#catchUpTouched?.has(touchedId) !== true
          ? new Map<string, string | undefined>()
          : undefined;
        records.set(key, appliedRecord(keyChange.put, commit.principal));
        this.#rewritten = rewritten;
        let file: FileOwnership | undefined;
        try {
          file = await this.#materialise(
            commit,
            change.cursor,
            keyChange,
            signal,
            batch,
            touched,
            touchedFolded,
            unreadable,
            ownWork,
          );
        } finally {
          this.#rewritten = undefined;
        }
        if (file !== undefined) files.set(key, file);
        if (rewritten?.has(key) === true) {
          const before = rewritten.get(key);
          if (before !== keyChange.put?.sha256) {
            this.#catchUpTouched?.add(touchedId);
            // A record the checkout held no file for has no version a
            // user's edit could have started from.
            if (recordsBases && before !== undefined) {
              this.#state.recordConfigBase(namespace, partition, key, before);
            }
          }
        }
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
   * the file follows the change feed, not apply order: a put writes only when
   * newer in the feed than the put the file shows; a tombstone removes it only
   * while it shows the tombstoning partition's put
   */
  async #materialise(
    commit: Commit,
    position: number,
    change: KeyChange,
    signal: AbortSignal,
    batch: DurableWriteBatch,
    touched: Set<string>,
    touchedFolded: FoldedKeys,
    unreadable: Map<string, StoredUnreadableRecord>,
    ownWork: boolean,
  ): Promise<FileOwnership | undefined> {
    const key = change.key.toString();
    const from = `commit ${commit.seq} of ${commit.partition.toString()}`;
    const target = await this.#time(
      "target",
      () =>
        this.#targetOf(commit.namespace, change.key, change.put !== null, from),
    );
    if (target === undefined) return undefined;
    const path = target.path;

    const owner = commit.partition.toString();
    const prior = this.#state.fileOwnership(commit.namespace, key);
    const decision = decideFile(prior, owner, position, change.put !== null);
    if (decision.kind === "keep") return undefined;
    touched.add(key);
    touchedFolded.add(key);
    const source = { partition: owner, seq: commit.seq };
    // a key with no file of its own can still reach another key's file where
    // the filesystem folds spellings (VPC/1/raw to vpc/1/raw), which its
    // tombstone must not remove nor its put overwrite
    const existing = target.existing;
    if (
      prior?.present !== true && existing !== undefined &&
      !this.#foldsNothing(commit.namespace) &&
      await this.#time(
        "alias",
        () =>
          this.#reachesAnotherKeysFile(
            commit.namespace,
            key,
            existing,
            touchedFolded,
          ),
      )
    ) {
      logger
        .warn`Not materialising ${key} from ${from}: its path reaches another key's file on a filesystem that folds case or Unicode normalisation`;
      this.#paths.takeAbsent(path);
      this.#paths.takeExisting(path);
      this.#stats?.bump("aliased_skipped");
      return change.put === null && decision.kind === "remove"
        ? decision.next
        : undefined;
    }
    // the file holds this commit's change or a newer one this process's open
    // unit made, which its own commit reads
    if (ownWork) {
      this.#paths.takeAbsent(path);
      this.#paths.takeExisting(path);
      this.#stats?.bump("own_work_kept");
      return decision.next;
    }
    if (decision.kind === "remove" || change.put === null) {
      // nothing of the key is on disk in a net replay
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
    // a later change of the key in a net replay replaces this content before
    // anything reads it: its chunks are never fetched, so no unreadable record
    // is made
    if (
      blob?.legacyKey === undefined &&
      this.#net?.skipsWrite(commit.namespace, key, position) === true
    ) {
      this.#paths.takeAbsent(path);
      this.#paths.takeExisting(path);
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
   * logged once per reserved namespace, and only at debug level for a key the
   * checkout keeps local, which is expected on every commit of another checkout
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

  /** a key left alone gets no file ownership and stays in the records index */
  async #target(
    namespace: string,
    recordKey: RecordKey,
    isPut: boolean,
    source: string,
  ): Promise<string | undefined> {
    return (await this.#targetOf(namespace, recordKey, isPut, source))?.path;
  }

  async #targetOf(
    namespace: string,
    recordKey: RecordKey,
    isPut: boolean,
    source: string,
  ): Promise<{ path: string; existing?: string } | undefined> {
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
    // Every segment, the file's own included, exists when none is missing.
    let resolved: string;
    const existing = missingFrom === undefined;
    if (existing) {
      resolved = await this.#paths.resolve(path);
      if (isPut) {
        this.#paths.noteAbsent(path, []);
        this.#paths.noteExisting(path);
      }
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
    return existing ? { path, existing: resolved } : { path };
  }

  /**
   * on a case- or normalisation-insensitive filesystem VPC/1/raw reaches
   * vpc/1/raw: the file is another key's when a different key folding to its
   * spelling, present or decided in this commit, reaches the same file
   */
  async #reachesAnotherKeysFile(
    namespace: string,
    key: string,
    existing: string,
    decided: FoldedKeys,
  ): Promise<boolean> {
    const root = this.#cacheRoot(namespace);
    const folding = await this.#foldingOf(root);
    if (folding === "off") return false;
    const onDisk = folding === "canonical"
      ? relative(await this.#paths.resolveDirectory(root), existing)
        .split(SEPARATOR).join("/")
      : await this.#listedSpelling(root, key);
    // No listed name matches a segment as the filesystem might fold it.
    if (onDisk === undefined) return true;
    const folded = foldSpelling(onDisk);
    const others = decided.others(folded, key);
    for (const other of this.#state.presentKeysFoldedTo(namespace, folded)) {
      if (other !== key) others.push(other);
    }
    if (others.length === 0) return false;
    return await this.#reachesSameFile(root, existing, others);
  }

  // the fold only finds candidates; the filesystem decides, so a root that
  // keeps case apart reports no false alias
  async #reachesSameFile(
    root: string,
    existing: string,
    keys: readonly string[],
  ): Promise<boolean> {
    let file: Deno.FileInfo;
    try {
      file = await Deno.stat(existing);
    } catch (error) {
      // gone since the guard saw it: nothing left to alias
      if (error instanceof Deno.errors.NotFound) return false;
      return true;
    }
    // no inode on this platform: trust the fold
    if (file.ino === null) return true;
    for (const other of keys) {
      try {
        const info = await Deno.stat(join(root, ...other.split("/")));
        if (info.ino === file.ino && info.dev === file.dev) return true;
      } catch (error) {
        // undecidable counts as an alias: skip the write, never stop the catch-up
        if (!(error instanceof Deno.errors.NotFound)) return true;
      }
    }
    return false;
  }

  async #listedSpelling(
    root: string,
    key: string,
  ): Promise<string | undefined> {
    const names: string[] = [];
    let dir = root;
    for (const segment of key.split("/")) {
      const name = await this.#paths.listedName(dir, segment, this.#readDir);
      if (name === undefined) return undefined;
      names.push(name);
      dir = join(dir, segment);
    }
    return names.join("/");
  }

  #foldsNothing(namespace: string): boolean {
    return (this.#forcedFolding ??
      this.#rootFolding.get(this.#cacheRoot(namespace))) === "off";
  }

  /**
   * the probe of the state directory runs once, inside an exclusive section,
   * for a root on its device; a root on another device is listed
   */
  async #foldingOf(root: string): Promise<SpellingFolding> {
    if (this.#forcedFolding !== undefined) return this.#forcedFolding;
    let folding = this.#rootFolding.get(root);
    if (folding === undefined) {
      this.#probedFolding ??= await probeSpellingFolding(this.#stateDir);
      folding = await spellingFoldingOf(
        root,
        this.#stateDir,
        this.#probedFolding,
      );
      this.#rootFolding.set(root, folding);
    }
    return folding;
  }

  /**
   * each step can run again and the state moves last, so a crash anywhere
   * repeats the load; touched keys and names let a retry against a newer base
   * reconcile what an earlier attempt wrote
   */
  #loadBase(signal: AbortSignal, net = false): Promise<void> {
    return withSpan(
      "swamp.datastore.v3.readmodel.load_base",
      {},
      () => this.#loadBaseNow(signal, net),
    );
  }

  async #loadBaseNow(signal: AbortSignal, net: boolean): Promise<void> {
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

    if (net) this.#net = await this.#planBaseNet(point, signal);
    const removals = this.#state.loadRemovals();
    const writes = this.#state.loadWrites();
    this.#state.touchKeys([...removals, ...writes]);
    this.#stats?.bump("base_removals", removals.length);
    this.#stats?.bump("base_writes", writes.length);
    // unsynced like a page's files: keys are listed with the boot and checked
    // on the first open in a later boot; syncing each file made a load slower
    // than replaying the commits it folds
    const batch = this.#writeBatch();
    let unreadable: StoredUnreadableRecord[];
    const filesStarted = performance.now();
    let skipped: Set<string>;
    try {
      ({ unreadable, skipped } = await this.#loadFiles(
        removals,
        writes,
        batch,
        signal,
      ));
      await batch.barrier();
      await this.#releaseFetched(signal);
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
      batch.syncs || this.#boot === undefined ? undefined : {
        keys: [
          ...removals,
          ...writes.filter((key) =>
            !skipped.has(`${key.namespace}\0${key.record_key}`)
          ),
        ],
        boot: this.#boot,
      },
    );
    this.#stats?.bump(
      "base_finish_ms",
      Math.round(performance.now() - finishStarted),
    );
    for (const record of unreadable) warnUnreadable(record);
  }

  /**
   * records whose content could not be read have their files removed and never
   * fail the load, since no commit is left to retry them from; writes the net
   * plan skips are left off disk
   */
  async #loadFiles(
    removals: readonly LoadKey[],
    writes: readonly LoadKey[],
    batch: DurableWriteBatch,
    signal: AbortSignal,
  ): Promise<{ unreadable: StoredUnreadableRecord[]; skipped: Set<string> }> {
    const unreadable: StoredUnreadableRecord[] = [];
    const skipped = new Set<string>();
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
    await this.#prefetchBaseChunks(writes, signal);
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
      // a later commit of the tail replaces or removes this content before
      // anything reads it: its chunks are never fetched
      if (
        owner !== undefined &&
        this.#net?.skipsWrite(namespace, record_key, owner.mark) === true
      ) {
        this.#paths.takeAbsent(path);
        this.#paths.takeExisting(path);
        skipped.add(`${namespace}\0${record_key}`);
        this.#stats?.bump("base_writes_skipped");
        if ("blob" in content) this.#stats?.bump("base_chunked_writes_skipped");
        continue;
      }
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
    return { unreadable, skipped };
  }

  /**
   * has batch sync the deepest directory still standing, since syncing the
   * file's own directory would do nothing once cleanup removed it; the file is
   * guarded first
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
    await this.#noteRewriting(key, path);
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
    this.#notePageChange(namespace, key);
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
   * a file already holding the content is left as is; if chunks are unreadable
   * and the guard did not read the file, it reads it then: a file holding the
   * content may be the only copy of a lost chunk
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
    await this.#noteRewriting(key, path);
    const intended = "blob" in content ? content.blob : undefined;
    const keep = async () => {
      // The file stays as it is: nothing under the checkout was replaced.
      this.#rewritten?.delete(key);
      if (!batch.syncs) return;
      await this.#syncFile(path);
      batch.touch(dirname(path));
    };
    // a replay runs over files already there: one already holding its inline
    // bytes, read and compared, keeps its access; chunked content is compared
    // by the guard below
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
    const existed = this.#paths.takeExisting(path);
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
    this.#notePageChange(namespace, key);
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
    // A new name in some directory, under whichever spelling it was listed.
    if (!existed || (absentDirectories?.length ?? 0) > 0) {
      this.#paths.forgetListings();
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
   * only a regular file over MAX_INLINE_BYTES not yet written or guarded is
   * read; parts the storage lacks are stored again from it; a refused put moves
   * the file aside and the overwrite goes on
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
    // not read: unguarded, so a later removal or a failed write still reads it
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
   * a file this read model wrote whose stat still shows it as written has its
   * blob's parts without being read, unless forced, in a replay, or intended is
   * that blob: only reading decides it holds the content
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
   * records only when the path still shows the temp file's inode, unchanged, so
   * a file another process put there is never taken for this one; on Windows
   * nothing is recorded and the guard reads the file
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
   * a copy made by hard link shares its inode with a checkout file, so an
   * in-place edit would change the copy too; across devices it is copied,
   * synced, then removed
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
   * leaves the file in place and puts a copy in at-risk/; a hard link costs no
   * space, else it is copied within the cap; a copy that cannot be made is only
   * logged and the next guard of the file tries again
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
   * by size and then hash: a hard-link copy shares its inode with a checkout
   * file, so an in-place edit changes the copy while the old hash still names
   * it; size alone proves nothing
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
   * a copy whose hash does not match its name (a hard link edited in place) is
   * deleted with a warning; after an unauthorised refusal no copy is tried
   * again in this process; never fails the section
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
   * checks the storage before reading the copy, and the copy's hash against its
   * name before storing, resolving false and storing nothing on a mismatch;
   * rejects with NotFound when the copy is gone
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
   * records copies a crash left without their row (moved aside, row never
   * committed); removes stale temp files from a crash mid-copy that this
   * process is not writing
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
   * on a storage that reads chunk sizes a record is retried only once its chunk
   * appeared or changed; otherwise once per RETRY_INTERVAL_MS from its last
   * try; never fails the catch-up
   */
  async #retryUnreadable(signal: AbortSignal): Promise<void> {
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
        // a key the checkout never projects has no file of the read model's to
        // retry
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
   * so the next retry waits for the chunk failing now, not one that came back;
   * a failure naming no chunk, or a chunk that cannot be found, keeps seen
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

const warnedUnreadable = new Set<string>();

let warnedAtRisk = false;

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

function isCrossDevice(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as { code?: unknown }).code === "EXDEV" ||
    /cross-device|os error 18\b/i.test(error.message) ||
    // ERROR_NOT_SAME_DEVICE; on POSIX 17 is EEXIST.
    (Deno.build.os === "windows" && /os error 17\b/.test(error.message));
}

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
 * a put refused for want of rights: PermissionDenied, or an error or cause
 * carrying HTTP 401/403 or an access-denied code; a message alone counts only
 * when it names both status and refusal
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

function uniqueParts(parts: readonly ContentPart[]): ContentPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    if (seen.has(part.sha256)) return false;
    seen.add(part.sha256);
    return true;
  });
}

function partsOf(ref: BlobRef): readonly ContentPart[] {
  return partsWithOffsets(ref);
}

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

function partsWithOffsets(ref: BlobRef): ContentPart[] {
  const parts = ref.parts ?? [{ sha256: ref.sha256, size: ref.size }];
  let offset = 0;
  return parts.map(({ sha256, size }) => {
    const part = { sha256, size, offset };
    offset += size;
    return part;
  });
}

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

const AT_RISK_TEMP = /^\.[0-9a-f-]{36}\.tmp$/;

const copiesInFlight = new Set<string>();

function appliedRecord(
  put: PutOp | null,
  principal: string | undefined,
): AppliedRecord | null {
  if (put === null) return null;
  // Only a commit with no principal is serve's own (or an HA peer's); an
  // empty one is recorded as unknown, never as serve's.
  const writer = principal === undefined
    ? ""
    : principal === ""
    ? undefined
    : principal;
  return withAccess(
    "blob" in put.content
      ? {
        sha256: put.sha256,
        blob: put.content.blob,
        ...(writer === undefined ? {} : { writer }),
      }
      : { sha256: put.sha256, ...(writer === undefined ? {} : { writer }) },
    put.access,
  );
}

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

interface PathConflict {
  readonly kind: "under-file" | "directory";
  readonly reason: string;
}

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
 * stat first, as the guard reads a file: a link, a directory or a file
 * hard-linked from elsewhere never holds the bytes
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
 * always true on Windows, which keeps no modes; false when it cannot be
 * stat'ed, so the write that follows finds out why
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
 * a file the state cannot describe, or that cannot be read, never matches: the
 * replay that follows rewrites it, where an error here would refuse every
 * catch-up
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

/**
 * anything else there (a directory, link, FIFO or unreadable file) is left to
 * the guard the write runs next
 */
async function fileDigest(path: string): Promise<string | undefined> {
  try {
    if (!(await Deno.lstat(path)).isFile) return undefined;
    const hash = createHash("sha256");
    // The readable closes the file when it ends or fails.
    const handle = await Deno.open(path, { read: true });
    for await (const piece of handle.readable) hash.update(piece);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + SEPARATOR);
}

interface ListedNames {
  readonly exact: ReadonlySet<string>;
  readonly folded: ReadonlyMap<string, string>;
}

class FoldedKeys {
  readonly #keys = new Map<string, Set<string>>();

  add(key: string): void {
    const folded = foldSpelling(key);
    const keys = this.#keys.get(folded) ?? new Set<string>();
    keys.add(key);
    this.#keys.set(folded, keys);
  }

  others(folded: string, key: string): string[] {
    const others: string[] = [];
    for (const other of this.#keys.get(folded) ?? []) {
      if (other !== key) others.push(other);
    }
    return others;
  }
}

/**
 * directories are remembered so a page of many files under one resolves and
 * stats it once; cleared on any removal and at the start of every section, as
 * another process may change the tree
 */
class PathCache {
  readonly #directories = new Set<string>();
  readonly #resolved = new Map<string, string>();
  readonly #absent = new Map<string, readonly string[]>();
  readonly #existing = new Set<string>();
  /** kept for one page at most, and forgotten whenever a write adds a name */
  readonly #listings = new Map<string, ListedNames | "unchecked">();
  /** warned about once each, across sections */
  readonly #unlistable = new Set<string>();

  isDirectory(path: string): boolean {
    return this.#directories.has(path);
  }

  markDirectory(path: string): void {
    this.#directories.add(path);
  }

  markCreated(dir: string): void {
    this.#directories.add(dir);
    const parent = this.#resolved.get(dirname(dir));
    if (parent !== undefined) {
      this.#resolved.set(dir, join(parent, basename(dir)));
    }
  }

  noteAbsent(path: string, dirs: readonly string[]): void {
    this.#absent.set(path, dirs);
  }

  takeAbsent(path: string): readonly string[] | undefined {
    const dirs = this.#absent.get(path);
    this.#absent.delete(path);
    return dirs;
  }

  /**
   * a path that does not exist resolves to its directory's real path and its
   * own name, so only its directory is remembered; an existing path may be a
   * symlink, and its real name may differ from the key's
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

  async resolveDirectory(dir: string): Promise<string> {
    let real = this.#resolved.get(dir);
    if (real === undefined) {
      real = await resolveRealPath(dir);
      this.#resolved.set(dir, real);
    }
    return real;
  }

  noteExisting(path: string): void {
    this.#existing.add(path);
  }

  takeExisting(path: string): boolean {
    return this.#existing.delete(path);
  }

  async listedName(
    dir: string,
    segment: string,
    readDir: (dir: string) => AsyncIterable<Deno.DirEntry>,
  ): Promise<string | undefined> {
    let listed = this.#listings.get(dir);
    if (listed === undefined) {
      listed = await this.#list(dir, readDir);
      this.#listings.set(dir, listed);
    }
    if (listed === "unchecked" || listed.exact.has(segment)) return segment;
    return listed.folded.get(foldSpelling(segment));
  }

  async #list(
    dir: string,
    readDir: (dir: string) => AsyncIterable<Deno.DirEntry>,
  ): Promise<ListedNames | "unchecked"> {
    const exact = new Set<string>();
    const folded = new Map<string, string>();
    try {
      for await (const entry of readDir(dir)) {
        exact.add(entry.name);
        folded.set(foldSpelling(entry.name), entry.name);
      }
    } catch (error) {
      // a gone directory holds no alias; an unlistable one cannot be checked
      if (error instanceof Deno.errors.NotFound) return "unchecked";
      if (!(error instanceof Deno.errors.PermissionDenied)) throw error;
      if (!this.#unlistable.has(dir)) {
        this.#unlistable.add(dir);
        logger
          .warn`The directory ${dir} cannot be listed, so the spellings of the keys under it are not checked against other keys' files: ${error}`;
      }
      return "unchecked";
    }
    return { exact, folded };
  }

  forgetListings(): void {
    this.#listings.clear();
  }

  clear(): void {
    this.#directories.clear();
    this.#resolved.clear();
    this.#absent.clear();
    this.#existing.clear();
    this.#listings.clear();
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
