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
 * The push functions (swamp-club#3055). Every push a CLI command or serve
 * handler makes is one of these, passed as a root unit of work's flush or
 * checkpoint; commands and handlers never call `pushChanged` themselves.
 * `PINNED_DIRECT_PUSHES` (`integration/datastore_write_seams_rules_test.ts`)
 * holds every production `pushChanged` call to this module, the coordinator,
 * and the deliberate exceptions.
 */

import {
  flushDatastoreSyncNamed,
  GLOBAL_LOCK_KEY,
} from "./datastore_sync_coordinator.ts";
import type { RootFlushOutcome } from "./repo_unit_of_work.ts";
import type {
  DatastoreSyncService,
  SyncContext,
} from "../../domain/datastore/datastore_sync_service.ts";

/**
 * Pushes and releases the global lock's coordinator entry when a command
 * that took the global lock ends, as the `flushDatastoreSync()` teardown in
 * `src/cli/mod.ts` did: a push error is logged at warn by the coordinator; a
 * `SyncTimeoutError` is thrown after the lock is released when the command
 * completed, and dropped when it failed, as the teardown's `catch {}` did, so
 * the command's error wins. A second call does nothing, and so does a call
 * when the command registered no global sync (a read-only or dry-run path).
 */
export async function pushGlobalLockAtEnd(
  outcome: RootFlushOutcome,
): Promise<void> {
  try {
    await flushDatastoreSyncNamed(GLOBAL_LOCK_KEY);
  } catch (error) {
    if (outcome.completed) throw error;
  }
}

/**
 * Pushes everything changed in `namespace`: the whole-namespace push a
 * command makes as its root's flush (workflow run and resume, access grant
 * and group, worker prune, the managed-config publish) or checkpoint (access
 * token mint, worker token create and revoke), or both (datastore config
 * migrate, which pushes the migrated files at a checkpoint and the sentinel
 * as the flush).
 */
export async function pushNamespace(
  syncService: Pick<DatastoreSyncService, "pushChanged">,
  namespace: string | undefined,
): Promise<void> {
  await syncService.pushChanged({ namespace });
}

/**
 * The single-phase push a model lock makes when it is released: scoped to
 * the locked models when the datastore supports scoped sync, otherwise the
 * namespace, or everything when there is none. Returns the count of files
 * pushed, as the sync service reports it.
 */
export function pushModelLockScope(
  syncService: Pick<DatastoreSyncService, "pushChanged">,
  scoped: boolean,
  models: ReadonlyArray<{ modelType: string; modelId: string }>,
  namespace: string | undefined,
): Promise<number | void> {
  if (scoped) {
    const context: SyncContext = { models: [...models] };
    return syncService.pushChanged({
      context,
      ...(namespace ? { namespace } : {}),
    });
  }
  if (namespace) return syncService.pushChanged({ namespace });
  return syncService.pushChanged();
}
