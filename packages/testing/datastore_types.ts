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

/** Interface for datastore synchronization services. */
export interface DatastoreSyncService {
  pullChanged(): Promise<number | void>;
  pushChanged(): Promise<number | void>;
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
  resolveCachePath?(repoDir: string): string | undefined;
}
