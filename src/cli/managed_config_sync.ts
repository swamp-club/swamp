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

import { isAbsolute, join, relative } from "@std/path";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import {
  isCustomDatastoreConfig,
  resolveSyncTimeoutMs,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import { UserError } from "../domain/errors.ts";
import { computeFileContentHashIfExists } from "../domain/extensions/extension_package_cache.ts";
import { runBoundedSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import type { ExtensionWorkflowRepository } from "../infrastructure/persistence/extension_workflow_repository.ts";
import {
  clearLockfilePublishPending,
  isLockfilePublishPending,
  markLockfilePublishPending,
} from "../infrastructure/persistence/pending_lockfile_publish.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import {
  buildMarkDirtyHook,
  refreshExtensionWorkflowDirs,
  requireInitializedRepoUnlocked,
} from "./repo_context.ts";

/**
 * A config-tier change was written to the local cache but could not be
 * published to the datastore under managedConfig. The local write is kept;
 * `swamp datastore sync --push` publishes it once the datastore is reachable.
 */
export class ManagedConfigUnpublishedError extends UserError {
  constructor(cause: unknown) {
    const reason = (cause instanceof Error ? cause.message : String(cause))
      .replace(/\.+$/, "");
    super(
      "The change is saved locally but was not published to the datastore: " +
        `${reason}. ` +
        "Run 'swamp datastore sync --push' to publish it.",
      "managed_config_unpublished",
    );
    this.name = "ManagedConfigUnpublishedError";
    this.cause = cause;
  }
}

function toUnpublishedError(error: unknown): ManagedConfigUnpublishedError {
  return error instanceof ManagedConfigUnpublishedError
    ? error
    : new ManagedConfigUnpublishedError(error);
}

/**
 * Push config-tier changes to the remote datastore when managedConfig is
 * active. Used by CLI commands that already hold a syncService and
 * datastoreConfig from requireInitializedRepoUnlocked. A failed push throws
 * {@link ManagedConfigUnpublishedError}; the local write is kept.
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
    throw toUnpublishedError(error);
  }
}

/**
 * Push config-tier changes for commands that use requireRepoMarker (no
 * pre-resolved syncService). Resolves the datastore on demand after the
 * mutation. Safe to call when managedConfig is true because the datastore
 * extension must already be installed (config migrate requires a working
 * datastore). A failure to resolve the datastore (e.g. the datastore
 * extension was just updated) leaves the change unpublished like a failed
 * push, so it throws {@link ManagedConfigUnpublishedError} too.
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
    throw toUnpublishedError(error);
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
 * The push is bounded by the datastore's sync timeout. A failed or timed-out
 * push throws {@link ManagedConfigUnpublishedError}.
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
    throw toUnpublishedError(error);
  }
}

/**
 * {@link pushManagedConfigPaths} for commands that use requireRepoMarker (no
 * pre-resolved syncService): resolves the datastore after the mutation, as
 * {@link pushManagedConfigChangesDeferred} does, and throws
 * {@link ManagedConfigUnpublishedError} when either step fails.
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
    throw toUnpublishedError(error);
  }
}

/**
 * Flushes per-model locks after a command that may have changed the config
 * tier; the flush is what pushes the change. When the mutation completed
 * under managedConfig, a failed flush throws
 * {@link ManagedConfigUnpublishedError}. Otherwise (the mutation never ran,
 * or an earlier error is already propagating) the failure only goes to
 * `onCleanupError`, so it cannot replace that error.
 */
export async function flushAfterManagedConfigMutation(
  flush: () => Promise<void>,
  mutated: boolean,
  marker: RepoMarkerData | null,
  onCleanupError: (error: unknown) => void,
): Promise<void> {
  try {
    await flush();
  } catch (error) {
    if (mutated && marker?.datastore?.managedConfig === true) {
      throw toUnpublishedError(error);
    }
    onCleanupError(error);
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
 * write the lockfile — the extension commands, repo upgrade, doctor repair —
 * so an untouched lockfile is never published and a no-op command never
 * fails on an unreachable datastore. A lockfile that cannot be read after
 * the command may hold an unpublished change, so it throws
 * {@link ManagedConfigUnpublishedError}.
 *
 * A failed publish is recorded locally, and while that record stands the
 * lockfile is published even when this command left it unchanged, so
 * re-running a command after a failed publish retries it instead of exiting
 * 0 with the change still unpublished. A successful publish clears it.
 */
export async function pushManagedLockfileIfChangedDeferred(
  repoDir: string,
  marker: RepoMarkerData | null,
  lockfilePath: string,
  hashBefore: string | null,
  push: typeof pushManagedConfigPathsDeferred = pushManagedConfigPathsDeferred,
): Promise<void> {
  if (marker?.datastore?.managedConfig !== true) return;
  try {
    const hashAfter = await computeFileContentHashIfExists(lockfilePath);
    if (
      hashAfter === hashBefore && !await isLockfilePublishPending(repoDir)
    ) {
      return;
    }
    await push(repoDir, marker, [lockfilePath]);
  } catch (error) {
    // Best effort: failing to record the retry must not replace the error
    // that tells the user the change is unpublished.
    await markLockfilePublishPending(repoDir).catch(() => {});
    throw toUnpublishedError(error);
  }
  // Best effort: a stale record only costs one redundant publish later.
  await clearLockfilePublishPending(repoDir).catch(() => {});
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
