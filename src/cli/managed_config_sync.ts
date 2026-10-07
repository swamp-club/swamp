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
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import type { ExtensionWorkflowRepository } from "../infrastructure/persistence/extension_workflow_repository.ts";
import { isExtensionBackedDatastore } from "../infrastructure/persistence/managed_config_lockfile.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type { RootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import {
  createDatastoreLockfileSync,
  createRepoPendingLockfileStore,
  type LockfileTransaction,
  type ManagedLockfileLock,
  ManagedLockfileTransaction,
} from "../libswamp/extensions/managed_lockfile_transaction.ts";
import { createDatastoreLock } from "../infrastructure/persistence/datastore_global_lock.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import {
  buildMarkDirtyHook,
  type ManagedLockfileWrite,
  refreshExtensionWorkflowDirs,
  requireInitializedRepoUnlocked,
} from "./repo_context.ts";
import { runCommandInRootUnit } from "./command_root_unit.ts";
import { pushNamespace } from "../infrastructure/persistence/push_paths.ts";

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
   * @param summary What happened, before the reason. The default describes
   *   the current command's own change.
   */
  constructor(
    cause: unknown,
    retryAdvice = "Run 'swamp datastore sync --push' to publish it.",
    summary = "The change is saved locally but was not published to the " +
      "datastore",
  ) {
    const reason = (cause instanceof Error ? cause.message : String(cause))
      .replace(/\.+$/, "");
    super(
      `${summary}: ${reason}. ${retryAdvice}`,
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
 * active: a bare mark, then a push. A failed mark or push throws
 * {@link ManagedConfigUnpublishedError}; the local write is kept. Commands
 * publish through {@link runManagedConfigMutation}, which makes the same mark
 * and push through a root unit of work (swamp-club#3033).
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
    await pushNamespace(syncService, namespace);
  } catch (error) {
    throw toUnpublishedError(error);
  }
}

/**
 * The mark half of {@link pushManagedConfigChanges} for a command that runs
 * in a root unit of work (swamp-club#3033): stages the same bare mark
 * through the root, which forwards it as the identical `markDirty()` call.
 * A failed mark throws {@link ManagedConfigUnpublishedError}.
 */
export async function stageManagedConfigChanges(
  root: RootUnitOfWork,
  reason: string,
): Promise<void> {
  try {
    await root.stage({ kind: "bulk", reason });
  } catch (error) {
    throw toUnpublishedError(error);
  }
}

/**
 * The push half of {@link pushManagedConfigChanges}: the root's push. A
 * failed push throws {@link ManagedConfigUnpublishedError}; the local write
 * is kept.
 */
export async function publishManagedConfigChanges(
  syncService: DatastoreSyncService,
  datastoreConfig: DatastoreConfig,
): Promise<void> {
  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;
  try {
    await pushNamespace(syncService, namespace);
  } catch (error) {
    throw toUnpublishedError(error);
  }
}

/**
 * Runs a config-tier mutation in a root unit of work and publishes it as
 * {@link pushManagedConfigChanges} does: when managedConfig is active and
 * `mutate` completed, {@link stageManagedConfigChanges} stages the bare mark
 * and the root's push is {@link publishManagedConfigChanges}. When `mutate`
 * fails nothing is marked or pushed, as before.
 */
export async function runManagedConfigMutation<T>(
  repoContext: Pick<RepositoryContext, "markDirty">,
  syncService: DatastoreSyncService | undefined,
  datastoreConfig: DatastoreConfig,
  marker: RepoMarkerData | null,
  reason: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const publishes = syncService !== undefined &&
    marker?.datastore?.managedConfig === true;
  return await runCommandInRootUnit(
    repoContext,
    {
      push: publishes
        ? () => publishManagedConfigChanges(syncService, datastoreConfig)
        : undefined,
      pushWhen: "completed",
    },
    async (root) => {
      const value = await mutate();
      if (publishes) await stageManagedConfigChanges(root, reason);
      return value;
    },
  );
}

/**
 * Decides what a failed push or lock release means after a command that may
 * have changed the config tier, run as cleanup of the command's root unit of
 * work (swamp-club#3033). After a completed mutation under managedConfig the
 * push is what publishes the change, so it throws
 * {@link ManagedConfigUnpublishedError}. Otherwise (the mutation never ran,
 * or an earlier error is already propagating) the error goes to
 * `onCleanupError`, so it cannot replace that error.
 */
export function reportManagedConfigCleanupError(
  error: unknown,
  mutated: boolean,
  marker: RepoMarkerData | null,
  onCleanupError: (error: unknown) => void,
): void {
  if (mutated && marker?.datastore?.managedConfig === true) {
    throw toUnpublishedError(error);
  }
  onCleanupError(error);
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
          // Only an earlier command's change was being published: this
          // command changed nothing, and must not read as if it had.
          throw options.earlierChangeOnly
            ? new ManagedConfigUnpublishedError(
              error,
              "Run 'swamp extension install' to publish the earlier change " +
                "once the datastore accepts it, then run this command again.",
              "An earlier extension lockfile change is still not published " +
                "to the datastore, so this command did not change the " +
                "lockfile",
            )
            : new ManagedConfigUnpublishedError(
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
        // Only extension-backed datastores reach this lock, and those are
        // always shareable.
        slowLockScope: { scope: { kind: "global" }, shareable: true },
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
