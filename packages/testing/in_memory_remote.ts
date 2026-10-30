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
 * An in-memory remote datastore for testing sync behaviour across several
 * simulated machines.
 *
 * Its default behaviour reproduces what `@swamp/s3-datastore` and
 * `@swamp/gcs-datastore` 2026.10.06.1 through 2026.10.20.2 do, quirks
 * included, so a test that passes against this fake cannot lose data that
 * production would keep, except in two places where the default models the
 * fix of swamp-club#3860 instead: a push clears only the marks it handled,
 * and skips an entry that vanished while it walked. Those two releases'
 * behaviours are {@link EXTENSION_2026_10_20_SEMANTICS}. Each pinned
 * behaviour was checked against swamp-extensions @ 7c0b1eacf, and the
 * clearing and vanished-entry ones again @ ad6b66233; `S3SYNC` below is
 * `datastore/s3/extensions/datastores/_lib/s3_cache_sync.ts` @ 7c0b1eacf
 * unless another commit is named, and the GCS equivalent behaves the same.
 *
 * - A path mark records a cache-relative path. A bare mark, an empty path or
 *   a path that climbs out of the cache with `..` sets the bulk flag. An
 *   absolute path is nested under the cache, as `join(cachePath, relPath)`
 *   does, so its real file is never pushed; once bulk is set, later
 *   path marks are not recorded (S3SYNC:1757-1817). Past `dirtyPathsCap`
 *   paths the set overflows into bulk (S3SYNC:1799-1806). The extensions
 *   also mark a clean sidecar dirty again for a path it still lists
 *   (S3SYNC:1765-1772, 1794-1798). Only a pull under
 *   {@link LEGACY_EXTENSION_SEMANTICS} leaves a sidecar clean with paths
 *   listed, and those releases keep it clean, so that is not modelled.
 * - Dirty state lives in a per-cache "sidecar" that survives reconnects, like
 *   `.datastore-sync-state.json`. A push with a clean sidecar returns 0
 *   without walking, so a write that was never marked is never pushed
 *   (S3SYNC:1945-1954). A cache with no sidecar yet pushes with a full walk
 *   that deletes nothing.
 * - A scoped push uploads each marked file that differs, walks each marked
 *   directory deleting remote entries under it that are gone locally, and
 *   deletes the remote key (and `key/`) of a marked path that is absent
 *   (S3SYNC:3134-3205). A mark of `.` becomes the cache root: its walk
 *   uploads everything but deletes nothing, because the delete prefix is
 *   `/` (S3SYNC:3168-3171). A bulk push uploads everything and deletes nothing
 *   unless the set overflowed (S3SYNC:3206-3276).
 * - Uploads go through `pushFile`, which sets the bulk flag
 *   (S3SYNC:2911). A push that fails after its uploads therefore leaves bulk
 *   set, and the next push loses the recorded deletes.
 * - Dirty state is cleared only when a push succeeds (S3SYNC:3398-3427). A
 *   pull keeps it, so a write whose push failed is sent by the next push
 *   (S3SYNC:1843-1877, 2792-2796, 2826-2851). Each mark gives its path a
 *   new generation, even when the path is already marked; a push or
 *   `preparePush` snapshots the marks when it starts and walks only those,
 *   and success removes only the snapshot's paths whose generation is
 *   unchanged, and clears the bulk flag only when no bulk mark (nor a path
 *   mark the flag absorbed) came after the snapshot. The sidecar stays dirty
 *   while any mark remains. With `commitClearsLaterMarks`, as released, a
 *   push walks the live marks and success clears every mark.
 * - In the walk of a marked directory, an entry whose target cannot be
 *   stat'ed, such as a dangling symlink, is skipped. With
 *   `vanishedEntryDeletesDir`, as released, it makes the push delete every
 *   committed key under the directory, and ends a full walk early
 *   (S3SYNC @ ad6b66233:3454, 3473-3492, 3528, 3532-3534).
 * - A pull downloads committed entries that are new or differ and
 *   overwrites local files even if they are dirty (S3SYNC:2616-2690). An
 *   unchanged remote takes the fast path and touches nothing
 *   (S3SYNC:1884-1896).
 * - A pull, push or `preparePush` that read the remote removes the local
 *   copy of each file a peer deleted since this cache last synced, before
 *   it downloads or walks (S3SYNC:2537-2543, 3103-3109, 3635-3641). A copy
 *   that is marked or changed since that sync is kept, and so is every copy
 *   when no committed key is in scope; directories the removal empties go
 *   too, up to the top-level one (S3SYNC:4197-4324). What the cache last
 *   synced is the whole remote after a pull (a subdir-scoped one included)
 *   or after a full push or commit, and a scoped push only adds its own
 *   changes to it (S3SYNC:2289-2344). A scoped push reconciles only the
 *   index shards its marks read (S3SYNC:1548-1610, 4174-4182,
 *   4436-4468). The fast paths and `commitPush` remove nothing. A pull
 *   leaves removals out of its count (S3SYNC:2875), though the
 *   `pullChanged` contract asks for them.
 * - `preparePush` uploads and deletes content at once but publishes nothing
 *   other machines can pull, and keeps dirty state; `commitPush` publishes
 *   the index and clears the marks the prepare snapshotted, or, with
 *   `commitClearsLaterMarks`, every mark including those made in between
 *   (S3SYNC:3517-4089). After an unscoped prepare, commit checks
 *   completeness against the index it read at prepare plus its own changes,
 *   so a peer's commit in between is skipped by the next pull
 *   (S3SYNC:4015-4026, 4333-4361).
 * - Internal cache files are never pushed or pulled (S3SYNC:116-128). `.log`
 *   files are synced.
 * - A service takes its namespace from the first `pullChanged`, `pushChanged`
 *   or `preparePush` it runs, before it reaches the remote, so one that fails
 *   still binds it. A later one of those with a different namespace rejects
 *   (S3SYNC:668-686). A service is therefore one repository's, for its whole
 *   life. Unlike the extensions, which tell an empty namespace from an unset
 *   one, the fake treats both as no namespace, as the `fetchContent` contract
 *   does.
 *
 * Released behaviour is available through {@link InMemoryRemoteSemantics}:
 * {@link EXTENSION_2026_10_20_SEMANTICS} is the default with released
 * clearing and vanished-entry handling, {@link EXTENSION_2026_10_01_SEMANTICS}
 * also removes nothing, and
 * {@link LEGACY_EXTENSION_SEMANTICS} (2026.09.24.1 and earlier) also makes
 * an unscoped pull of a moved remote mark the sidecar clean, dropping a
 * pending push, and a later mark of a path it still lists leave it clean.
 * The same type switches behaviours that later phases are expected to
 * change.
 *
 * Experimental: the defaults track the current extension releases and will
 * change with them and during the datastore rework.
 *
 * `fetchContent` returns the committed bytes of one key and touches neither
 * the cache nor the sidecar. It takes the key as given, so a cache-relative
 * path that starts with a namespace reads that key, and it rejects a path
 * that is absolute or has a `..` segment.
 *
 * `repairUnpushedFiles` compares the cache with the committed index, the
 * objects stored and what the cache last synced, bytes for bytes. Every pull
 * and committed push records a key it drops from the last-synced index while
 * the cache keeps a file at that path, and the repair reports such a file as
 * `peerDeleted` instead of uploading it. A real run
 * stores and commits the unpushed files at once, touching neither the
 * sidecar nor the commit sequence it last saw.
 *
 * No method looks at `options.signal`, so a test of cancellation needs a
 * service of its own.
 *
 * The control plane is modelled only when `controlPlane` is set: records
 * live under `_control/<key>`, or `<namespace>/_control/<key>` once the
 * service has bound a namespace, and a service that has not pulled or pushed
 * binds no namespace on its first control-plane call, as the S3 and GCS
 * extensions do (swamp-club#3189). Its writes are recorded as `controlPlane`
 * ops; its reads are not, and are listed by `controlPlaneReads` instead.
 * `datastoreControlPlaneStore` stands in for a provider's datastore-wide
 * store. A control-plane `get` given an already aborted signal rejects with
 * its reason; nothing else in the control plane can be in flight.
 *
 * `storage/1` chunk storage is modelled only when `storage` is set:
 * `storage()` returns handles onto one set of chunks per remote, kept
 * apart from the files and the control plane. It is not recorded as ops,
 * and neither `offline` nor `failNext` reaches it.
 *
 * Not modelled: namespace prefixes (a namespaced path is a plain key and a
 * push is never limited to one), lazy hydration (`hydrateFile`),
 * `previewPush`, model-scoped pulls through `context`, and Windows
 * drive-letter joins. Nor is the window between `preparePush` and
 * `commitPush` in which the extensions have already deleted objects but not
 * yet the index entries, so a peer pulling then drops those entries without
 * downloading them; here a peer still sees the old content until commit.
 * The remote index is always read whole and fresh, so the extensions'
 * TTL-cached and fallback index reads, which remove nothing, and an index
 * entry whose object is missing are not modelled either. The fake
 * compares file bytes, whereas the backends compare size and mtime before
 * hashing (S3SYNC:4373-4415) and can skip a same-size, same-mtime rewrite;
 * deciding whether a copy is unchanged, they compare size and sha256, or
 * the recorded mtime for an entry without a hash.
 *
 * @module
 */

import { dirname, join, normalize } from "@std/path";
import type {
  ControlPlaneStore,
  DatastoreStorage,
  DatastoreSyncOptions,
  DatastoreSyncService,
  RepairUnpushedFilesOptions,
  ReplicaPathStore,
  StoredChunk,
  SyncCapabilities,
  UnpushedFilesSummary,
  V3ReplicaTarget,
  WritableDatastoreControlPlaneStore,
} from "./datastore_types.ts";
import { replicaPathFenceProblem } from "./replica_path_fence.ts";

/**
 * The behaviours that differ between extension releases, or that a later
 * datastore phase is expected to change.
 */
export interface InMemoryRemoteSemantics {
  /**
   * A pull deletes local files the remote dropped since the last pull,
   * unless they are marked, and counts them in its result. No released
   * extension does this. When set, it decides what a pull removes and
   * {@link removesPeerDeletes} applies to pushes only.
   */
  pullDeletes: boolean;
  /** A bulk mark makes the next push a full walk that deletes nothing. */
  bulkDisablesDeletes: boolean;
  /**
   * An unscoped pull of a moved remote marks the cache clean, so a pending
   * push is dropped. Marks stay listed, and marking a listed path again
   * does not mark the cache dirty.
   */
  pullClearsPendingPush: boolean;
  /**
   * A pull, push or `preparePush` that read the remote first removes the
   * local copy of each file a peer deleted since this cache last synced,
   * when that copy is unchanged and unmarked. A pull does not count the
   * removals in its result. When {@link pullDeletes} is also set, it
   * decides what a pull removes instead.
   */
  removesPeerDeletes: boolean;
  /**
   * A successful push or `commitPush` clears every mark, including marks
   * made after the push began walking or after `preparePush`, and marking
   * a path that is already marked leaves no trace. What every released
   * extension does (swamp-club#3860). When unset, each mark gives its path
   * a new generation, a push or `preparePush` snapshots the marks it walks,
   * and clearing removes only the snapshot's paths whose generation is
   * unchanged, and the bulk flag only when no bulk mark came after the
   * snapshot; the sidecar stays dirty while any mark remains.
   */
  commitClearsLaterMarks: boolean;
  /**
   * In the walk of a marked directory, an entry that cannot be stat'ed,
   * such as a dangling symlink, makes the push treat the whole directory
   * as absent: it deletes every committed key under it, uploading only the
   * files walked before that entry. A full walk stops at such an entry, so
   * after an overflow every committed key not walked is deleted. What
   * every released extension does (swamp-club#3860). When unset, such an
   * entry is skipped. Names are walked in sorted order, where the
   * extensions follow directory order.
   */
  vanishedEntryDeletesDir: boolean;
}

/**
 * The default: what `@swamp/s3-datastore` and `@swamp/gcs-datastore` do
 * from 2026.10.24.2, where a push clears only the marks it handled and skips
 * an entry that vanished mid-walk (swamp-club#3860). Otherwise as
 * {@link EXTENSION_2026_10_20_SEMANTICS}.
 */
export const EXTENSION_SEMANTICS: Readonly<InMemoryRemoteSemantics> = Object
  .freeze({
    pullDeletes: false,
    bulkDisablesDeletes: true,
    pullClearsPendingPush: false,
    removesPeerDeletes: true,
    commitClearsLaterMarks: false,
    vanishedEntryDeletesDir: false,
  });

/**
 * What `@swamp/s3-datastore` and `@swamp/gcs-datastore` do from
 * 2026.10.06.1 through 2026.10.20.2 (checked at swamp-extensions
 * @ 7c0b1eacf and ad6b66233): a push or commit clears marks made after it
 * began, and an entry that vanishes mid-walk deletes its whole marked
 * directory remotely (swamp-club#3860).
 */
export const EXTENSION_2026_10_20_SEMANTICS: Readonly<
  InMemoryRemoteSemantics
> = Object.freeze({
  pullDeletes: false,
  bulkDisablesDeletes: true,
  pullClearsPendingPush: false,
  removesPeerDeletes: true,
  commitClearsLaterMarks: true,
  vanishedEntryDeletesDir: true,
});

/**
 * What the extensions do in 2026.10.01.1: a pull keeps a pending push
 * (swamp-club#2888) but never removes local files.
 */
export const EXTENSION_2026_10_01_SEMANTICS: Readonly<
  InMemoryRemoteSemantics
> = Object.freeze({
  pullDeletes: false,
  bulkDisablesDeletes: true,
  pullClearsPendingPush: false,
  removesPeerDeletes: false,
  commitClearsLaterMarks: true,
  vanishedEntryDeletesDir: true,
});

/**
 * What the extensions do in 2026.09.24.1 and earlier (swamp-extensions
 * @ 5368cb002): a pull of a moved remote drops a pending push, and never
 * removes local files.
 */
export const LEGACY_EXTENSION_SEMANTICS: Readonly<InMemoryRemoteSemantics> =
  Object.freeze({
    pullDeletes: false,
    bulkDisablesDeletes: true,
    pullClearsPendingPush: true,
    removesPeerDeletes: false,
    commitClearsLaterMarks: true,
    vanishedEntryDeletesDir: true,
  });

/** Options for {@link createInMemoryRemote}. */
export interface InMemoryRemoteOptions {
  /** Overrides for {@link EXTENSION_SEMANTICS}. */
  semantics?: Partial<InMemoryRemoteSemantics>;
  /** Marked paths kept before the set overflows into bulk. Default 2000. */
  dirtyPathsCap?: number;
  /** What every connected service advertises. Default `{ twoPhaseSync: true }`. */
  capabilities?: SyncCapabilities;
  /**
   * Gives every connected service a `controlPlaneStore()` and adds
   * `controlPlane: true` to its capabilities. Default false.
   */
  controlPlane?: boolean;
  /**
   * Gives the remote a `storage()` holding `storage/1` chunks, and a
   * `setChunkLastModified` to backdate one. Default false.
   */
  storage?: boolean;
  /**
   * Gives the remote a `replicaTarget()` returning this target as given,
   * unchecked, so a test can hand swamp a bad one. The remote has no key
   * prefix, so a target that matches where it writes has prefix `""`.
   */
  replicaTarget?: V3ReplicaTarget;
  /**
   * Gives the remote a `replicaPaths()` over the objects under
   * `_litestream/`, and a `putReplicaObject` to write one there as
   * Litestream would. `removePath` deletes two objects per listing page,
   * so a fence with more exercises its paging. Default false.
   */
  replicaPaths?: boolean;
  /**
   * Makes the remote index a v1 monolith, which `repairUnpushedFiles`
   * rejects. Nothing else changes. Default false.
   */
  monolithIndex?: boolean;
  /**
   * Whether the remote can create an object only if its key is free, which
   * `repairUnpushedFiles` needs to upload. Default true.
   */
  conditionalCreate?: boolean;
}

/** A remote operation a failure can be injected into. */
export type InMemoryRemoteFailure =
  | "push"
  | "pull"
  | "prepare"
  | "commit"
  | "fetch"
  | "repair"
  | "controlPlane"
  | "replicaPaths";

/** Options for {@link InMemoryRemote.failNext}. */
export interface FailNextOptions {
  /**
   * Fail a push after its uploads land, as a mid-push network error would.
   * Other operations fail before doing anything either way.
   */
  afterUploads?: boolean;
  /** Only fail an operation from this instance. */
  instance?: string;
}

/** One recorded sync operation. */
export interface InMemoryRemoteOpRecord {
  /** The instance name given to `connect`. */
  instance: string;
  op:
    | "markDirty"
    | "clearDirty"
    | "push"
    | "pull"
    | "prepare"
    | "commit"
    | "fetch"
    | "repair"
    | "controlPlane";
  /** Paths marked, cleared, uploaded, downloaded or fetched, sorted. */
  paths: string[];
  /** Paths deleted remotely (push) or locally (pull), sorted. */
  deleted: string[];
  /**
   * Local copies a push or prepare removed because a peer deleted them,
   * sorted. Present only when there were some.
   */
  removed?: string[];
  /** Set on a bare `markDirty`. */
  bulk?: boolean;
}

/** One control-plane read, listed by {@link InMemoryRemote.controlPlaneReads}. */
export interface InMemoryControlPlaneRead {
  /** The instance name given to `connect`. */
  instance: string;
  /** The full remote key read, `_control/<key>` or `<namespace>/_control/<key>`. */
  key: string;
}

/** The manifest `preparePush` hands to `commitPush`. */
export interface InMemoryPushManifest {
  readonly uploads: ReadonlyMap<string, Uint8Array>;
  readonly deletes: readonly string[];
}

/** A sync service bound to one cache directory, with two-phase push. */
export interface InMemorySyncService extends DatastoreSyncService {
  preparePush(options?: DatastoreSyncOptions): Promise<InMemoryPushManifest>;
  commitPush(
    manifest: InMemoryPushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number>;
}

/** Options for {@link InMemoryRemote.connect}. */
export interface ConnectOptions {
  /** Name recorded in the op log. Default `instance-<n>`. */
  instance?: string;
  /**
   * Whether the service has `fetchContent`. Default true; false leaves the
   * method out, as an extension that does not implement it would.
   */
  fetchContent?: boolean;
  /**
   * Whether the service has `clearDirty`. Default true; false leaves the
   * method out, as the S3 and GCS extensions do until they implement it
   * (swamp-club#4091).
   */
  clearDirty?: boolean;
  /**
   * Whether the service has `repairUnpushedFiles`. Default true; false
   * leaves the method out, as an extension that predates it would.
   */
  repairUnpushedFiles?: boolean;
}

/** A remote datastore shared by any number of simulated machines. */
export interface InMemoryRemote {
  /** Binds a sync service to a cache directory, one per simulated machine. */
  connect(cacheDir: string, options?: ConnectOptions): InMemorySyncService;
  /** The committed content other machines can pull. */
  files(): ReadonlyMap<string, Uint8Array>;
  /**
   * Stores an object at `key` without indexing it, as an upload whose
   * index commit never ran leaves one. Other machines cannot pull it.
   */
  storeObject(key: string, bytes: Uint8Array): void;
  /** Fails the next matching operation with `error`. */
  failNext(
    op: InMemoryRemoteFailure,
    error?: Error,
    options?: FailNextOptions,
  ): void;
  /**
   * While offline, every push, pull, prepare, commit, fetch and
   * control-plane call throws.
   */
  offline(isOffline: boolean): void;
  /**
   * Writes a control-plane record straight into the remote, as another
   * machine or a later swamp would, without recording an op. The record is
   * datastore-wide unless `namespace` is given. Needs `controlPlane`.
   */
  seedControlPlane(
    key: string,
    data: Uint8Array,
    options?: { namespace?: string },
  ): void;
  /** Every control-plane record, keyed by its full remote key. */
  controlPlaneRecords(): ReadonlyMap<string, Uint8Array>;
  /** Every recorded operation, in order. */
  ops(): readonly InMemoryRemoteOpRecord[];
  /**
   * A provider's writable datastore-wide store: every key is
   * `_control/<key>` whatever namespace any service has bound, and it binds
   * nothing. Its reads are listed as instance `"datastore"` by
   * `controlPlaneReads`, its writes are recorded as `controlPlane` ops of
   * instance `"datastore"`, and `failNext` with that instance reaches it.
   * Present only with `controlPlane`, as a service's `controlPlaneStore` is.
   */
  datastoreControlPlaneStore?(): WritableDatastoreControlPlaneStore;
  /**
   * A provider's `storage/1` chunk storage. Every call returns a handle
   * onto the same chunks; `touch` is implemented. Present only with
   * `storage`.
   */
  storage?(): DatastoreStorage;
  /** A provider's replica target. Present only with `replicaTarget`. */
  replicaTarget?(): V3ReplicaTarget;
  /**
   * A provider's replica paths, over the objects under `_litestream/`.
   * Every call returns a handle onto the same objects; `failNext` with
   * `"replicaPaths"` fails its next call. Present only with
   * `replicaPaths`.
   */
  replicaPaths?(): ReplicaPathStore;
  /**
   * Writes an object at `key`, which must start with `_litestream/`, as
   * Litestream would. Present only with `replicaPaths`.
   */
  putReplicaObject?(key: string, bytes: Uint8Array): void;
  /** Deletes the replica object at `key`. Present only with `replicaPaths`. */
  deleteReplicaObject?(key: string): void;
  /**
   * Whether the remote holds an object at `key`, as a bucket would key it:
   * a committed file, a control-plane record at `_control/<key>` or
   * `<namespace>/_control/<key>`, a chunk at
   * `_blobs/<namespace>/sha256/<first two hex>/<sha256>`, or a replica
   * object under `_litestream/`. What `assertReplicaTargetConformance`'s
   * and `assertReplicaPathConformance`'s `objectExists` options expect.
   */
  objectExists(key: string): Promise<boolean>;
  /**
   * Sets a stored chunk's `lastModified`, as `assertStorageConformance`'s
   * `setLastModified` option expects. Present only with `storage`.
   */
  setChunkLastModified?(
    namespace: string,
    sha256: string,
    date: Date,
  ): Promise<void>;
  /** How many sync services `connect` has built. */
  connections(): number;
  /**
   * Every control-plane `get`, in order, including one that failed. Reads
   * change nothing, so they are not ops.
   */
  controlPlaneReads(): readonly InMemoryControlPlaneRead[];
  /** Drops a cache's persisted dirty state, like a lost sidecar file. */
  resetSidecar(cacheDir: string): void;
  /**
   * What the next push from `cacheDir` would send, read without side
   * effects: nothing is uploaded, no op is recorded, no injected failure is
   * consumed, and it works while offline.
   *
   * `uploads` are the files that differ from the committed content and
   * `deletes` the committed keys the push would remove, both sorted and
   * computed exactly as `pushChanged` would plan them now. A cache whose
   * sidecar is clean reports nothing, like the push fast path. `marked`
   * holds the recorded path marks and `bulk` whether the next push is a
   * full walk; while `bulk` is set the marks are ignored.
   */
  pendingPush(cacheDir: string): Promise<{
    uploads: string[];
    deletes: string[];
    marked: string[];
    bulk: boolean;
  }>;
}

const PLAN_SCOPED = Symbol("scoped");
const PLAN_PRIOR_SEQ = Symbol("priorSeq");
const PLAN_INDEX = Symbol("index");
const PLAN_OVERFLOWED = Symbol("overflowed");
const PLAN_MARKS = Symbol("marks");

interface InternalManifest extends InMemoryPushManifest {
  [PLAN_SCOPED]?: boolean;
  [PLAN_PRIOR_SEQ]?: number;
  [PLAN_INDEX]?: ReadonlyMap<string, Uint8Array>;
  [PLAN_OVERFLOWED]?: boolean;
  [PLAN_MARKS]?: MarkSnapshot;
}

/**
 * The marks a push or `preparePush` walks, taken when it starts. Clearing
 * removes only what this snapshot holds and has not been marked since.
 */
interface MarkSnapshot {
  /** Each marked path with its generation. */
  paths: ReadonlyMap<string, number>;
  /** The generation of the latest bulk mark. */
  bulkGen: number;
  bulk: boolean;
  overflowed: boolean;
}

interface Sidecar {
  localDirty: boolean;
  dirtyPaths: Set<string>;
  bulk: boolean;
  overflowed: boolean;
  /** Each marked path's generation, renewed by every mark of it. */
  pathGens: Map<string, number>;
  /** The generation of the latest bulk mark, 0 for none. */
  bulkGen: number;
  /** The last generation handed out. */
  markSeq: number;
  /** The remote commit sequence this cache last saw in full. */
  commitSeq?: number;
  /** Committed keys this cache saw at its last pull. */
  pulledKeys: Set<string>;
}

interface PendingFailure {
  op: InMemoryRemoteFailure;
  error: Error;
  afterUploads: boolean;
  instance?: string;
}

interface PushPlan {
  uploads: Map<string, Uint8Array>;
  deletes: string[];
  scoped: boolean;
}

const INTERNAL_FILES = new Set([
  ".datastore-index.json",
  ".push-queue.json",
  ".datastore.lock",
  ".datastore-sync-state.json",
]);

function isInternalCacheFile(rel: string): boolean {
  if (INTERNAL_FILES.has(rel)) return true;
  const first = rel.split("/")[0];
  if (first === "_index" || first === "_control") return true;
  const base = rel.split("/").at(-1) ?? rel;
  return base === ".lock" || base === ".namespace.json" ||
    base === "_catalog.db" || base.startsWith("_catalog.db-");
}

function sameBytes(a: Uint8Array, b: Uint8Array | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Matches the extensions' `dir + "/"` prefix test, so `""` matches nothing. */
function isUnder(key: string, dir: string): boolean {
  return key.startsWith(dir + "/");
}

function isInSubdirs(key: string, subdirs: readonly string[]): boolean {
  return subdirs.some((dir) => key === dir || isUnder(key, dir));
}

/**
 * Converts a mark to a forward-slash cache-relative path, or undefined when
 * it climbs out of the cache. Like the extensions' `join(cachePath, relPath)`,
 * an absolute path is nested under the cache rather than treated as escaping,
 * so the real file is never pushed.
 */
function toCacheRelative(relPath: string): string | undefined {
  const parts: string[] = [];
  for (const part of relPath.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * Whether `relPath` is absolute or has a `..` segment (fetchContent rule 5).
 * A drive letter counts only before a separator, so `a:b/raw` is a name.
 */
function couldLeaveDatastore(relPath: string): boolean {
  return /^([\\/]|[A-Za-z]:[\\/])/.test(relPath) ||
    relPath.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * The index shard a cache-relative path belongs to, or undefined for a path
 * no shard holds (S3SYNC:4436-4468).
 */
function partitionKeyFromPath(rel: string): string | undefined {
  const segments = rel.split("/");
  if (segments.length < 2) {
    return segments.length === 1 && segments[0] !== "" ? "_root" : undefined;
  }
  const subdir = segments[0];
  switch (subdir) {
    case "data":
    case "outputs":
    case "definitions-evaluated": {
      if (segments.length < 4) return undefined;
      const prefixEnd = segments.length >= 6
        ? segments.length - 3
        : segments.length - 1;
      return segments.slice(0, prefixEnd).join("--");
    }
    case "workflow-runs":
      if (segments.length < 3) return undefined;
      return `${subdir}--${segments[1]}`;
    default:
      return subdir;
  }
}

/**
 * The shards a push of marked paths reads, as `assembleDirtyShardsOnly`
 * picks them (S3SYNC:1548-1610): each existing shard that is a mark's own,
 * an ancestor of a mark, or lies under a marked directory.
 */
function shardsReadFor(
  marks: Iterable<string>,
  keys: Iterable<string>,
): Set<string> {
  const existing = new Set<string>();
  for (const rel of keys) {
    const key = partitionKeyFromPath(rel);
    if (key) existing.add(key);
  }
  const needed = new Set<string>();
  const ancestorKeys = new Set<string>();
  const dirtyKeys = new Set<string>();
  for (const mark of marks) {
    const key = partitionKeyFromPath(mark);
    if (key) needed.add(key);
    let joined = "";
    for (const segment of mark.split("/")) {
      if (segment === "") continue;
      joined = joined ? `${joined}--${segment}` : segment;
      ancestorKeys.add(joined);
    }
    if (joined) dirtyKeys.add(joined);
  }
  for (const partition of existing) {
    if (ancestorKeys.has(partition)) {
      needed.add(partition);
      continue;
    }
    for (
      let i = partition.indexOf("--");
      i !== -1;
      i = partition.indexOf("--", i + 2)
    ) {
      if (dirtyKeys.has(partition.substring(0, i))) {
        needed.add(partition);
        break;
      }
    }
  }
  return new Set([...needed].filter((key) => existing.has(key)));
}

async function readLocal(
  cacheDir: string,
  rel: string,
): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(join(cacheDir, ...rel.split("/")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function isRegularFile(cacheDir: string, rel: string): Promise<boolean> {
  try {
    return (await Deno.lstat(join(cacheDir, ...rel.split("/")))).isFile;
  } catch (error) {
    // A file now stands where a parent directory was.
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) return false;
    throw error;
  }
}

async function statLocal(
  cacheDir: string,
  rel: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(join(cacheDir, ...rel.split("/")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/** A walked entry: a file, or an entry whose target cannot be stat'ed. */
interface WalkedEntry {
  rel: string;
  dangling: boolean;
}

/**
 * Lists every non-internal file under `rel` in the cache, and every
 * symlink whose target is missing, sorted.
 */
async function walkLocalEntries(
  cacheDir: string,
  rel: string,
): Promise<WalkedEntry[]> {
  const found: WalkedEntry[] = [];
  const visit = async (dirRel: string): Promise<void> => {
    const dirPath = dirRel === ""
      ? cacheDir
      : join(cacheDir, ...dirRel.split("/"));
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dirPath));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      const child = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(child);
      } else if (isInternalCacheFile(child)) {
        continue;
      } else if (entry.isFile) {
        found.push({ rel: child, dangling: false });
      } else if (entry.isSymlink && !(await statLocal(cacheDir, child))) {
        found.push({ rel: child, dangling: true });
      }
    }
  };
  await visit(rel);
  return found.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
}

function filesOf(entries: readonly WalkedEntry[]): string[] {
  return entries.filter((entry) => !entry.dangling).map((entry) => entry.rel);
}

/**
 * Creates an in-memory remote datastore. Connect one sync service per
 * simulated machine; they share the remote's content.
 *
 * ```typescript
 * import { createInMemoryRemote } from "@swamp-club/swamp-testing";
 *
 * const remote = createInMemoryRemote();
 * const alice = remote.connect(aliceCache, { instance: "alice" });
 * const bob = remote.connect(bobCache, { instance: "bob" });
 * await Deno.writeTextFile(`${aliceCache}/note`, "hi");
 * await alice.markDirty({ relPath: "note" });
 * await alice.pushChanged();
 * await bob.pullChanged(); // bobCache/note now holds "hi"
 * ```
 */
export function createInMemoryRemote(
  options?: InMemoryRemoteOptions,
): InMemoryRemote {
  const semantics: InMemoryRemoteSemantics = {
    ...EXTENSION_SEMANTICS,
    ...options?.semantics,
  };
  const dirtyPathsCap = options?.dirtyPathsCap ?? 2000;
  const monolithIndex = options?.monolithIndex ?? false;
  const conditionalCreate = options?.conditionalCreate ?? true;
  const controlPlane = options?.controlPlane ?? false;
  const capabilities: SyncCapabilities = {
    ...(options?.capabilities ?? { twoPhaseSync: true }),
    ...(controlPlane ? { controlPlane: true } : {}),
  };
  // Control-plane records, keyed `_control/<key>` or
  // `<namespace>/_control/<key>` as the extensions store them.
  const controlRecords = new Map<string, Uint8Array>();
  const controlKey = (namespace: string | undefined, key: string) =>
    namespace ? `${namespace}/_control/${key}` : `_control/${key}`;
  const chunkStorage = options?.storage ? createChunkStorage() : undefined;
  const replicaTarget = options?.replicaTarget;
  // Objects under `_litestream/`, keyed as a bucket would key them.
  const replicaObjects = options?.replicaPaths
    ? new Map<string, Uint8Array>()
    : undefined;

  // Stored objects, written at once by prepare and push.
  const objects = new Map<string, Uint8Array>();
  // The published index: what other machines see when they pull.
  const committed = new Map<string, Uint8Array>();
  let commitSeq = 0;
  const sidecars = new Map<string, Sidecar>();
  // The committed bytes of each key as a cache last synced them. Stands in
  // for the extensions' on-disk `.datastore-index.json`, which is written
  // when they write it and, unlike the sidecar, `resetSidecar` keeps.
  const syncedIndexes = new Map<string, Map<string, Uint8Array>>();
  // Keys a peer deleted after a cache synced them while the cache kept its
  // copy, which `repairUnpushedFiles` must never upload. Like the synced
  // index, `resetSidecar` keeps it.
  const peerDeletedKeys = new Map<string, Set<string>>();
  const log: InMemoryRemoteOpRecord[] = [];
  const reads: InMemoryControlPlaneRead[] = [];
  const failures: PendingFailure[] = [];
  let isOffline = false;
  let instanceCount = 0;

  const sidecarKey = (cacheDir: string) => normalize(cacheDir);

  function takeFailure(
    op: InMemoryRemoteFailure,
    instance: string,
  ): PendingFailure | undefined {
    const index = failures.findIndex((f) =>
      f.op === op && (f.instance === undefined || f.instance === instance)
    );
    if (index === -1) return undefined;
    const [failure] = failures.splice(index, 1);
    return failure;
  }

  function checkReachable(
    op: InMemoryRemoteFailure,
    instance: string,
  ): PendingFailure | undefined {
    if (isOffline) throw new Error(`in-memory remote is offline (${op})`);
    const failure = takeFailure(op, instance);
    // Only a push has uploads to land before it fails.
    if (failure && !(op === "push" && failure.afterUploads)) {
      throw failure.error;
    }
    return failure;
  }

  function record(entry: InMemoryRemoteOpRecord): void {
    log.push({
      ...entry,
      paths: [...entry.paths].sort(),
      deleted: [...entry.deleted].sort(),
    });
  }

  function publish(
    uploads: ReadonlyMap<string, Uint8Array>,
    deletes: readonly string[],
  ): number {
    let deleted = 0;
    for (const [key, bytes] of uploads) committed.set(key, bytes);
    for (const key of deletes) {
      if (committed.delete(key)) deleted++;
    }
    if (uploads.size > 0 || deleted > 0) commitSeq++;
    return deleted;
  }

  /**
   * The keys a push reconciles against what the cache last synced: every
   * key after a full index read, or only those in the shards a push of
   * marked paths reads (S3SYNC:4174-4182).
   */
  function pushScope(sidecar: Sidecar | undefined): (rel: string) => boolean {
    const scoped = sidecar !== undefined && !sidecar.bulk &&
      sidecar.dirtyPaths.size > 0;
    if (!scoped) return () => true;
    const read = shardsReadFor(sidecar.dirtyPaths, committed.keys());
    return (rel) => {
      const key = partitionKeyFromPath(rel);
      return key !== undefined && read.has(key);
    };
  }

  /**
   * The local copies of files in `prior` that the remote no longer holds
   * and that are in scope, unmarked and unchanged since that sync, read
   * only. None without a prior sync, or when no committed key is in scope
   * (S3SYNC:4197-4301).
   */
  async function removableCopies(
    cacheDir: string,
    prior: ReadonlyMap<string, Uint8Array> | undefined,
    inScope: (rel: string) => boolean,
    marked: ReadonlySet<string>,
  ): Promise<string[]> {
    if (!prior) return [];
    const candidates = [...prior.keys()].filter((rel) =>
      !isInternalCacheFile(rel) && inScope(rel) && !committed.has(rel)
    ).sort();
    if (candidates.length === 0) return [];
    if (![...committed.keys()].some(inScope)) return [];
    const removable: string[] = [];
    for (const rel of candidates) {
      if (marked.has(rel)) continue;
      const info = await statLocal(cacheDir, rel);
      if (!info?.isFile) continue;
      if (sameBytes(prior.get(rel)!, await readLocal(cacheDir, rel))) {
        removable.push(rel);
      }
    }
    return removable;
  }

  /** Plans the push from `cacheDir` as `pushChanged` would, reading only. */
  async function planPushFor(
    cacheDir: string,
    sidecar: Sidecar | undefined,
  ): Promise<PushPlan> {
    const uploads = new Map<string, Uint8Array>();
    const deletes = new Set<string>();
    const uploadIfChanged = async (rel: string) => {
      const bytes = await readLocal(cacheDir, rel);
      if (bytes && !sameBytes(bytes, committed.get(rel))) {
        uploads.set(rel, bytes);
      }
    };

    const scoped = sidecar !== undefined && !sidecar.bulk &&
      sidecar.dirtyPaths.size > 0;
    if (scoped) {
      for (const rel of [...sidecar.dirtyPaths].sort()) {
        if (isInternalCacheFile(rel)) continue;
        const info = await statLocal(cacheDir, rel);
        if (info?.isFile) {
          await uploadIfChanged(rel);
        } else if (info?.isDirectory) {
          const entries = await walkLocalEntries(cacheDir, rel);
          const cut = semantics.vanishedEntryDeletesDir
            ? entries.findIndex((entry) => entry.dangling)
            : -1;
          if (cut !== -1) {
            // The failed stat escapes the walk, so the directory is taken
            // as absent (S3SYNC @ ad6b66233:3454, 3473-3492).
            for (const entry of entries.slice(0, cut)) {
              await uploadIfChanged(entry.rel);
            }
            for (const remoteKey of committed.keys()) {
              if (remoteKey === rel || isUnder(remoteKey, rel)) {
                deletes.add(remoteKey);
              }
            }
            continue;
          }
          const local = filesOf(entries);
          for (const file of local) await uploadIfChanged(file);
          const present = new Set(local);
          for (const remoteKey of committed.keys()) {
            if (isUnder(remoteKey, rel) && !present.has(remoteKey)) {
              deletes.add(remoteKey);
            }
          }
        } else if (!info) {
          for (const remoteKey of committed.keys()) {
            if (remoteKey === rel || isUnder(remoteKey, rel)) {
              deletes.add(remoteKey);
            }
          }
        }
      }
      return { uploads, deletes: [...deletes].sort(), scoped };
    }

    // Full walk: a bulk mark, an empty set, or no sidecar yet. A failed
    // stat ends it early, unnoticed (S3SYNC @ ad6b66233:3528, 3532-3534).
    const entries = await walkLocalEntries(cacheDir, "");
    const cut = semantics.vanishedEntryDeletesDir
      ? entries.findIndex((entry) => entry.dangling)
      : -1;
    const local = filesOf(cut === -1 ? entries : entries.slice(0, cut));
    for (const file of local) await uploadIfChanged(file);
    const deletesMissing = sidecar !== undefined &&
      (sidecar.overflowed ||
        (sidecar.bulk && !semantics.bulkDisablesDeletes));
    if (deletesMissing) {
      const present = new Set(local);
      for (const remoteKey of committed.keys()) {
        if (!present.has(remoteKey)) deletes.add(remoteKey);
      }
    }
    return { uploads, deletes: [...deletes].sort(), scoped };
  }

  function connect(
    cacheDir: string,
    connectOptions?: ConnectOptions,
  ): InMemorySyncService {
    instanceCount++;
    const instance = connectOptions?.instance ?? `instance-${instanceCount}`;
    const key = sidecarKey(cacheDir);

    let namespace: string | undefined;
    let namespaceBound = false;
    /**
     * Binds the namespace on first use and refuses a different one after.
     * An empty namespace is no namespace.
     */
    const bindNamespace = (given: string | undefined): void => {
      const ns = given || undefined;
      if (!namespaceBound) {
        namespace = ns;
        namespaceBound = true;
        return;
      }
      if (namespace !== ns) {
        throw new Error(
          `Namespace mismatch: bound to ${JSON.stringify(namespace)} ` +
            `but called with ${JSON.stringify(ns)}`,
        );
      }
    };

    const loadSidecar = () => sidecars.get(key);
    const ensureSidecar = (): Sidecar => {
      let sidecar = sidecars.get(key);
      if (!sidecar) {
        sidecar = {
          localDirty: false,
          dirtyPaths: new Set(),
          bulk: false,
          overflowed: false,
          pathGens: new Map(),
          bulkGen: 0,
          markSeq: 0,
          pulledKeys: new Set(),
        };
        sidecars.set(key, sidecar);
      }
      return sidecar;
    };

    const planPush = (sidecar: Sidecar | undefined): Promise<PushPlan> =>
      planPushFor(cacheDir, sidecar);

    /** The marks a push or prepare starting now walks. */
    const snapshotMarks = (sidecar: Sidecar | undefined): MarkSnapshot => ({
      paths: new Map(sidecar?.pathGens ?? []),
      bulkGen: sidecar?.bulkGen ?? 0,
      bulk: sidecar?.bulk ?? false,
      overflowed: sidecar?.overflowed ?? false,
    });

    /**
     * What a push walks: the live sidecar where a push reads the marks as
     * it goes, or the snapshot's marks where it walks only those.
     */
    const walkedSidecar = (
      sidecar: Sidecar | undefined,
      marks: MarkSnapshot,
    ): Sidecar | undefined =>
      semantics.commitClearsLaterMarks || !sidecar ? sidecar : {
        ...sidecar,
        dirtyPaths: new Set(marks.paths.keys()),
        bulk: marks.bulk,
        overflowed: marks.overflowed,
      };

    /** Sets the bulk flag with a new generation. */
    const markBulkOn = (sidecar: Sidecar, overflow: boolean): void => {
      sidecar.bulk = true;
      sidecar.bulkGen = ++sidecar.markSeq;
      sidecar.localDirty = true;
      if (overflow) sidecar.overflowed = true;
    };

    /** Whether every key in `index` (default: the live remote) is local. */
    async function hasAll(index: Iterable<string>): Promise<boolean> {
      for (const remoteKey of index) {
        if (!(await statLocal(cacheDir, remoteKey))) return false;
      }
      return true;
    }

    /**
     * Marks the cache clean after a successful push, and arms the pull fast
     * path only when nothing else landed since `baseSeq` and this cache is
     * known to hold everything (S3SYNC:3398-3427, 4049-4062).
     */
    async function settle(arm: {
      priorSeq: number | undefined;
      baseSeq: number;
      upToDate: boolean;
      scoped: boolean;
      overflowed: boolean;
      /** The index this cache holds; defaults to the live remote. */
      index?: Iterable<string>;
      /** The marks the push walked; absent when it walked none. */
      marks?: MarkSnapshot;
    }): Promise<void> {
      const sidecar = ensureSidecar();
      if (semantics.commitClearsLaterMarks) {
        sidecar.dirtyPaths.clear();
        sidecar.pathGens.clear();
        sidecar.bulk = false;
        sidecar.overflowed = false;
        sidecar.localDirty = false;
      } else if (arm.marks) {
        for (const [rel, gen] of arm.marks.paths) {
          if (sidecar.pathGens.get(rel) !== gen) continue;
          sidecar.dirtyPaths.delete(rel);
          sidecar.pathGens.delete(rel);
        }
        if (sidecar.bulkGen === arm.marks.bulkGen) {
          sidecar.bulk = false;
          sidecar.overflowed = false;
        }
        sidecar.localDirty = sidecar.bulk || sidecar.dirtyPaths.size > 0;
      }
      const reconciled = (arm.scoped || arm.overflowed) &&
        arm.priorSeq === arm.baseSeq;
      const armed = arm.upToDate &&
        (reconciled ||
          (!arm.scoped && await hasAll(arm.index ?? committed.keys())));
      sidecar.commitSeq = armed ? commitSeq : undefined;
    }

    /**
     * Removes the copies {@link removableCopies} finds, then the
     * directories that leaves empty below the top level (S3SYNC:4310-4324).
     */
    async function removePeerDeleted(
      prior: ReadonlyMap<string, Uint8Array> | undefined,
      inScope: (rel: string) => boolean,
      marked: ReadonlySet<string>,
    ): Promise<string[]> {
      const keepDepth = namespace ? 2 : 1;
      const removed: string[] = [];
      for (
        const rel of await removableCopies(cacheDir, prior, inScope, marked)
      ) {
        try {
          await Deno.remove(join(cacheDir, ...rel.split("/")));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        const segments = rel.split("/");
        for (let depth = segments.length - 1; depth > keepDepth; depth--) {
          try {
            await Deno.remove(join(cacheDir, ...segments.slice(0, depth)));
          } catch {
            break;
          }
        }
        removed.push(rel);
      }
      return removed;
    }

    /**
     * The removal a push or prepare runs after reading the remote, before
     * it walks the cache (S3SYNC:3103-3109, 3635-3641).
     */
    function removeBeforePush(sidecar: Sidecar | undefined): Promise<string[]> {
      if (!semantics.removesPeerDeletes) return Promise.resolve([]);
      return removePeerDeleted(
        syncedIndexes.get(key),
        pushScope(sidecar),
        sidecar?.dirtyPaths ?? new Set(),
      );
    }

    /**
     * Records what a committed push leaves this cache synced to, as
     * `writeLocalIndexAfterPush` writes the local index (S3SYNC:2289-2344):
     * the index it read plus its changes, or, for a push of marked paths,
     * only its changes merged into the last record.
     */
    async function recordPushed(
      scoped: boolean,
      index: ReadonlyMap<string, Uint8Array>,
      uploads: ReadonlyMap<string, Uint8Array>,
      deletes: readonly string[],
    ): Promise<void> {
      if (!scoped) {
        const next = new Map(index);
        for (const [rel, bytes] of uploads) next.set(rel, bytes);
        for (const rel of deletes) next.delete(rel);
        await recordPeerDeleted(next);
        syncedIndexes.set(key, next);
        return;
      }
      const synced = syncedIndexes.get(key);
      if (!synced) return;
      const recorded = peerDeletedKeys.get(key) ?? new Set<string>();
      for (const [rel, bytes] of uploads) {
        synced.set(rel, bytes);
        recorded.delete(rel);
      }
      for (const rel of deletes) {
        // A directory taken as absent deletes files still on disk.
        if (
          synced.delete(rel) && !isInternalCacheFile(rel) &&
          await isRegularFile(cacheDir, rel)
        ) {
          recorded.add(rel);
        }
      }
      for (const rel of [...recorded]) {
        if (!(await isRegularFile(cacheDir, rel))) recorded.delete(rel);
      }
      peerDeletedKeys.set(key, recorded);
    }

    /**
     * Records each key `next` drops from the last-synced index while a
     * regular file stays at its path, and forgets the keys `next` holds
     * again or whose file is gone. A delete this cache pushed leaves no
     * file, so it is recorded only when the push deleted a file still on
     * disk.
     */
    async function recordPeerDeleted(
      next: ReadonlyMap<string, Uint8Array>,
    ): Promise<void> {
      const recorded = peerDeletedKeys.get(key) ?? new Set<string>();
      for (const rel of syncedIndexes.get(key)?.keys() ?? []) {
        if (!next.has(rel) && !isInternalCacheFile(rel)) recorded.add(rel);
      }
      for (const rel of [...recorded]) {
        if (next.has(rel) || !(await isRegularFile(cacheDir, rel))) {
          recorded.delete(rel);
        }
      }
      peerDeletedKeys.set(key, recorded);
    }

    async function pushChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      bindNamespace(options?.namespace);
      const sidecar = loadSidecar();
      // The fast path reads only the local sidecar, so it succeeds offline
      // and never reaches an injected failure (S3SYNC:1945-1954).
      if (sidecar && !sidecar.localDirty) {
        record({ instance, op: "push", paths: [], deleted: [] });
        return 0;
      }
      const failure = checkReachable("push", instance);
      const priorSeq = sidecar?.commitSeq;
      const baseSeq = commitSeq;
      const overflowed = sidecar?.overflowed ?? false;
      const snapshot = new Map(committed);
      const marks = snapshotMarks(sidecar);
      const walked = walkedSidecar(sidecar, marks);
      const removed = await removeBeforePush(walked);
      const plan = await planPush(walked);
      if (failure) {
        // Uploads landed as objects but the index was never committed. As
        // released, each upload's bare mark leaves the bulk flag set
        // (S3SYNC:2911). With per-path generations the uploads mark nothing
        // and a scoped push keeps its path marks; only a whole-cache push,
        // which no mark covered, leaves the cache bulk-dirty.
        for (const [rel, bytes] of plan.uploads) objects.set(rel, bytes);
        const keepsPathMarks = !semantics.commitClearsLaterMarks &&
          plan.scoped;
        if (plan.uploads.size > 0 && !keepsPathMarks) {
          markBulkOn(ensureSidecar(), false);
        }
        throw failure.error;
      }
      for (const [rel, bytes] of plan.uploads) objects.set(rel, bytes);
      for (const rel of plan.deletes) objects.delete(rel);
      // Another machine may have committed while this push read its files.
      const upToDate = commitSeq === baseSeq;
      const deleted = publish(plan.uploads, plan.deletes);
      await settle({
        priorSeq,
        baseSeq,
        upToDate,
        scoped: plan.scoped,
        overflowed,
        marks,
      });
      await recordPushed(plan.scoped, snapshot, plan.uploads, plan.deletes);
      record({
        instance,
        op: "push",
        paths: [...plan.uploads.keys()],
        deleted: plan.deletes.filter((rel) => !committed.has(rel)),
        ...(removed.length > 0 ? { removed } : {}),
      });
      return plan.uploads.size + deleted;
    }

    async function preparePush(
      options?: DatastoreSyncOptions,
    ): Promise<InMemoryPushManifest> {
      bindNamespace(options?.namespace);
      const sidecar = loadSidecar();
      if (sidecar && !sidecar.localDirty) {
        record({ instance, op: "prepare", paths: [], deleted: [] });
        return { uploads: new Map(), deletes: [] };
      }
      checkReachable("prepare", instance);
      const snapshot = new Map(committed);
      const marks = snapshotMarks(sidecar);
      const walked = walkedSidecar(sidecar, marks);
      const removed = await removeBeforePush(walked);
      const plan = await planPush(walked);
      for (const [rel, bytes] of plan.uploads) objects.set(rel, bytes);
      for (const rel of plan.deletes) objects.delete(rel);
      record({
        instance,
        op: "prepare",
        paths: [...plan.uploads.keys()],
        deleted: plan.deletes,
        ...(removed.length > 0 ? { removed } : {}),
      });
      return {
        uploads: plan.uploads,
        deletes: plan.deletes,
        [PLAN_SCOPED]: plan.scoped,
        [PLAN_PRIOR_SEQ]: sidecar?.commitSeq,
        [PLAN_INDEX]: snapshot,
        [PLAN_OVERFLOWED]: sidecar?.overflowed ?? false,
        [PLAN_MARKS]: marks,
      } as InMemoryPushManifest;
    }

    async function commitPush(
      manifest: InMemoryPushManifest,
      _options?: DatastoreSyncOptions,
    ): Promise<number> {
      checkReachable("commit", instance);
      const internal = manifest as InternalManifest;
      // Commit compares the cache's last-seen sequence with the remote's at
      // commit time, so a peer's commit after prepare blocks the arm.
      const baseSeq = commitSeq;
      // The cache's own index is what prepare read plus this push's changes;
      // a peer's commit since prepare is not in it (S3SYNC:4015-4026).
      const index = new Map(internal[PLAN_INDEX] ?? committed);
      for (const [rel, bytes] of manifest.uploads) index.set(rel, bytes);
      for (const rel of manifest.deletes) index.delete(rel);
      const scoped = internal[PLAN_SCOPED] ?? false;
      const deleted = publish(manifest.uploads, manifest.deletes);
      await settle({
        priorSeq: internal[PLAN_PRIOR_SEQ],
        baseSeq,
        upToDate: true,
        scoped,
        overflowed: internal[PLAN_OVERFLOWED] ?? false,
        index: index.keys(),
        marks: internal[PLAN_MARKS],
      });
      await recordPushed(scoped, index, manifest.uploads, manifest.deletes);
      record({
        instance,
        op: "commit",
        paths: [...manifest.uploads.keys()],
        deleted: manifest.deletes.filter((rel) => !committed.has(rel)),
      });
      return manifest.uploads.size + deleted;
    }

    async function pullChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      bindNamespace(options?.namespace);
      checkReachable("pull", instance);
      const subdirs = options?.subdirs ?? [];
      const scoped = subdirs.length > 0;
      const sidecar = loadSidecar();
      if (sidecar?.commitSeq !== undefined && sidecar.commitSeq === commitSeq) {
        record({ instance, op: "pull", paths: [], deleted: [] });
        return 0;
      }

      const state = ensureSidecar();
      // The extensions remove before downloading, and a subdir-scoped pull
      // still reconciles every key (S3SYNC:2537-2543).
      const peerRemoved = semantics.removesPeerDeletes && !semantics.pullDeletes
        ? await removePeerDeleted(
          syncedIndexes.get(key),
          () => true,
          state.dirtyPaths,
        )
        : [];

      const downloaded: string[] = [];
      for (const [rel, bytes] of committed) {
        if (scoped && !isInSubdirs(rel, subdirs)) continue;
        const local = await readLocal(cacheDir, rel);
        if (sameBytes(bytes, local)) continue;
        const path = join(cacheDir, ...rel.split("/"));
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeFile(path, bytes);
        downloaded.push(rel);
      }

      const removed: string[] = [];
      if (semantics.pullDeletes) {
        for (const rel of state.pulledKeys) {
          if (committed.has(rel)) continue;
          if (scoped && !isInSubdirs(rel, subdirs)) continue;
          if (state.dirtyPaths.has(rel)) continue;
          try {
            await Deno.remove(join(cacheDir, ...rel.split("/")));
            removed.push(rel);
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      }

      for (const rel of [...state.pulledKeys]) {
        if (!scoped || isInSubdirs(rel, subdirs)) state.pulledKeys.delete(rel);
      }
      for (const rel of committed.keys()) {
        if (!scoped || isInSubdirs(rel, subdirs)) state.pulledKeys.add(rel);
      }
      // A subdir-scoped pull saves the whole index too. One snapshot feeds
      // both, so a peer's delete during the record's awaits is not lost.
      const next = new Map(committed);
      await recordPeerDeleted(next);
      syncedIndexes.set(key, next);
      if (!scoped) {
        if (semantics.pullClearsPendingPush) state.localDirty = false;
        state.commitSeq = commitSeq;
      }

      record({
        instance,
        op: "pull",
        paths: downloaded,
        deleted: [...removed, ...peerRemoved],
      });
      // Like the extensions, a pull leaves peer removals out of its count
      // (S3SYNC:2875).
      return downloaded.length + removed.length;
    }

    function markDirty(options?: DatastoreSyncOptions): Promise<void> {
      const relPath = options?.relPath;
      const sidecar = ensureSidecar();
      const markBulk = (overflow: boolean) => markBulkOn(sidecar, overflow);
      // Without generations a repeated mark leaves no trace.
      const tracksGenerations = !semantics.commitClearsLaterMarks;

      if (relPath) {
        record({ instance, op: "markDirty", paths: [relPath], deleted: [] });
        if (sidecar.bulk) {
          // The path is not recorded, so the bulk flag carries the mark: a
          // push that snapshotted the flag before this keeps it set.
          if (tracksGenerations) sidecar.bulkGen = ++sidecar.markSeq;
          return Promise.resolve();
        }
        const rel = toCacheRelative(relPath);
        if (rel === undefined) {
          markBulk(false);
          return Promise.resolve();
        }
        if (sidecar.dirtyPaths.has(rel)) {
          if (tracksGenerations) sidecar.pathGens.set(rel, ++sidecar.markSeq);
          return Promise.resolve();
        }
        if (sidecar.dirtyPaths.size >= dirtyPathsCap) {
          markBulk(true);
          return Promise.resolve();
        }
        sidecar.dirtyPaths.add(rel);
        sidecar.pathGens.set(rel, ++sidecar.markSeq);
        sidecar.localDirty = true;
        return Promise.resolve();
      }

      record({
        instance,
        op: "markDirty",
        paths: [],
        deleted: [],
        bulk: true,
      });
      markBulk(false);
      return Promise.resolve();
    }

    // Models the `clearDirty` contract (swamp-club#4091), which no released
    // extension implements yet. Synchronous, so every mark it sees was made
    // before the call (contract rule 2).
    function clearDirty(relPaths: readonly string[]): Promise<void> {
      record({
        instance,
        op: "clearDirty",
        paths: [...relPaths].sort(),
        deleted: [],
      });
      const sidecar = loadSidecar();
      if (sidecar === undefined) return Promise.resolve();
      for (const relPath of relPaths) {
        const rel = toCacheRelative(relPath);
        if (rel === undefined) continue;
        sidecar.dirtyPaths.delete(rel);
        sidecar.pathGens.delete(rel);
      }
      sidecar.localDirty = sidecar.bulk || sidecar.dirtyPaths.size > 0;
      return Promise.resolve();
    }

    function fetchContent(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<Uint8Array | null> {
      try {
        const rel = toCacheRelative(relPath);
        if (rel === undefined || couldLeaveDatastore(relPath)) {
          throw new Error(`Path traversal rejected: ${relPath}`);
        }
        checkReachable("fetch", instance);
        record({ instance, op: "fetch", paths: [rel], deleted: [] });
        const bytes = committed.get(rel);
        // A copy, so a caller that changes it does not change the remote.
        return Promise.resolve(bytes ? bytes.slice() : null);
      } catch (error) {
        return Promise.reject(error);
      }
    }

    /**
     * Models the `repairUnpushedFiles` contract. The fake compares bytes, so `exact` changes nothing
     * and `unknown` is always 0. Its index is never split into shards, so
     * the created files are committed in one batch. With no namespace every
     * cache file is in scope: the fake keeps no foreign namespace
     * directories to leave out.
     */
    async function repairUnpushedFiles(
      options?: RepairUnpushedFilesOptions,
    ): Promise<UnpushedFilesSummary> {
      const dryRun = options?.dryRun ?? false;
      bindNamespace(options?.namespace);
      checkReachable("repair", instance);
      if (monolithIndex) {
        throw new Error(
          "The remote index is a v1 monolith. Run `swamp datastore sync " +
            "--pull` and then `swamp datastore migrate-index` first.",
        );
      }
      const synced = syncedIndexes.get(key);
      if (!synced) {
        throw new Error(
          "This cache has no last-synced index, so unpushed files cannot " +
            "be told apart from files a peer deleted. Pull first.",
        );
      }
      if (!dryRun && !conditionalCreate) {
        throw new Error(
          "The remote does not support create-only writes, so unpushed " +
            "files cannot be uploaded without risking a peer's object.",
        );
      }
      const inScope = (rel: string) => !namespace || isUnder(rel, namespace);

      const peerDeletedHere = peerDeletedKeys.get(key) ?? new Set<string>();
      const unpushed: Array<[string, Uint8Array]> = [];
      const alreadyPresent: string[] = [];
      const modified: string[] = [];
      const peerDeleted: string[] = [];
      for (const rel of filesOf(await walkLocalEntries(cacheDir, ""))) {
        if (!inScope(rel)) continue;
        const bytes = await readLocal(cacheDir, rel);
        if (!bytes) continue;
        const syncedBytes = synced.get(rel);
        if (syncedBytes) {
          if (!sameBytes(bytes, syncedBytes)) modified.push(rel);
          continue;
        }
        if (committed.has(rel)) {
          if (!sameBytes(bytes, committed.get(rel))) alreadyPresent.push(rel);
          continue;
        }
        if (peerDeletedHere.has(rel)) {
          peerDeleted.push(rel);
          continue;
        }
        // An unindexed object with these bytes is an upload of ours whose
        // commit never ran; one with other bytes is a peer's.
        const object = objects.get(rel);
        if (object && !sameBytes(bytes, object)) {
          alreadyPresent.push(rel);
        } else {
          unpushed.push([rel, bytes]);
        }
      }
      let remoteMovedOn = 0;
      for (const [rel, bytes] of synced) {
        if (!inScope(rel) || isInternalCacheFile(rel)) continue;
        const remote = committed.get(rel);
        if (remote && !sameBytes(remote, bytes)) remoteMovedOn++;
      }

      const created = new Map<string, Uint8Array>();
      const refused = new Set<string>();
      if (!dryRun) {
        for (const [rel, bytes] of unpushed) {
          // A peer may have committed or stored the key while the walk
          // read files: the create is refused, and other bytes are
          // alreadyPresent.
          const current = committed.get(rel) ?? objects.get(rel);
          if (current && !sameBytes(bytes, current)) {
            alreadyPresent.push(rel);
            refused.add(rel);
            continue;
          }
          if (!objects.has(rel)) objects.set(rel, bytes);
          created.set(rel, bytes);
        }
        // Commits the entries and leaves the sidecar alone: the dirty state
        // and the commit sequence this cache last saw are not touched.
        publish(created, []);
        for (const [rel, bytes] of created) synced.set(rel, bytes);
        record({
          instance,
          op: "repair",
          paths: [...created.keys()],
          deleted: [],
        });
      }
      // A refused create is settled as alreadyPresent, not left unpushed.
      const remaining = unpushed.map(([rel]) => rel).filter((rel) =>
        !created.has(rel) && !refused.has(rel)
      );
      const sample = (paths: string[]) => paths.sort().slice(0, SAMPLE_LIMIT);
      return {
        unpushed: remaining.length,
        samplePaths: sample(remaining),
        alreadyPresent: alreadyPresent.length,
        sampleAlreadyPresent: sample(alreadyPresent),
        locallyModified: modified.length,
        sampleModified: sample(modified),
        unknown: 0,
        sampleUnknown: [],
        peerDeleted: peerDeleted.length,
        samplePeerDeleted: sample(peerDeleted),
        remoteMovedOn,
        uploaded: created.size,
        pendingChanges: loadSidecar()?.localDirty ?? false,
      };
    }

    /**
     * The extensions' store: a service that has not bound a namespace binds
     * none on its first call, so its keys are datastore-wide from then on.
     */
    function controlPlaneStore(): ControlPlaneStore {
      const reach = (): void => {
        if (!namespaceBound) bindNamespace(undefined);
        checkReachable("controlPlane", instance);
      };
      const written = (fullKey: string): void =>
        record({
          instance,
          op: "controlPlane",
          paths: [fullKey],
          deleted: [],
        });
      return {
        get(key, readOptions) {
          try {
            // An unbound service reads datastore-wide, so the key is the
            // same before and after reach() binds it.
            reads.push({ instance, key: controlKey(namespace, key) });
            readOptions?.signal?.throwIfAborted();
            reach();
            const bytes = controlRecords.get(controlKey(namespace, key));
            return Promise.resolve(bytes ? bytes.slice() : null);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        put(key, data) {
          try {
            reach();
            const fullKey = controlKey(namespace, key);
            controlRecords.set(fullKey, data.slice());
            written(fullKey);
            return Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        },
        putIfAbsent(key, data) {
          try {
            reach();
            const fullKey = controlKey(namespace, key);
            if (controlRecords.has(fullKey)) return Promise.resolve(false);
            controlRecords.set(fullKey, data.slice());
            written(fullKey);
            return Promise.resolve(true);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        delete(key) {
          try {
            reach();
            const fullKey = controlKey(namespace, key);
            controlRecords.delete(fullKey);
            record({
              instance,
              op: "controlPlane",
              paths: [],
              deleted: [fullKey],
            });
            return Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        },
        list(prefix) {
          try {
            reach();
            const base = controlKey(namespace, "");
            return Promise.resolve(
              [...controlRecords.keys()]
                .filter((k) => k.startsWith(base + prefix))
                .map((k) => k.slice(base.length))
                .sort(),
            );
          } catch (error) {
            return Promise.reject(error);
          }
        },
      };
    }

    return {
      pullChanged,
      pushChanged,
      markDirty,
      preparePush,
      commitPush,
      capabilities: () => ({ ...capabilities }),
      ...(connectOptions?.fetchContent === false ? {} : { fetchContent }),
      ...(connectOptions?.clearDirty === false ? {} : { clearDirty }),
      ...(connectOptions?.repairUnpushedFiles === false
        ? {}
        : { repairUnpushedFiles }),
      ...(controlPlane ? { controlPlaneStore } : {}),
    };
  }

  /** A provider's datastore-wide store; see `InMemoryRemote`. */
  function datastoreControlPlaneStore(): WritableDatastoreControlPlaneStore {
    const instance = "datastore";
    const reach = (): void => {
      checkReachable("controlPlane", instance);
    };
    return {
      get(key, readOptions) {
        try {
          const fullKey = controlKey(undefined, key);
          reads.push({ instance, key: fullKey });
          readOptions?.signal?.throwIfAborted();
          reach();
          const bytes = controlRecords.get(fullKey);
          return Promise.resolve(bytes ? bytes.slice() : null);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      put(key, data) {
        try {
          reach();
          const fullKey = controlKey(undefined, key);
          controlRecords.set(fullKey, data.slice());
          record({
            instance,
            op: "controlPlane",
            paths: [fullKey],
            deleted: [],
          });
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
      putIfAbsent(key, data) {
        try {
          reach();
          const fullKey = controlKey(undefined, key);
          if (controlRecords.has(fullKey)) return Promise.resolve(false);
          controlRecords.set(fullKey, data.slice());
          record({
            instance,
            op: "controlPlane",
            paths: [fullKey],
            deleted: [],
          });
          return Promise.resolve(true);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      delete(key) {
        try {
          reach();
          const fullKey = controlKey(undefined, key);
          controlRecords.delete(fullKey);
          record({
            instance,
            op: "controlPlane",
            paths: [],
            deleted: [fullKey],
          });
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
      list(prefix) {
        try {
          reach();
          const base = controlKey(undefined, "");
          return Promise.resolve(
            [...controlRecords.keys()]
              .filter((k) => k.startsWith(base + prefix))
              .map((k) => k.slice(base.length))
              .sort(),
          );
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
  }

  function replicaPathStore(
    replicaObjects: Map<string, Uint8Array>,
  ): ReplicaPathStore {
    // Runs `fn` as a promise, so a throw (an injected failure, an aborted
    // signal, a refused fence) rejects.
    const settle = <T>(fn: () => T): Promise<T> =>
      new Promise((resolve) => resolve(fn()));
    return {
      list: (signal) =>
        settle(() => {
          checkReachable("replicaPaths", "datastore");
          signal.throwIfAborted();
          const fences = new Set<string>();
          for (const key of replicaObjects.keys()) {
            const rest = key.slice(REPLICA_ROOT.length);
            const slash = rest.indexOf("/");
            if (slash > 0) fences.add(rest.slice(0, slash));
          }
          return [...fences];
        }),
      removePath: (fence, signal) =>
        settle(() => {
          checkReachable("replicaPaths", "datastore");
          const problem = replicaPathFenceProblem(fence);
          if (problem !== undefined) {
            throw new Error(`Refusing to remove a replica path: ${problem}`);
          }
          const dir = `${REPLICA_ROOT}${fence}/`;
          // A page at a time, as a bucket listing returns them.
          for (;;) {
            signal.throwIfAborted();
            const page = [...replicaObjects.keys()]
              .filter((key) => key.startsWith(dir))
              .slice(0, REPLICA_PAGE_SIZE);
            if (page.length === 0) return;
            for (const key of page) replicaObjects.delete(key);
          }
        }),
    };
  }

  return {
    connect,
    files: () => new Map(committed),
    storeObject(key, bytes) {
      objects.set(key, bytes.slice());
    },
    failNext(op, error, failOptions) {
      failures.push({
        op,
        error: error ?? new Error(`injected ${op} failure`),
        afterUploads: failOptions?.afterUploads ?? false,
        instance: failOptions?.instance,
      });
    },
    offline(value) {
      isOffline = value;
    },
    seedControlPlane(key, data, seedOptions) {
      if (!controlPlane) {
        throw new Error("seedControlPlane needs the controlPlane option");
      }
      controlRecords.set(controlKey(seedOptions?.namespace, key), data.slice());
    },
    controlPlaneRecords: () =>
      new Map([...controlRecords].map(([k, v]) => [k, v.slice()])),
    ...(controlPlane ? { datastoreControlPlaneStore } : {}),
    ...(chunkStorage
      ? {
        storage: chunkStorage.storage,
        setChunkLastModified: chunkStorage.setChunkLastModified,
      }
      : {}),
    ...(replicaTarget !== undefined
      ? { replicaTarget: () => replicaTarget }
      : {}),
    ...(replicaObjects !== undefined
      ? {
        replicaPaths: () => replicaPathStore(replicaObjects),
        putReplicaObject(key: string, bytes: Uint8Array) {
          if (!key.startsWith(REPLICA_ROOT)) {
            throw new Error(
              `a replica object is under ${REPLICA_ROOT}: ${key}`,
            );
          }
          replicaObjects.set(key, bytes.slice());
        },
        deleteReplicaObject(key: string) {
          replicaObjects.delete(key);
        },
      }
      : {}),
    objectExists: (key) =>
      Promise.resolve(
        committed.has(key) || controlRecords.has(key) ||
          (chunkStorage?.hasObject(key) ?? false) ||
          (replicaObjects?.has(key) ?? false),
      ),
    connections: () => instanceCount,
    controlPlaneReads: () => reads.map((read) => ({ ...read })),
    ops: () =>
      log.map((entry) => ({
        ...entry,
        paths: [...entry.paths],
        deleted: [...entry.deleted],
      })),
    resetSidecar(cacheDir) {
      sidecars.delete(sidecarKey(cacheDir));
    },
    async pendingPush(cacheDir) {
      const sidecar = sidecars.get(sidecarKey(cacheDir));
      const marked = [...(sidecar?.dirtyPaths ?? [])].sort();
      const bulk = sidecar?.bulk ?? false;
      if (sidecar && !sidecar.localDirty) {
        return { uploads: [], deletes: [], marked, bulk };
      }
      const plan = await planPushFor(cacheDir, sidecar);
      // The push removes these copies before it walks, so never sends them.
      const removable = new Set(
        semantics.removesPeerDeletes
          ? await removableCopies(
            cacheDir,
            syncedIndexes.get(sidecarKey(cacheDir)),
            pushScope(sidecar),
            sidecar?.dirtyPaths ?? new Set(),
          )
          : [],
      );
      return {
        uploads: [...plan.uploads.keys()].filter((rel) => !removable.has(rel))
          .sort(),
        deletes: plan.deletes,
        marked,
        bulk,
      };
    },
  };
}

/** Paths a `repairUnpushedFiles` summary lists per category. */
const SAMPLE_LIMIT = 20;

/** Where the in-memory remote keeps replica objects. */
const REPLICA_ROOT = "_litestream/";

/** Objects `removePath` deletes per listing page. */
const REPLICA_PAGE_SIZE = 2;

/**
 * The `storage/1` model behind {@link InMemoryRemoteOptions.storage}:
 * chunks keyed `<namespace>/<sha256>`, each with its `lastModified`.
 */
function createChunkStorage():
  & Required<Pick<InMemoryRemote, "storage" | "setChunkLastModified">>
  & {
    /** Whether a chunk is stored at its bucket key. */
    hasObject(objectKey: string): boolean;
  } {
  const chunks = new Map<string, { bytes: Uint8Array; lastModified: Date }>();
  const key = (namespace: string, sha256: string) => `${namespace}/${sha256}`;
  // Runs `fn` as a promise, so a throw (an aborted signal) rejects.
  const settle = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve) => resolve(fn()));
  const storage: DatastoreStorage = {
    contract: "storage/1",
    capabilities: () => ({ maxChunkBytes: 16 * 1024 * 1024, touch: true }),
    has: (namespace, hashes, signal) =>
      settle(() => {
        signal.throwIfAborted();
        return new Set(hashes.filter((h) => chunks.has(key(namespace, h))));
      }),
    put: (namespace, sha256, bytes, signal) =>
      settle(() => {
        signal.throwIfAborted();
        chunks.set(key(namespace, sha256), {
          bytes: bytes.slice(),
          lastModified: new Date(),
        });
      }),
    get: (namespace, sha256, signal) =>
      settle(() => {
        signal.throwIfAborted();
        return chunks.get(key(namespace, sha256))?.bytes.slice() ?? null;
      }),
    touch: (namespace, hashes, signal) =>
      settle(() => {
        signal.throwIfAborted();
        const missing = new Set<string>();
        for (const sha256 of hashes) {
          const chunk = chunks.get(key(namespace, sha256));
          if (chunk === undefined) missing.add(sha256);
          else chunk.lastModified = new Date();
        }
        return missing;
      }),
    async *list(namespace, signal): AsyncIterable<StoredChunk> {
      signal.throwIfAborted();
      for (const [k, chunk] of [...chunks]) {
        if (k.startsWith(`${namespace}/`)) {
          yield {
            sha256: k.slice(namespace.length + 1),
            lastModified: new Date(chunk.lastModified),
          };
        }
      }
    },
    delete: (namespace, sha256, signal) =>
      settle(() => {
        signal.throwIfAborted();
        chunks.delete(key(namespace, sha256));
      }),
  };
  return {
    storage: () => storage,
    hasObject(objectKey) {
      const match = /^_blobs\/(.+)\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/
        .exec(objectKey);
      return match !== null && match[3].startsWith(match[2]) &&
        chunks.has(key(match[1], match[3]));
    },
    setChunkLastModified: (namespace, sha256, date) =>
      settle(() => {
        const chunk = chunks.get(key(namespace, sha256));
        if (chunk === undefined) {
          throw new Error(`No chunk ${key(namespace, sha256)}`);
        }
        chunk.lastModified = new Date(date);
      }),
  };
}
