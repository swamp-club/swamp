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

import type { DistributedLock, LockOptions } from "./distributed_lock.ts";
import type { DatastoreVerifier } from "./datastore_health.ts";
import type { DatastoreSyncService } from "./datastore_sync_service.ts";

/**
 * Declares which optional features a datastore provider supports.
 * Absent or returning an empty object means no optional features —
 * core uses the conservative default behavior for everything.
 */
export interface DatastoreCapabilities {
  /**
   * When true, the provider's sync service handles scoped push/pull
   * correctly and its lock implementation supports concurrent per-scope
   * writes without a global coordination point.
   *
   * Core uses this to decide whether per-model push needs the global
   * lock. When true: per-model push passes `scope` and uses only the
   * per-model lock. When false/absent: per-model push acquires the
   * global lock and syncs without scope (current behavior).
   *
   * SAFETY INVARIANT: declaring scopedSync: true is a promise that
   * concurrent scoped pushes to non-overlapping scopes cannot corrupt
   * shared state. If an extension declares scopedSync: true but cannot
   * honor it, concurrent pushes will corrupt the remote datastore.
   * This is a hard contract, not a performance hint.
   */
  scopedSync?: boolean;
}

/**
 * Factory interface for user-defined datastores.
 *
 * Implementations provide the components needed to operate a datastore:
 * locking, health verification, optional sync, and path resolution.
 */
export interface DatastoreProvider {
  /** Create a distributed lock for the datastore. */
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  /** Create a health verifier for the datastore. */
  createVerifier(): DatastoreVerifier;
  /** Optionally create a sync service for remote datastores. */
  createSyncService?(repoDir: string, cachePath: string): DatastoreSyncService;
  /** Resolve the datastore path relative to the repository. */
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
   * Declares which optional features this provider supports.
   * Absent or returning an empty object means no optional features —
   * core uses the conservative default behavior for everything.
   */
  capabilities?(): DatastoreCapabilities;
}
