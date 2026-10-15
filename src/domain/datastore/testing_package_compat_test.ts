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
 * Type compatibility test for @swamp-club/swamp-testing datastore types.
 *
 * Verifies that the testing package's datastore types remain structurally
 * compatible with swamp's canonical types. If someone changes the canonical
 * interfaces, this file will fail to type-check.
 */

import type { DatastoreProvider as CanonicalDatastoreProvider } from "./datastore_provider.ts";
import type {
  ControlPlaneStore as CanonicalControlPlaneStore,
  DatastoreControlPlaneStore as CanonicalDatastoreControlPlaneStore,
  WritableDatastoreControlPlaneStore
    as CanonicalWritableDatastoreControlPlaneStore,
} from "./control_plane_store.ts";
import type {
  DatastoreStorage as CanonicalDatastoreStorage,
  StorageCapabilities as CanonicalStorageCapabilities,
  StoredChunk as CanonicalStoredChunk,
} from "./datastore_storage.ts";
import type { V3ReplicaTarget as CanonicalV3ReplicaTarget } from "./replica_target.ts";
import type { ReplicaPathStore as CanonicalReplicaPathStore } from "./replica_path_store.ts";
import type { DistributedLock as CanonicalDistributedLock } from "./distributed_lock.ts";
import type { DatastoreVerifier as CanonicalDatastoreVerifier } from "./datastore_health.ts";
import type {
  DatastoreSyncService as CanonicalDatastoreSyncService,
  SyncCapabilities as CanonicalSyncCapabilities,
} from "./datastore_sync_service.ts";

import type {
  ControlPlaneStore as TestingControlPlaneStore,
  DatastoreControlPlaneStore as TestingDatastoreControlPlaneStore,
  DatastoreProvider as TestingDatastoreProvider,
  DatastoreStorage as TestingDatastoreStorage,
  DatastoreSyncService as TestingDatastoreSyncService,
  DatastoreVerifier as TestingDatastoreVerifier,
  DistributedLock as TestingDistributedLock,
  LockInfo as TestingLockInfo,
  ReplicaPathStore as TestingReplicaPathStore,
  StorageCapabilities as TestingStorageCapabilities,
  StoredChunk as TestingStoredChunk,
  SyncCapabilities as TestingSyncCapabilities,
  V3ReplicaTarget as TestingV3ReplicaTarget,
  WritableDatastoreControlPlaneStore
    as TestingWritableDatastoreControlPlaneStore,
} from "../../../packages/testing/datastore_types.ts";

// DistributedLock: verify method signatures match.
function _checkDistributedLockFields(lock: TestingDistributedLock) {
  const _acquire: ReturnType<CanonicalDistributedLock["acquire"]> = lock
    .acquire();
  const _release: ReturnType<CanonicalDistributedLock["release"]> = lock
    .release();
  const _inspect: ReturnType<CanonicalDistributedLock["inspect"]> = lock
    .inspect();
  const _forceRelease: ReturnType<CanonicalDistributedLock["forceRelease"]> =
    lock.forceRelease("nonce");

  // withLock — verify it exists and returns a Promise
  const _withLock: Promise<void> = lock.withLock(() => Promise.resolve());

  void [_acquire, _release, _inspect, _forceRelease, _withLock];
}

// DatastoreVerifier: verify method signature matches.
function _checkDatastoreVerifierFields(verifier: TestingDatastoreVerifier) {
  const _verify: ReturnType<CanonicalDatastoreVerifier["verify"]> = verifier
    .verify();
  void [_verify];
}

// DatastoreSyncService: verify method signatures match.
function _checkDatastoreSyncServiceFields(sync: TestingDatastoreSyncService) {
  const _pull: ReturnType<CanonicalDatastoreSyncService["pullChanged"]> = sync
    .pullChanged();
  const _push: ReturnType<CanonicalDatastoreSyncService["pushChanged"]> = sync
    .pushChanged();
  const _markDirty: ReturnType<CanonicalDatastoreSyncService["markDirty"]> =
    sync.markDirty();
  // Verify the optional relPath member on DatastoreSyncOptions type-checks
  // through both the canonical and testing-package signatures.
  const _markDirtyWithRelPath: ReturnType<
    CanonicalDatastoreSyncService["markDirty"]
  > = sync.markDirty({ relPath: "data/foo/v1/raw" });
  // The namespace and subdirs options and every capability flag line up
  // with the canonical types.
  const _scopedPull: ReturnType<CanonicalDatastoreSyncService["pullChanged"]> =
    sync.pullChanged({ namespace: "ns", subdirs: ["config"] });
  const _caps:
    | ReturnType<
      NonNullable<CanonicalDatastoreSyncService["capabilities"]>
    >
    | undefined = sync.capabilities?.();
  const _testingCaps: TestingSyncCapabilities | undefined = (
    {} as CanonicalDatastoreSyncService
  ).capabilities?.();
  // fetchContent has one signature in both packages, in both directions.
  const _fetchContent: CanonicalDatastoreSyncService["fetchContent"] =
    sync.fetchContent;
  const _testingFetchContent: TestingDatastoreSyncService["fetchContent"] = (
    {} as CanonicalDatastoreSyncService
  ).fetchContent;
  void [
    _fetchContent,
    _testingFetchContent,
    _pull,
    _push,
    _markDirty,
    _markDirtyWithRelPath,
    _scopedPull,
    _caps,
    _testingCaps,
  ];
}

// SyncCapabilities: every canonical flag exists on the testing type.
function _checkSyncCapabilitiesFields(caps: Required<TestingSyncCapabilities>) {
  const _all: Required<CanonicalSyncCapabilities> = caps;
  void [_all];
}

// DatastoreProvider: verify methods exist and return compatible types.
function _checkDatastoreProviderFields(provider: TestingDatastoreProvider) {
  const _lock: TestingDistributedLock = provider.createLock("/path");
  const _verifier: TestingDatastoreVerifier = provider.createVerifier();
  const _path: string = provider.resolveDatastorePath("/repo");

  // Optional methods — verify they exist on the type
  const _createSync: CanonicalDatastoreProvider["createSyncService"] =
    provider.createSyncService;
  const _resolveCachePath: CanonicalDatastoreProvider["resolveCachePath"] =
    provider.resolveCachePath;
  const _datastoreControlPlane: CanonicalDatastoreProvider[
    "datastoreControlPlaneStore"
  ] = provider.datastoreControlPlaneStore;
  const _storage: CanonicalDatastoreProvider["storage"] = provider.storage;
  // The v3 writer lease declaration, in both directions.
  const _datastoreWideLease: CanonicalDatastoreProvider["datastoreWideLease"] =
    provider.datastoreWideLease;
  const _testingDatastoreWideLease: TestingDatastoreProvider[
    "datastoreWideLease"
  ] = ({} as CanonicalDatastoreProvider).datastoreWideLease;
  // The replica target, in both directions.
  const _replicaTarget: CanonicalDatastoreProvider["replicaTarget"] =
    provider.replicaTarget;
  const _testingReplicaTarget: TestingDatastoreProvider["replicaTarget"] = (
    {} as CanonicalDatastoreProvider
  ).replicaTarget;
  // The replica paths, in both directions.
  const _replicaPaths: CanonicalDatastoreProvider["replicaPaths"] =
    provider.replicaPaths;
  const _testingReplicaPaths: TestingDatastoreProvider["replicaPaths"] = (
    {} as CanonicalDatastoreProvider
  ).replicaPaths;

  void [
    _replicaTarget,
    _testingReplicaTarget,
    _replicaPaths,
    _testingReplicaPaths,
    _lock,
    _verifier,
    _path,
    _createSync,
    _resolveCachePath,
    _datastoreControlPlane,
    _storage,
    _datastoreWideLease,
    _testingDatastoreWideLease,
  ];
}

// Storage: the storage/1 types line up in both directions, so a storage
// written against the testing types is one core can use and vice versa.
function _checkDatastoreStorage(
  storage: TestingDatastoreStorage,
  caps: TestingStorageCapabilities,
  chunk: TestingStoredChunk,
) {
  const _storage: CanonicalDatastoreStorage = storage;
  const _back: TestingDatastoreStorage = {} as CanonicalDatastoreStorage;
  const _caps: CanonicalStorageCapabilities = caps;
  const _capsBack: TestingStorageCapabilities =
    {} as CanonicalStorageCapabilities;
  const _chunk: CanonicalStoredChunk = chunk;
  const _chunkBack: TestingStoredChunk = {} as CanonicalStoredChunk;
  void [_storage, _back, _caps, _capsBack, _chunk, _chunkBack];
}

// Replica targets: one written against the testing type is one core can
// use, and vice versa.
function _checkV3ReplicaTarget(target: TestingV3ReplicaTarget) {
  const _target: CanonicalV3ReplicaTarget = target;
  const _back: TestingV3ReplicaTarget = {} as CanonicalV3ReplicaTarget;
  void [_target, _back];
}

// Replica path stores: one written against the testing type is one core
// can use, and vice versa.
function _checkReplicaPathStore(store: TestingReplicaPathStore) {
  const _store: CanonicalReplicaPathStore = store;
  const _back: TestingReplicaPathStore = {} as CanonicalReplicaPathStore;
  void [_store, _back];
}

// Control-plane stores: a store written against the testing types is one
// core can use, read options included.
function _checkControlPlaneStores(
  store: TestingControlPlaneStore,
  datastoreStore: TestingDatastoreControlPlaneStore,
) {
  const _store: CanonicalControlPlaneStore = store;
  const _datastoreStore: CanonicalDatastoreControlPlaneStore = datastoreStore;
  const _read: ReturnType<CanonicalControlPlaneStore["get"]> = store.get("k", {
    signal: AbortSignal.abort(),
  });
  void [_store, _datastoreStore, _read];
}

// The writable datastore-wide store lines up in both directions, and is a
// read-only one too.
function _checkWritableDatastoreControlPlaneStore(
  store: TestingWritableDatastoreControlPlaneStore,
) {
  const _store: CanonicalWritableDatastoreControlPlaneStore = store;
  const _back: TestingWritableDatastoreControlPlaneStore =
    {} as CanonicalWritableDatastoreControlPlaneStore;
  const _readOnly: CanonicalDatastoreControlPlaneStore = store;
  void [_store, _back, _readOnly];
}

// LockInfo: verify field types match.
function _checkLockInfoFields(info: TestingLockInfo) {
  const _holder: string = info.holder;
  const _hostname: string = info.hostname;
  const _pid: number = info.pid;
  const _acquiredAt: string = info.acquiredAt;
  const _ttlMs: number = info.ttlMs;
  const _nonce: string | undefined = info.nonce;
  const _holderUnknown: true | undefined = info.holderUnknown;

  void [
    _holder,
    _hostname,
    _pid,
    _acquiredAt,
    _ttlMs,
    _nonce,
    _holderUnknown,
  ];
}

Deno.test("testing package datastore types: compile-time compatibility check", () => {
  void [
    _checkDistributedLockFields,
    _checkDatastoreVerifierFields,
    _checkDatastoreSyncServiceFields,
    _checkSyncCapabilitiesFields,
    _checkDatastoreProviderFields,
    _checkControlPlaneStores,
    _checkWritableDatastoreControlPlaneStore,
    _checkDatastoreStorage,
    _checkV3ReplicaTarget,
    _checkReplicaPathStore,
    _checkLockInfoFields,
  ];
});
