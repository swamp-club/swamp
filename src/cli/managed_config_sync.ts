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
import {
  flushDatastoreSyncNamed,
  getRegisteredLockKeys,
  GLOBAL_LOCK_KEY,
  registerDatastoreSyncNamed,
  runBoundedSync,
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import type { ExtensionWorkflowRepository } from "../infrastructure/persistence/extension_workflow_repository.ts";
import { isExtensionBackedDatastore } from "../infrastructure/persistence/managed_config_lockfile.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  createDatastoreLockfileSync,
  createRepoPendingLockfileStore,
  type LockfileTransaction,
  type ManagedLockfileLock,
  ManagedLockfileTransaction,
} from "../libswamp/mod.ts";
import { createDatastoreLock } from "../infrastructure/persistence/datastore_global_lock.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import {
  buildMarkDirtyHook,
  type ManagedLockfileWrite,
  refreshExtensionWorkflowDirs,
  requireInitializedRepoUnlocked,
} from "./repo_context.ts";

/**
 * A config-tier change was written to the local cache but could not be
 * published to the datastore under managedConfig. The local write is kept.
 * The message names the retry: `swamp datastore sync --push` for most
 * config writes, `swamp extension install` for an extension lockfile
 * change, where a plain push would publish a stale copy.
 */
export class ManagedConfigUnpublishedError extends UserError {
  /**
   * @param retryAdvice How to publish the change. An extension lockfile
   *   change names `swamp extension install`, which fetches the datastore's
   *   lockfile and replays the change onto it; a plain push would publish
   *   the local copy over other checkouts' entries (swamp-club#2838).
   */
  constructor(
    cause: unknown,
    retryAdvice = "Run 'swamp datastore sync --push' to publish it.",
  ) {
    const reason = (cause instanceof Error ? cause.message : String(cause))
      .replace(/\.+$/, "");
    super(
      "The change is saved locally but was not published to the datastore: " +
        `${reason}. ${retryAdvice}`,
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
 * The shared extension lockfile could not be fetched from the datastore
 * before an extension change, so the change was not made: making it on a
 * stale lockfile would publish over other checkouts' entries
 * (swamp-club#2838).
 */
export class ManagedLockfileUnavailableError extends UserError {
  constructor(cause: unknown) {
    const reason = (cause instanceof Error ? cause.message : String(cause))
      .replace(/\.+$/, "");
    super(
      "Could not fetch the extension lockfile from the datastore, so no " +
        `extension was changed: ${reason}. ` +
        "Check that the datastore is reachable and retry.",
      "managed_lockfile_unavailable",
    );
    this.name = "ManagedLockfileUnavailableError";
    this.cause = cause;
  }
}

/** A lock already held by this process: acquiring and releasing it is a no-op. */
const HELD_LOCK: ManagedLockfileLock = {
  acquire: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

export interface ManagedLockfileTransactionDeps {
  syncService: DatastoreSyncService;
  datastoreConfig: DatastoreConfig;
  repoDir: string;
  lockfilePath: string;
  /** The datastore global lock (see datastoreGlobalLockOptions). */
  lock: ManagedLockfileLock;
}

/**
 * Builds the transaction a CLI extension command makes its lockfile change
 * in (see {@link createManagedLockfileTransaction}). A failed fetch throws
 * {@link ManagedLockfileUnavailableError} before anything changes; a failed
 * publish throws {@link ManagedConfigUnpublishedError} with the change
 * recorded in the repo's `.swamp/` directory, for the next transaction to
 * replay.
 */
export function buildManagedLockfileTransaction(
  deps: ManagedLockfileTransactionDeps,
): ManagedLockfileTransaction {
  const { syncService, datastoreConfig, repoDir, lockfilePath } = deps;
  const cachePath = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.cachePath
    : undefined;
  if (!isCustomDatastoreConfig(datastoreConfig) || !cachePath) {
    throw new ManagedLockfileUnavailableError(
      `the ${datastoreConfig.type} datastore has no local cache`,
    );
  }
  const sync = createDatastoreLockfileSync({
    syncService,
    namespace: datastoreConfig.namespace,
    timeoutMs: resolveSyncTimeoutMs(datastoreConfig),
    lockfilePath,
    markDirty: buildMarkDirtyHook(syncService, cachePath, repoDir),
  });
  const logger = getSwampLogger(["cli", "managed-config"]);
  return new ManagedLockfileTransaction({
    lockfilePath,
    lock: {
      // A datastore that cannot be reached fails here, before anything is
      // downloaded or changed. Errors that already explain themselves pass
      // through: a lock another process holds (LockTimeoutError) or a
      // datastore that is misconfigured.
      acquire: async () => {
        try {
          await deps.lock.acquire();
        } catch (error) {
          if (error instanceof UserError) throw error;
          throw new ManagedLockfileUnavailableError(error);
        }
      },
      release: () => deps.lock.release(),
    },
    onWarning: (message, error) =>
      error === undefined ? logger.warn(message) : logger.warn(
        `${message}: {error}`,
        { error: error instanceof Error ? error.message : String(error) },
      ),
    sync: {
      hydrate: async () => {
        try {
          await sync.hydrate();
        } catch (error) {
          throw new ManagedLockfileUnavailableError(error);
        }
      },
      publish: async (options) => {
        try {
          await sync.publish(options);
        } catch (error) {
          throw new ManagedConfigUnpublishedError(
            error,
            "Run 'swamp extension install' to publish it: it fetches the " +
              "datastore's lockfile and replays the change onto it.",
          );
        }
      },
    },
    pending: createRepoPendingLockfileStore(repoDir),
  });
}

/**
 * The transaction a CLI extension command runs its lockfile changes in, for
 * `withManagedLockfileTransaction`. Undefined when the lockfile is not
 * shared through a datastore: no managedConfig, a filesystem datastore, or
 * the #445 exemption that records into the in-repo lockfile
 * (`write.publish` false).
 *
 * The datastore is resolved on first use: the first change, or the first
 * refresh (`extension install`, `update` and the `rm` preview refresh
 * before reading the lockfile, so they contact the datastore even when
 * they end up changing nothing). When this process already holds the
 * datastore global lock (a command that runs under the sync coordinator),
 * the transaction does not take it again; that check runs once, when the
 * transaction is built, so a transaction must not outlive the command
 * that built it.
 */
export function createManagedLockfileTransaction(
  repoDir: string,
  marker: RepoMarkerData | null,
  write: ManagedLockfileWrite,
): LockfileTransaction | undefined {
  if (!write.publish || !isExtensionBackedDatastore(marker)) return undefined;

  return lazyLockfileTransaction(write.lockfilePath, async () => {
    let resolved: Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;
    try {
      resolved = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "log",
      });
    } catch (error) {
      // Nothing has changed yet: say so, as a failed lock or fetch does.
      if (error instanceof UserError) throw error;
      throw new ManagedLockfileUnavailableError(error);
    }
    const { syncService, datastoreConfig, repoDir: resolvedRepoDir } = resolved;
    if (!syncService) {
      throw new ManagedLockfileUnavailableError(
        `the ${datastoreConfig.type} datastore has no sync service`,
      );
    }
    return buildManagedLockfileTransaction({
      syncService,
      datastoreConfig,
      repoDir: resolvedRepoDir,
      lockfilePath: write.lockfilePath,
      lock: getRegisteredLockKeys().includes(GLOBAL_LOCK_KEY)
        ? HELD_LOCK
        : coordinatedGlobalLock(datastoreConfig),
    });
  });
}

/** Coordinator key under which a lockfile transaction holds the global lock. */
const MANAGED_LOCKFILE_LOCK_KEY = "__managed_lockfile__";

/**
 * The datastore global lock, held through the sync coordinator so its
 * SIGINT handler releases it: a Ctrl-C during a transaction, which can
 * include dependency downloads, must not leave other checkouts waiting out
 * the lock's TTL.
 */
function coordinatedGlobalLock(config: DatastoreConfig): ManagedLockfileLock {
  return {
    acquire: async () =>
      await registerDatastoreSyncNamed(MANAGED_LOCKFILE_LOCK_KEY, {
        lock: await createDatastoreLock(config),
        label: config.type,
        namespace: isCustomDatastoreConfig(config)
          ? config.namespace
          : undefined,
      }),
    release: () => flushDatastoreSyncNamed(MANAGED_LOCKFILE_LOCK_KEY),
  };
}

/** A transaction built on its first use, so an unused one costs nothing. */
function lazyLockfileTransaction(
  lockfilePath: string,
  build: () => Promise<LockfileTransaction>,
): LockfileTransaction {
  let built: Promise<LockfileTransaction> | undefined;
  // A failed build is not kept: the next change, say the next extension
  // in a restore loop, tries again rather than repeating one transient
  // failure.
  const transaction = () =>
    built ??= build().catch((error) => {
      built = undefined;
      throw error;
    });
  return {
    lockfilePath,
    run: async (fn) => await (await transaction()).run(fn),
    refresh: async () => await (await transaction()).refresh(),
  };
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
