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
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { stageWritesThenPush } from "./stage_writes_then_push.ts";
import { pushNamespace } from "../infrastructure/persistence/push_paths.ts";

const logger = getSwampLogger(["serve", "grant-write-tracking"]);

/**
 * records every path written so serve can push startup reconcile and grants
 * auto-reload writes; without the push a second instance on the same datastore
 * never sees these grants and creates its own copies
 */
export interface GrantWriteTracking {
  readonly fileGrantStore: FileGrantStore;
  readonly adminGrantStore: AdminGrantStore;
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
 * must run inside the exclusive sync gate, in the same unit as the writes, so a
 * poller pull cannot land between them and the push. Mark paths one by one: a
 * bare markDirty() makes the push walk the whole cache.
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

export function createGrantWriteCommit(
  gate: SyncGate | undefined,
  tracking: Pick<GrantWriteTracking, "takeWrittenPaths">,
  deps: GrantWritePublishDeps,
): <T>(unit: () => Promise<T>) => Promise<T> {
  return (unit) =>
    withSyncGate(gate, async () => {
      // paths are not cleared first: an earlier unit that threw after writing
      // leaves paths pending and this push carries them. Writes run in a root
      // unit with no push so marks stage into it; the push opens its own.
      const result = await runInRootUnitOfWork(
        { markDirty: deps.markDirty },
        { flush: undefined },
        unit,
      );
      await publishGrantWrites(tracking.takeWrittenPaths(), deps);
      return result;
    });
}
