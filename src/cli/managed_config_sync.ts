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

import { getLogger } from "@logtape/logtape";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { isCustomDatastoreConfig } from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import { requireInitializedRepoUnlocked } from "./repo_context.ts";

const logger = getLogger(["swamp", "cli", "managed-config-sync"]);

/**
 * Push config-tier changes to the remote datastore when managedConfig is
 * active. Used by CLI commands that already hold a syncService and
 * datastoreConfig from requireInitializedRepoUnlocked.
 */
export async function pushManagedConfigChanges(
  syncService: DatastoreSyncService | undefined,
  datastoreConfig: DatastoreConfig,
  marker: RepoMarkerData | null,
): Promise<void> {
  if (!syncService) return;
  if (marker?.datastore?.managedConfig !== true) return;

  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;
  try {
    await syncService.markDirty();
    await syncService.pushChanged({ namespace });
  } catch (error) {
    logger.warn`Failed to push managed config changes to remote datastore: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Push config-tier changes for commands that use requireRepoMarker (no
 * pre-resolved syncService). Resolves the datastore on demand after the
 * mutation. Safe to call when managedConfig is true because the datastore
 * extension must already be installed (config migrate requires a working
 * datastore). Wrapped in try/catch so a failure to resolve the datastore
 * (e.g. the datastore extension was just updated) warns but does not
 * block the command.
 */
export async function pushManagedConfigChangesDeferred(
  repoDir: string,
  marker: RepoMarkerData | null,
): Promise<void> {
  if (marker?.datastore?.managedConfig !== true) return;

  try {
    const { syncService, datastoreConfig } =
      await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "log",
      });
    await pushManagedConfigChanges(syncService, datastoreConfig, marker);
  } catch (error) {
    logger.warn`Failed to push managed config changes (deferred): ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}
