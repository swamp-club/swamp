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
  runBoundedSync,
  warnDroppedPushFailure,
} from "./datastore_sync_coordinator.ts";
import {
  type DatastoreConfig,
  resolveEnvSyncTimeoutMs,
  resolveSyncTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import type { RootFlushOutcome } from "./repo_unit_of_work.ts";
import type {
  DatastoreSyncService,
  SyncContext,
} from "../../domain/datastore/datastore_sync_service.ts";

/**
 * a failed push is thrown after the lock is released when the command
 * completed, and only logged when it failed so the command's error wins
 */
export async function pushGlobalLockAtEnd(
  outcome: RootFlushOutcome,
): Promise<void> {
  try {
    await flushDatastoreSyncNamed(GLOBAL_LOCK_KEY);
  } catch (error) {
    if (outcome.completed) throw error;
    warnDroppedPushFailure(error);
  }
}

export interface PushBound {
  readonly label: string;
  readonly timeoutMs: number;
}

export function pushBoundOf(config: DatastoreConfig): PushBound {
  return { label: config.type, timeoutMs: resolveSyncTimeoutMs(config) };
}

/** without a bound it takes the environment's sync timeout, never none */
export async function pushNamespace(
  syncService: Pick<DatastoreSyncService, "pushChanged">,
  namespace: string | undefined,
  bound: PushBound = {
    label: "datastore",
    timeoutMs: resolveEnvSyncTimeoutMs(),
  },
): Promise<void> {
  await runBoundedSync(
    bound.label,
    "push",
    bound.timeoutMs,
    (signal) => pushNamespaceCounted(syncService, namespace, signal),
  );
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
  signal?: AbortSignal,
): Promise<number | void> {
  const bounded = signal === undefined ? {} : { signal };
  if (scoped) {
    const context: SyncContext = { models: [...models] };
    return syncService.pushChanged({
      context,
      ...(namespace ? { namespace } : {}),
      ...bounded,
    });
  }
  if (namespace) return syncService.pushChanged({ namespace, ...bounded });
  return syncService.pushChanged(signal === undefined ? undefined : bounded);
}
