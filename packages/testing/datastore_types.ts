// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
}

/** Configuration for lock behavior. */
export interface LockOptions {
  lockKey?: string;
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
}

/** Interface for datastore synchronization services. */
export interface DatastoreSyncService {
  pullChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  pushChanged(options?: DatastoreSyncOptions): Promise<number | void>;
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  /** Advertise what this sync service supports. */
  capabilities?(): SyncCapabilities;
  /**
   * Download a single file from the remote datastore by cache-relative path.
   * Used for transparent content hydration when `hydrationStrategy` is `"lazy"`.
   */
  hydrateFile?(
    relPath: string,
    options?: DatastoreSyncOptions,
  ): Promise<boolean>;
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
}
