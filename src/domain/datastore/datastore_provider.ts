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
  /** Optionally resolve a local cache path for remote datastores. */
  resolveCachePath?(repoDir: string): string | undefined;
}
