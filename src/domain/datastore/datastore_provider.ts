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
   * Return a read-only {@link DatastoreControlPlaneStore} for the
   * datastore-wide control plane (`_control/` at the datastore root).
   *
   * Core reads the datastore format marker through it before a command
   * opens the datastore, so building it must be cheap: no sync service, no
   * namespace binding and no request until `get`. A `get` should be one
   * request, with no separate credentials preflight.
   *
   * Optional — when omitted, core reads the marker through a fresh sync
   * service's `controlPlaneStore()` instead, which costs a sync service and
   * relies on that service not having bound a namespace yet.
   *
   * A provider may return a `WritableDatastoreControlPlaneStore`. The
   * v3 writer lease needs one, so a v3-capable datastore must, and must
   * also declare {@link datastoreWideLease}: the store's shape alone does
   * not show that its records stay at the root.
   */
  datastoreControlPlaneStore?(): DatastoreControlPlaneStore;

  /**
   * `true` declares that this datastore can hold the v3 writer lease: no
   * namespaced pull or push moves or copies the records under
   * `_control/writer/` or `_control/lineage/`, so they stay at the datastore
   * root whatever namespace a checkout syncs, and
   * {@link datastoreControlPlaneStore} returns a
   * `WritableDatastoreControlPlaneStore`. The replication lineages live
   * under `lineage/` (swamp-club#3482): one moved into a namespace would
   * hide the published head a restore reads. It promises nothing about any
   * other `_control/` record.
   *
   * Only the literal `true` declares it. Without it swamp refuses to bind
   * the lease, since a push that moved `_control/writer/` into a namespace
   * would let a second writer take a fence already in use (swamp-club#3414).
   * Declare it only in a release whose push skips `_control/writer/` and
   * `_control/lineage/`, and
   * check it with `assertWritableDatastoreControlPlaneStoreConformance`,
   * namespaced-push case included.
   */
  readonly datastoreWideLease?: boolean;

  /**
   * Return the `storage/1` chunk storage for a v3 datastore
   * ({@link DatastoreStorage}), scoped to the datastore root like
   * {@link datastoreControlPlaneStore}.
   *
   * Optional — swamp does not call it yet. The v3 opt-in will require it.
   */
  storage?(): DatastoreStorage;

  /**
   * Where this datastore's v3 Litestream replica lives
   * ({@link V3ReplicaTarget}): the bucket, and the key prefix of the
   * datastore root that {@link storage} and
   * {@link datastoreControlPlaneStore} write under. Core appends
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
   * Optional — swamp does not call it yet (swamp-club#3507). The v3 opt-in
   * will require it. Check an implementation with
   * `assertReplicaTargetConformance`.
   */
  replicaTarget?(): V3ReplicaTarget;

  /**
   * The Litestream lineage paths under the replica target's
   * `<prefix>/_litestream/` ({@link ReplicaPathStore}), so swamp can remove
   * the path of a lineage a takeover replaced. `storage/1` is chunk-keyed
   * and cannot reach them. It lists fence directories and removes one
   * fence's objects; it never touches anything outside
   * `<prefix>/_litestream/<fence>/`, and refuses a fence that is not the
   * 12-digit padded form.
   *
   * Optional — swamp does not call it yet (swamp-club#3531). Without it, a
   * bucket replica keeps every old lineage's path and records, and chunk
   * collection stays deferred while they are registered. Check an
   * implementation with `assertReplicaPathConformance`.
   */
  replicaPaths?(): ReplicaPathStore;

  /**
   * Register a namespace in the datastore.
   *
   * Writes a namespace manifest so the namespace is discoverable by
   * `listNamespaces`. Fails if the slug is already claimed.
   *
   * Optional — solo-mode backends that don't support namespaces omit this.
   */
  registerNamespace?(
    datastorePath: string,
    namespace: string,
    repoId: string,
  ): Promise<void>;

  /**
   * List all registered namespaces in the datastore.
   *
   * Returns the namespace slugs discovered from namespace manifests.
   * An empty array means solo mode (no namespaces registered).
   *
   * Optional — solo-mode backends that don't support namespaces omit this.
   */
  listNamespaces?(datastorePath: string): Promise<string[]>;
}
