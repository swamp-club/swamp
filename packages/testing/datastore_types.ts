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
 * mirrors the interfaces extension datastore implementations use; a CI test in
 * the main swamp repo verifies structural compatibility with the canonical
 * types
 */

export interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  nonce?: string;
  holderUnknown?: true;
}

export interface LockOptions {
  lockKey?: string;
  namespace?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

export interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}

export interface DatastoreHealthResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly datastoreType: string;
  readonly details?: Record<string, string>;
}

export interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}

export interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

export interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  namespacedSync?: boolean;
  twoPhaseSync?: boolean;
  previewPush?: boolean;
  controlPlane?: boolean;
  configRefresh?: boolean;
}

export interface DatastoreSyncOptions {
  signal?: AbortSignal;
  /**
   * set by core only on markDirty calls; forward-slash-normalized, so convert
   * to native separators for disk access on Windows.
   */
  relPath?: string;
  context?: SyncContext;
  /**
   * When `true`, `pullChanged` should download only metadata files
   * and skip content (`raw`) files under `data/`. Set by swamp core
   * when `hydrationStrategy` is `"lazy"` on the initial pull.
   */
  metadataOnly?: boolean;
  /**
   * Namespace whose data subtree this sync operation targets. When unset,
   * the extension syncs everything.
   */
  namespace?: string;
  /**
   * Restricts `pullChanged` to the listed datastore subdirectories.
   * Extensions that advertise `configRefresh` should honor it; others may
   * ignore it and pull everything.
   */
  subdirs?: readonly string[];
}

export interface RepairUnpushedFilesOptions {
  signal?: AbortSignal;
  namespace?: string;
  dryRun?: boolean;
  exact?: boolean;
}

export interface UnpushedFilesSummary {
  /**
   * Files the remote has never received: every one found on a dry run, and
   * those still not uploaded on a real run.
   */
  unpushed: number;
  samplePaths: readonly string[];
  alreadyPresent: number;
  sampleAlreadyPresent: readonly string[];
  locallyModified: number;
  sampleModified: readonly string[];
  unknown: number;
  sampleUnknown: readonly string[];
  /**
   * Local files whose key a peer deleted after this cache synced it, which
   * the cache kept and recorded as peer-deleted. Never uploaded.
   */
  peerDeleted: number;
  samplePeerDeleted: readonly string[];
  remoteMovedOn: number;
  uploaded: number;
  pendingChanges: boolean;
}

export interface DatastoreSyncService {
  pullChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  pushChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  /**
   * drops the per-path marks equal to relPaths made before the call; a parent's
   * or child's mark, a bulk mark and an overflowed path set are kept, and
   * nothing remote is touched.
   */
  clearDirty?(relPaths: readonly string[]): Promise<void>;
  capabilities?(): SyncCapabilities;
  /**
   * Download a single file from the remote datastore by cache-relative path.
   * Used for transparent content hydration when `hydrationStrategy` is `"lazy"`.
   * Return `true` only once the file is at `relPath` under the cache: swamp
   * checks, and fails the read with a contract violation error if it is not.
   */
  hydrateFile?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<boolean>;
  /**
   * reads one file as the remote holds it without touching the cache; null when
   * the remote has none, any other failure rejects. relPath is cache-relative;
   * absolute or `..` paths are rejected.
   */
  fetchContent?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<Uint8Array | null>;
  /**
   * uploads cache files the remote has never received with create-only writes
   * unless dryRun; reports differing local versions without uploading, deletes
   * nothing, leaves dirty state and fingerprint alone.
   */
  repairUnpushedFiles?(
    options?: RepairUnpushedFilesOptions,
  ): Promise<UnpushedFilesSummary>;
  /**
   * Return a store for small control-plane records, read and written in
   * the datastore directly. Required when `capabilities().controlPlane` is
   * true.
   */
  controlPlaneStore?(): ControlPlaneStore;
}

/**
 * direct read and write of small records, bypassing cache and sync; keys are
 * slash-delimited paths kept under `_control/`. Without putIfAbsent, swamp
 * refuses workflows with a wait_for_signal step.
 */
export interface ControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  /**
   * Creates the record only if the key holds none, atomically: of any
   * number of concurrent creates of one key, exactly one returns true. A
   * record that exists is left unchanged.
   */
  putIfAbsent?(key: string, data: Uint8Array): Promise<boolean>;
  /**
   * The record, or null when the key holds none. Honour `options.signal`
   * by stopping the request and any retry backoff when it aborts.
   */
  get(
    key: string,
    options?: ControlPlaneReadOptions,
  ): Promise<Uint8Array | null>;
  /** Removes the record. Removing a key that holds none is not an error. */
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface ControlPlaneReadOptions {
  /**
   * Cancels the read: stop the request in flight and any retry backoff, and
   * reject. Retrying until it aborts is fine.
   */
  readonly signal?: AbortSignal;
}

/**
 * reads control-plane records at the datastore-wide `_control/` root, whatever
 * the namespace; it must bind no namespace and share no state with any sync
 * service the provider builds.
 */
export interface DatastoreControlPlaneStore {
  /**
   * the record at `_control/<key>`, or null only when none exists; every other
   * failure, access denied included, rejects. Must reject when the signal
   * aborts.
   */
  get(
    key: string,
    options?: ControlPlaneReadOptions,
  ): Promise<Uint8Array | null>;
}

/**
 * a DatastoreControlPlaneStore that can also write at the datastore-wide
 * `_control/` root, where the v3 writer lease keeps its records; writing binds
 * no namespace and never touches `<namespace>/_control/`.
 */
export interface WritableDatastoreControlPlaneStore
  extends DatastoreControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  /**
   * Creates the record only if none is there; returns false, leaving the
   * existing record unchanged, when one is. Of concurrent creates of one
   * key, exactly one returns true.
   */
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface DatastoreProvider {
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  createVerifier(): DatastoreVerifier;
  createSyncService?(repoDir: string, cachePath: string): DatastoreSyncService;
  resolveDatastorePath(repoDir: string): string;
  /**
   * omitting this and returning undefined both fall back to the default cache
   * under ~/.swamp/repos/<repoId>; the @swamp/* convention is to define it and
   * return undefined so the intent is explicit.
   */
  resolveCachePath?(repoDir: string): string | undefined;
  /**
   * read-only store for the datastore-wide control plane; building it must be
   * cheap, with no sync service, namespace binding or request until `get`.
   * Without it swamp reads the format marker through a sync service.
   */
  datastoreControlPlaneStore?(): DatastoreControlPlaneStore;
  /**
   * only the literal `true` counts: it declares namespaced pull and push never move
   * `_control/writer/` or `_control/lineage/`, and that datastoreControlPlaneStore()
   * is writable. Without it swamp refuses to bind the lease.
   */
  readonly datastoreWideLease?: boolean;
  /**
   * the `storage/1` chunk storage for a v3 datastore, scoped to the datastore
   * root; check with assertStorageConformance.
   */
  storage?(): DatastoreStorage;
  /**
   * swamp appends _litestream/<fence>/ to the prefix; the target carries no
   * credentials, so throw if the datastore's are outside the default chain,
   * keeping secrets out of the message
   */
  replicaTarget?(): V3ReplicaTarget;

  /**
   * the Litestream lineage paths under `<prefix>/_litestream/`, so swamp can
   * remove a replaced lineage's path; never touches anything outside one fence
   * directory and refuses a fence not in 12-digit padded form.
   */
  replicaPaths?(): ReplicaPathStore;
}

/**
 * the fence directories under the replica target's `<prefix>/_litestream/`; a
 * fence is always the 12-digit padded form, and nothing outside a fence
 * directory is listed or touched.
 */
export interface ReplicaPathStore {
  /**
   * The fence directories present under `<prefix>/_litestream/`, without
   * their trailing slash, in any order. A directory whose name is not a
   * fence may be returned; swamp ignores it.
   */
  list(signal: AbortSignal): Promise<string[]>;

  /**
   * Deletes every object under `<prefix>/_litestream/<fence>/`, paging
   * through listings, and resolves once none is left. Resolves when nothing
   * is there. Throws, deleting nothing, when `fence` is not exactly 12
   * digits from `000000000001`.
   */
  removePath(fence: string, signal: AbortSignal): Promise<void>;
}

/**
 * A datastore's Litestream replica, as `DatastoreProvider.replicaTarget()`
 * returns it. `prefix` is the datastore root's key prefix: no leading or
 * trailing slash, or empty.
 */
export type V3ReplicaTarget =
  | {
    readonly type: "s3";
    readonly bucket: string;
    readonly prefix: string;
    readonly region?: string;
    readonly endpoint?: string;
    /** Path-style addressing. Unset, it is on whenever `endpoint` is set. */
    readonly forcePathStyle?: boolean;
  }
  | {
    readonly type: "gcs";
    readonly bucket: string;
    readonly prefix: string;
  };

export interface StorageCapabilities {
  /**
   * The largest chunk the backend stores, in bytes. Swamp cuts chunks of
   * `min(16 MiB, maxChunkBytes)`.
   */
  readonly maxChunkBytes: number;
  /**
   * True when the storage implements `touch`. Without it, swamp puts a
   * chunk it found present again, which refreshes it the same way.
   */
  readonly touch: boolean;
}

export interface StoredChunk {
  readonly sha256: string;
  readonly lastModified: Date;
}

/**
 * immutable chunks keyed by namespace and SHA-256; namespace is _default when
 * unnamespaced. Swamp verifies every chunk it reads, and every method must
 * reject when the signal aborts
 */
export interface DatastoreStorage {
  readonly contract: "storage/1";
  capabilities(): StorageCapabilities;
  has(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>>;
  /**
   * Stores `bytes` under `sha256`, replacing any chunk already there, and
   * sets its `lastModified` to now. A reader never sees a partial chunk, and
   * concurrent puts of one hash leave one complete chunk.
   */
  put(
    namespace: string,
    sha256: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  /** The chunk's bytes, or null only when no such chunk exists. */
  get(
    namespace: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
  /**
   * Sets `lastModified` to now for each of `hashes` that is stored, and
   * returns the ones that are not. Present exactly when
   * `capabilities().touch` is true.
   */
  touch?(
    namespace: string,
    hashes: readonly string[],
    signal: AbortSignal,
  ): Promise<Set<string>>;
  list(namespace: string, signal: AbortSignal): AsyncIterable<StoredChunk>;
  /** Removes the chunk; removing a missing chunk succeeds. */
  delete(namespace: string, sha256: string, signal: AbortSignal): Promise<void>;
}
