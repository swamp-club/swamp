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
import type { DistributedLock as CanonicalDistributedLock } from "./distributed_lock.ts";
import type { DatastoreVerifier as CanonicalDatastoreVerifier } from "./datastore_health.ts";
import type { DatastoreSyncService as CanonicalDatastoreSyncService } from "./datastore_sync_service.ts";

import type {
  DatastoreProvider as TestingDatastoreProvider,
  DatastoreSyncService as TestingDatastoreSyncService,
  DatastoreVerifier as TestingDatastoreVerifier,
  DistributedLock as TestingDistributedLock,
  LockInfo as TestingLockInfo,
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
  void [_pull, _push, _markDirty, _markDirtyWithRelPath];
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

  void [_lock, _verifier, _path, _createSync, _resolveCachePath];
}

// LockInfo: verify field types match.
function _checkLockInfoFields(info: TestingLockInfo) {
  const _holder: string = info.holder;
  const _hostname: string = info.hostname;
  const _pid: number = info.pid;
  const _acquiredAt: string = info.acquiredAt;
  const _ttlMs: number = info.ttlMs;
  const _nonce: string | undefined = info.nonce;

  void [_holder, _hostname, _pid, _acquiredAt, _ttlMs, _nonce];
}

Deno.test("testing package datastore types: compile-time compatibility check", () => {
  void [
    _checkDistributedLockFields,
    _checkDatastoreVerifierFields,
    _checkDatastoreSyncServiceFields,
    _checkDatastoreProviderFields,
    _checkLockInfoFields,
  ];
});
