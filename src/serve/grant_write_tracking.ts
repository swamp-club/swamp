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

import {
  type AdminGrantStore,
  createAdminGrantStore,
} from "../domain/access/admin_materializer.ts";
import {
  createFileGrantStore,
  type FileGrantStore,
  GRANT_DATA_NAME,
} from "../domain/access/grant_file_reconciler.ts";
import type {
  DatastoreSyncService,
  MarkDirtyHook,
} from "../domain/datastore/datastore_sync_service.ts";
import type { DefinitionRepository } from "../domain/definitions/repositories.ts";
import { GRANT_MODEL_TYPE } from "../domain/models/access/grant_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { type SyncGate, withSyncGate } from "./sync_gate.ts";
import type { FileSystemUnifiedDataRepository } from "../infrastructure/persistence/unified_data_repository.ts";
import { stageWritesThenPush } from "./stage_writes_then_push.ts";
import { pushNamespace } from "../infrastructure/persistence/push_paths.ts";

const logger = getSwampLogger(["serve", "grant-write-tracking"]);

/**
 * File and admin grant stores that record every path they write, so serve
 * can push the grant writes of its startup reconcile and of the grants
 * auto-reload the way `access.reload` pushes its own. Without the push, a
 * second instance on the same datastore never sees the first one's grants
 * and creates its own copies (swamp-club#2822).
 */
export interface GrantWriteTracking {
  readonly fileGrantStore: FileGrantStore;
  readonly adminGrantStore: AdminGrantStore;
  /** Returns the paths written since the last call, and forgets them. */
  takeWrittenPaths(): string[];
}

export function createGrantWriteTracking(
  readRepo: DefinitionRepository,
  writeRepo: DefinitionRepository,
  dataRepo: FileSystemUnifiedDataRepository,
): GrantWriteTracking {
  let writtenPaths: string[] = [];
  const recordPath = (path: string) => writtenPaths.push(path);
  const recordGrantData = (modelId: string) =>
    recordPath(
      dataRepo.getDataNameDir(GRANT_MODEL_TYPE, modelId, GRANT_DATA_NAME),
    );

  const fileStore = createFileGrantStore(
    readRepo,
    writeRepo,
    dataRepo,
    recordPath,
  );
  const adminStore = createAdminGrantStore(
    readRepo,
    writeRepo,
    dataRepo,
    recordPath,
  );

  return {
    fileGrantStore: {
      ...fileStore,
      async writeGrant(modelId, instanceName, grant) {
        await fileStore.writeGrant(modelId, instanceName, grant);
        recordGrantData(modelId);
      },
    },
    adminGrantStore: {
      ...adminStore,
      async writeGrant(modelId, instanceName, grant) {
        await adminStore.writeGrant(modelId, instanceName, grant);
        recordGrantData(modelId);
      },
    },
    takeWrittenPaths() {
      const paths = writtenPaths;
      writtenPaths = [];
      return paths;
    },
  };
}

export interface GrantWritePublishDeps {
  syncService?: Pick<DatastoreSyncService, "pushChanged">;
  markDirty?: MarkDirtyHook;
  namespace?: string;
}

/**
 * Re-marks each written path and pushes once, through a root unit of work
 * whose flush is the push ({@link stageWritesThenPush}). Must run inside the
 * exclusive sync gate, in the same unit as the writes, so a poller pull cannot
 * land between them and the push (swamp-club#2247, swamp-club#2405).
 *
 * Paths are marked one by one, never with a bare markDirty(), which would
 * turn the push into a walk of the whole cache (swamp-club#2415). A push
 * failure is logged, not thrown: the local policy already holds the writes,
 * and reconcile collapses any duplicate a missed push lets a peer create.
 */
export async function publishGrantWrites(
  paths: readonly string[],
  deps: GrantWritePublishDeps,
): Promise<void> {
  if (!deps.syncService || paths.length === 0) return;
  const syncService = deps.syncService;
  try {
    await stageWritesThenPush({ markDirty: deps.markDirty }, paths, {
      flush: () => pushNamespace(syncService, deps.namespace),
    });
  } catch (error) {
    logger.warn("Failed to push grant changes to the datastore: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Returns a runner for grant-writing units: each unit runs inside the
 * exclusive sync gate, and the grant writes it made are pushed before the
 * gate is released. Serve's startup reconcile and the grants auto-reload
 * both run through it.
 */
export function createGrantWriteCommit(
  gate: SyncGate | undefined,
  tracking: Pick<GrantWriteTracking, "takeWrittenPaths">,
  deps: GrantWritePublishDeps,
): <T>(unit: () => Promise<T>) => Promise<T> {
  return (unit) =>
    withSyncGate(gate, async () => {
      // Paths are not cleared before the unit runs. If an earlier unit threw
      // after writing, its recorded paths are still pending, and this unit's
      // push carries them with its own.
      const result = await unit();
      await publishGrantWrites(tracking.takeWrittenPaths(), deps);
      return result;
    });
}
