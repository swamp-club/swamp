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
 * every push a command or serve handler makes is one of these, passed as a
 * root's flush or checkpoint; commands never call pushChanged themselves
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
 * a SyncTimeoutError is thrown after the lock is released when the command
 * completed, and dropped when it failed so the command's error wins
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

export async function pushNamespace(
  syncService: Pick<DatastoreSyncService, "pushChanged">,
  namespace: string | undefined,
): Promise<void> {
  await pushNamespaceCounted(syncService, namespace);
}

export function pushNamespaceCounted(
  syncService: Pick<DatastoreSyncService, "pushChanged">,
  namespace: string | undefined,
  signal?: AbortSignal,
): Promise<number | void> {
  return syncService.pushChanged(
    signal === undefined ? { namespace } : { namespace, signal },
  );
}

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
