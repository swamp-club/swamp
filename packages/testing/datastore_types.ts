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
 * Extension-author-facing subset of swamp's datastore interfaces.
 *
 * These types mirror the interfaces that extension datastore implementations
 * actually use. A CI test in the main swamp repo verifies structural
 * compatibility with the canonical types.
 */

/** Procfile-style metadata stored in the lock. */
export interface LockInfo {
  holder: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  ttlMs: number;
  nonce?: string;
  holderUnknown?: true;
}

/** Configuration for lock behavior. */
export interface LockOptions {
  lockKey?: string;
  namespace?: string;
  ttlMs?: number;
  retryIntervalMs?: number;
  maxWaitMs?: number;
}

/** A distributed lock that can be acquired and released. */
export interface DistributedLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  inspect(): Promise<LockInfo | null>;
  forceRelease(expectedNonce: string): Promise<boolean>;
}

/** Result of a datastore health check. */
export interface DatastoreHealthResult {
  readonly healthy: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly datastoreType: string;
  readonly details?: Record<string, string>;
}

/** Interface for verifying datastore accessibility. */
export interface DatastoreVerifier {
  verify(): Promise<DatastoreHealthResult>;
}

/** Describes what a sync operation is about. */
export interface SyncContext {
  models?: ReadonlyArray<{ modelType: string; modelId: string }>;
}

/** Capabilities a sync service advertises to swamp core. */
export interface SyncCapabilities {
  scopedSync?: boolean;
  lazyHydration?: boolean;
  /** Supports namespace-scoped sync via `DatastoreSyncOptions.namespace`. */
  namespacedSync?: boolean;
  /** Supports two-phase push: `preparePush` then `commitPush`. */
  twoPhaseSync?: boolean;
  /** Supports a dry-run `previewPush`. */
  previewPush?: boolean;
  /** Supports a control-plane store for small remote records. */
  controlPlane?: boolean;
  /** Honors `DatastoreSyncOptions.subdirs` on `pullChanged`. */
  configRefresh?: boolean;
}

/** Options accepted by sync service methods. */
export interface DatastoreSyncOptions {
  signal?: AbortSignal;
  /**
   * Cache-relative path of the file about to be written or removed.
   * swamp core only sets this on `markDirty` calls; the field has no
   * defined meaning on `pullChanged` or `pushChanged`. Path is
   * forward-slash-normalized; extensions consuming it for disk access
   * on Windows must convert to native separators. See the canonical
   * `DatastoreSyncService.markDirty` JSDoc for the full contract.
   */
  relPath?: string;
  /** Domain-level sync context, passed when the extension advertises scopedSync. */
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

/** Options for `DatastoreSyncService.repairUnpushedFiles`. */
export interface RepairUnpushedFilesOptions {
  signal?: AbortSignal;
  namespace?: string;
  /** When `true`, report without uploading anything. */
  dryRun?: boolean;
  /** When `true`, compare content by sha256 where size and mtime cannot. */
  exact?: boolean;
}

/** Summary of `DatastoreSyncService.repairUnpushedFiles`. */
export interface UnpushedFilesSummary {
  /**
   * Files the remote has never received: every one found on a dry run, and
   * those still not uploaded on a real run.
   */
  unpushed: number;
  /** Up to 20 of them, cache-relative with forward slashes. */
  samplePaths: readonly string[];
  /** Local files whose key the remote holds with other bytes. */
  alreadyPresent: number;
  sampleAlreadyPresent: readonly string[];
  /** Local files whose content differs from their last-synced entry. */
  locallyModified: number;
  sampleModified: readonly string[];
  /** Local files that may differ from a last-synced entry with no sha256. */
  unknown: number;
  sampleUnknown: readonly string[];
  /** Last-synced keys the remote now holds with other content. */
  remoteMovedOn: number;
  /** Files uploaded and indexed. Zero when `dryRun` is `true`. */
  uploaded: number;
  /** Whether the cache holds marks a push has not sent yet. */
  pendingChanges: boolean;
}

/** Interface for datastore synchronization services. */
export interface DatastoreSyncService {
  pullChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  pushChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  /**
   * Drop the per-path marks whose keys equal `relPaths`, as `markDirty`
   * received them. Only marks made before the call are dropped; a parent's
   * or child's mark, a bulk mark and an overflowed path set are kept, and
   * nothing remote is touched. Swamp calls it after undoing a refused push's
   * writes (swamp-club#4091).
   */
  clearDirty?(relPaths: readonly string[]): Promise<void>;
  /** Advertise what this sync service supports. */
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
   * Read one file as the remote holds it, without touching the local cache.
   * Resolves to its bytes, or `null` when the remote has no such file; any
   * other failure rejects. `relPath` is cache-relative, as for `hydrateFile`,
   * so with a namespace it already starts with `{namespace}/`. A `relPath`
   * that is absolute or has a `..` segment is rejected.
   */
  fetchContent?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<Uint8Array | null>;
  /**
   * Find cache files the remote has never received and, unless `dryRun`,
   * upload them with create-only writes. Reports local versions the remote
   * lacks without uploading them, deletes nothing, and leaves dirty state
   * and the sync fingerprint alone. See the canonical
   * `DatastoreSyncService.repairUnpushedFiles` JSDoc for the full contract.
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
 * Direct read and write of small records in the datastore, bypassing the
 * cache and sync. Keys are slash-delimited paths such as `heartbeats/<id>`,
 * kept under `_control/` in the backend, below the namespace when one is
 * bound.
 *
 * `putIfAbsent` is optional on the interface, but a store without it cannot
 * hold the records of workflow signal waits: swamp refuses to start a
 * workflow that contains a `wait_for_signal` step on such a datastore.
 */
export interface ControlPlaneStore {
  /** Writes the record, replacing any that exists. */
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
  /** The keys under `prefix`, each in full, as passed to `put`. */
  list(prefix: string): Promise<string[]>;
}

/** Options for a control-plane read. */
export interface ControlPlaneReadOptions {
  /**
   * Cancels the read: stop the request in flight and any retry backoff, and
   * reject. Retrying until it aborts is fine.
   */
  readonly signal?: AbortSignal;
}

/**
 * Reads control-plane records at the datastore-wide `_control/` root,
 * whatever namespace a repository uses. Swamp reads the datastore format
 * marker (`datastore-format`) through it before a command opens the
 * datastore.
 *
 * It must bind no namespace and share no state with any sync service the
 * provider builds.
 */
export interface DatastoreControlPlaneStore {
  /**
   * The record at `_control/<key>`, or null only when no such record exists.
   * Every other failure, access denied included, rejects. Must reject when
   * `options.signal` aborts; for a sync service's `ControlPlaneStore`
   * honouring it is recommended, not required.
   */
  get(
    key: string,
    options?: ControlPlaneReadOptions,
  ): Promise<Uint8Array | null>;
}

/**
 * A {@link DatastoreControlPlaneStore} that can also write, at the same
 * datastore-wide `_control/` root. The v3 writer lease keeps its records
 * (`writer/`) here. Keys are relative to `_control/` at the datastore root;
 * writing binds no namespace and never touches `<namespace>/_control/`.
 * `assertWritableDatastoreControlPlaneStoreConformance` checks an
 * implementation.
 */
export interface WritableDatastoreControlPlaneStore
  extends DatastoreControlPlaneStore {
  /** Writes the record at `_control/<key>`, replacing any record there. */
  put(key: string, data: Uint8Array): Promise<void>;
  /**
   * Creates the record only if none is there; returns false, leaving the
   * existing record unchanged, when one is. Of concurrent creates of one
   * key, exactly one returns true.
   */
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  /** Removes the record; a missing record is no error. */
  delete(key: string): Promise<void>;
  /** The keys under `_control/<prefix>`, relative to `_control/`. */
  list(prefix: string): Promise<string[]>;
}

/**
 * Factory interface for user-defined datastores.
 *
 * Extension authors implement this interface to create custom datastore backends.
 */
export interface DatastoreProvider {
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  createVerifier(): DatastoreVerifier;
  createSyncService?(repoDir: string, cachePath: string): DatastoreSyncService;
  resolveDatastorePath(repoDir: string): string;
  /**
   * Resolve a local cache path for remote datastores.
   *
   * Optional at the type level, but note the runtime equivalence: every
   * consumer in swamp core invokes this as
   * `provider.resolveCachePath?.(repoDir) ?? <repoId-keyed default>`, so
   * omitting the method and defining it to return `undefined` both fall
   * back to `~/.swamp/repos/<repoId>`.
   *
   * The convention across all `@swamp/*` datastores is to define the
   * method and return `undefined` when no custom cache is desired, so the
   * intent ("I want core's default") is explicit to readers rather than
   * inferred from a missing property.
   */
  resolveCachePath?(repoDir: string): string | undefined;
  /**
   * Return a read-only store for the datastore-wide control plane. Building
   * it must be cheap: no sync service, no namespace binding and no request
   * until `get`, and a `get` should be one request with no credentials
   * preflight. Optional; without it swamp reads the format marker through a
   * fresh sync service's `controlPlaneStore()`. A v3-capable datastore
   * returns a {@link WritableDatastoreControlPlaneStore} and declares
   * {@link datastoreWideLease}.
   */
  datastoreControlPlaneStore?(): DatastoreControlPlaneStore;
  /**
   * `true` declares that no namespaced pull or push moves or copies
   * `_control/writer/` or `_control/lineage/`, so the v3 writer lease's and
   * replication lineages' records stay at the datastore root, and that `datastoreControlPlaneStore()` returns a
   * {@link WritableDatastoreControlPlaneStore}. Only the literal `true`
   * counts; without it swamp refuses to bind the lease. Check it with
   * `assertWritableDatastoreControlPlaneStoreConformance`, namespaced-push
   * case included.
   */
  readonly datastoreWideLease?: boolean;
  /**
   * Return the `storage/1` chunk storage for a v3 datastore, scoped to the
   * datastore root. Optional; swamp does not call it yet. Check an
   * implementation with `assertStorageConformance`.
   */
  storage?(): DatastoreStorage;
  /**
   * Where this datastore's v3 Litestream replica lives: the bucket, and the
   * key prefix of the datastore root that `storage()` and
   * `datastoreControlPlaneStore()` write under. Swamp appends
   * `_litestream/<fence>/` to the prefix; the provider never builds replica
   * paths.
   *
   * The target never carries credentials. Litestream resolves them from the
   * AWS SDK default chain (environment, shared config and SSO, container or
   * instance identity) or Google ADC, so a datastore whose credentials come
   * from anywhere else cannot be replicated. Throw, rather than return a
   * target Litestream cannot reach: a GCS datastore with a custom
   * `apiEndpoint`, for example, which Litestream has no equivalent for.
   * Swamp shows the thrown message to the user, so keep config values and
   * secrets out of it.
   *
   * Optional; swamp does not call it yet. Check an implementation with
   * `assertReplicaTargetConformance`.
   */
  replicaTarget?(): V3ReplicaTarget;

  /**
   * The Litestream lineage paths under the replica target's
   * `<prefix>/_litestream/`, so swamp can remove the path of a lineage a
   * takeover replaced. `storage/1` is chunk-keyed and cannot reach them. It
   * lists fence directories and removes one fence's objects; it never
   * touches anything outside `<prefix>/_litestream/<fence>/`, and refuses a
   * fence that is not the 12-digit padded form.
   *
   * Optional; swamp does not call it yet. Without it, a bucket replica keeps
   * every old lineage's path and records, and chunk collection stays
   * deferred while they are registered. Check an implementation with
   * `assertReplicaPathConformance`.
   */
  replicaPaths?(): ReplicaPathStore;
}

/**
 * The lineage paths of a datastore's Litestream replica: the fence
 * directories under `<prefix>/_litestream/`, where `<prefix>` is the
 * replica target's. A fence is always the 12-digit padded form swamp writes
 * (`000000000042`). Nothing outside `<prefix>/_litestream/<fence>/` is ever
 * listed or touched.
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
    /** An S3-compatible endpoint, as an http or https URL. */
    readonly endpoint?: string;
    /** Path-style addressing. Unset, it is on whenever `endpoint` is set. */
    readonly forcePathStyle?: boolean;
  }
  | {
    readonly type: "gcs";
    readonly bucket: string;
    readonly prefix: string;
  };

/** What a {@link DatastoreStorage} supports. */
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

/** One chunk, as {@link DatastoreStorage.list} reports it. */
export interface StoredChunk {
  readonly sha256: string;
  /** When the chunk was last put or touched. */
  readonly lastModified: Date;
}

/**
 * The `storage/1` contract: immutable chunks keyed by namespace and the
 * SHA-256 of their bytes, stored at
 * `<prefix>/_blobs/<namespace>/sha256/<first two hex>/<sha256>`.
 *
 * `namespace` is the repository's namespace slug, or `_default` for an
 * unnamespaced datastore (solo, or a team datastore with no namespace).
 * `sha256` is 64 lowercase hex characters. Swamp verifies every chunk it
 * reads, so the storage need not hash anything. Every method must reject
 * when `signal` aborts.
 */
export interface DatastoreStorage {
  readonly contract: "storage/1";
  capabilities(): StorageCapabilities;
  /** The subset of `hashes` stored in `namespace`. */
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
  /** Every chunk stored in `namespace`, in no particular order. */
  list(namespace: string, signal: AbortSignal): AsyncIterable<StoredChunk>;
  /** Removes the chunk; removing a missing chunk succeeds. */
  delete(namespace: string, sha256: string, signal: AbortSignal): Promise<void>;
}
