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
import { isAbsolute, join, relative } from "@std/path";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import {
  isCustomDatastoreConfig,
  resolveSyncTimeoutMs,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import { computeFileContentHashIfExists } from "../domain/extensions/extension_package_cache.ts";
import { runBoundedSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import type { ExtensionWorkflowRepository } from "../infrastructure/persistence/extension_workflow_repository.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import {
  buildMarkDirtyHook,
  refreshExtensionWorkflowDirs,
  requireInitializedRepoUnlocked,
} from "./repo_context.ts";

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

/**
 * Push exactly the given config-tier files to the remote datastore when
 * managedConfig is active. Extension writes use this instead of
 * {@link pushManagedConfigChanges}: each path is marked on its own
 * (datastore sync rule 1), so the push uploads those files rather than
 * walking the whole cache, which never detects deletions (rule 3). An
 * extension that keeps its dirty set in memory still full-walks on a fresh
 * process (rule 4); the files are uploaded either way.
 *
 * Paths outside the namespace's cache tree are dropped, never forwarded: the
 * mark hook would map an in-repo `.swamp/config` path to an un-namespaced key.
 * The push is bounded by the datastore's sync timeout. Failures warn.
 */
export async function pushManagedConfigPaths(
  syncService: DatastoreSyncService | undefined,
  datastoreConfig: DatastoreConfig,
  marker: RepoMarkerData | null,
  repoDir: string,
  absPaths: readonly string[],
): Promise<void> {
  if (!syncService) return;
  if (marker?.datastore?.managedConfig !== true) return;
  if (!isCustomDatastoreConfig(datastoreConfig)) return;
  const cachePath = datastoreConfig.cachePath;
  if (!cachePath) return;

  const namespace = datastoreConfig.namespace;
  const tierRoot = namespace ? join(cachePath, namespace) : cachePath;
  const inTier = (absPath: string) => {
    const rel = relative(tierRoot, absPath);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const paths = absPaths.filter(inTier);
  if (paths.length === 0) return;

  const markDirty = buildMarkDirtyHook(syncService, cachePath, repoDir);
  try {
    for (const path of paths) {
      await markDirty(path);
    }
    await runBoundedSync(
      "managed config",
      "push",
      resolveSyncTimeoutMs(datastoreConfig),
      (signal) => syncService.pushChanged({ namespace, signal }),
    );
  } catch (error) {
    logger.warn`Failed to push managed config changes to remote datastore: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * {@link pushManagedConfigPaths} for commands that use requireRepoMarker (no
 * pre-resolved syncService): resolves the datastore after the mutation, as
 * {@link pushManagedConfigChangesDeferred} does.
 */
export async function pushManagedConfigPathsDeferred(
  repoDir: string,
  marker: RepoMarkerData | null,
  absPaths: readonly string[],
): Promise<void> {
  if (marker?.datastore?.managedConfig !== true) return;
  if (absPaths.length === 0) return;

  try {
    const { syncService, datastoreConfig, repoDir: resolvedRepoDir } =
      await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "log",
      });
    await pushManagedConfigPaths(
      syncService,
      datastoreConfig,
      marker,
      resolvedRepoDir,
      absPaths,
    );
  } catch (error) {
    logger.warn`Failed to push managed config changes (deferred): ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/**
 * Content hash of a lockfile before a command that may rewrite it, for
 * {@link pushManagedLockfileIfChangedDeferred}. An unreadable file reads as
 * missing, so the later comparison errs towards pushing.
 */
export async function snapshotLockfileHash(
  lockfilePath: string,
): Promise<string | null> {
  return await computeFileContentHashIfExists(lockfilePath).catch(() => null);
}

/**
 * Pushes the tier lockfile when its content differs from `hashBefore`
 * (from {@link snapshotLockfileHash}). For commands that only sometimes
 * write the lockfile — search install, repo upgrade, doctor repair — so an
 * untouched lockfile is never published.
 */
export async function pushManagedLockfileIfChangedDeferred(
  repoDir: string,
  marker: RepoMarkerData | null,
  lockfilePath: string,
  hashBefore: string | null,
  push: typeof pushManagedConfigPathsDeferred = pushManagedConfigPathsDeferred,
): Promise<void> {
  if (marker?.datastore?.managedConfig !== true) return;
  let hashAfter: string | null;
  try {
    hashAfter = await computeFileContentHashIfExists(lockfilePath);
  } catch (error) {
    logger.warn`Failed to read the extension lockfile to publish it: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return;
  }
  if (hashAfter === hashBefore) return;
  await push(repoDir, marker, [lockfilePath]);
}

export interface PullManagedConfigAtBootDeps {
  syncService: Pick<DatastoreSyncService, "pullChanged">;
  namespace?: string;
  catalogInvalidate: () => void;
  extensionWorkflowRepo:
    | Pick<ExtensionWorkflowRepository, "updateAdditionalDirs">
    | null;
  repoDir: string;
  lockfilePath: string;
  pulledExtensionsRoot?: string;
}

/**
 * Pulls the managed config and auto-definitions tiers at serve boot, then
 * re-enumerates the pulled-extension workflow directories.
 *
 * The repository context is created before this pull, so on an instance
 * that starts with an empty cache it enumerated pulled workflow dirs
 * against a lockfile that did not exist yet and registered none of them
 * (swamp-club#2434). Extension type registries load lazily after this pull
 * and are unaffected; workflows are the one kind enumerated eagerly.
 */
export async function pullManagedConfigAtBoot(
  deps: PullManagedConfigAtBootDeps,
): Promise<void> {
  await deps.syncService.pullChanged({
    subdirs: ["config", "auto-definitions"],
    namespace: deps.namespace,
  });
  deps.catalogInvalidate();
  if (deps.extensionWorkflowRepo) {
    await refreshExtensionWorkflowDirs(
      deps.extensionWorkflowRepo,
      deps.repoDir,
      deps.lockfilePath,
      deps.pulledExtensionsRoot,
    );
  }
}
