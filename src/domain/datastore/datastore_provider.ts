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

import type { DistributedLock, LockOptions } from "./distributed_lock.ts";
import type { DatastoreVerifier } from "./datastore_health.ts";
import type { DatastoreSyncService } from "./datastore_sync_service.ts";
import type { DatastoreControlPlaneStore } from "./control_plane_store.ts";
import type { DatastoreStorage } from "./datastore_storage.ts";
import type { V3ReplicaTarget } from "./replica_target.ts";
import type { ReplicaPathStore } from "./replica_path_store.ts";

export interface DatastoreProvider {
  createLock(datastorePath: string, options?: LockOptions): DistributedLock;
  createVerifier(): DatastoreVerifier;
  createSyncService?(repoDir: string, cachePath: string): DatastoreSyncService;
  resolveDatastorePath(repoDir: string): string;
  /**
   * omitting the method and returning undefined both fall back to
   * ~/.swamp/repos/<repoId>; @swamp/* datastores define it and return undefined
   * so the intent is explicit
   */
  resolveCachePath?(repoDir: string): string | undefined;

  /**
   * must be cheap, as core reads the format marker through it before a command
   * opens the datastore: no sync service, namespace binding or request until
   * get. A v3-capable datastore returns a writable store
   */
  datastoreControlPlaneStore?(): DatastoreControlPlaneStore;

  /**
   * only the literal true declares it: no namespaced pull or push moves
   * _control/writer/ or lineage/. Without it swamp refuses to bind the lease,
   * as a moved writer record would let a second writer take a used fence
   */
  readonly datastoreWideLease?: boolean;

  storage?(): DatastoreStorage;

  /**
   * never carries credentials (Litestream uses the AWS SDK default chain or
   * Google ADC); throw rather than return a target Litestream cannot reach, and
   * keep config values and secrets out of the shown message
   */
  replicaTarget?(): V3ReplicaTarget;

  /**
   * storage/1 cannot reach lineage paths; this lists fence directories and
   * removes one fence's objects under <prefix>/_litestream/<fence>/ only,
   * refusing a fence not in 12-digit padded form
   */
  replicaPaths?(): ReplicaPathStore;

  /**
   * fails if the slug is already claimed; optional, solo-mode backends that do
   * not support namespaces omit it
   */
  registerNamespace?(
    datastorePath: string,
    namespace: string,
    repoId: string,
  ): Promise<void>;

  /** an empty array means solo mode (no namespaces registered) */
  listNamespaces?(datastorePath: string): Promise<string[]>;
}
