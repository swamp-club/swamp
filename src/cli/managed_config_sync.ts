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
import {
  type RootUnitOfWork,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import {
  createRepoPendingLockfileStore,
  createRootLockfileSync,
  LockfilePublishWiringError,
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
import {
  pushNamespace,
  pushNamespaceCounted,
} from "../infrastructure/persistence/push_paths.ts";
import { datastoreBlockEngine } from "../infrastructure/persistence/datastore_format_guard.ts";
import { createV3LockfileSync } from "../infrastructure/datastore_v3/v3_lockfile_sync.ts";

/**
 * the local write is kept; the message names the retry, which is swamp
 * extension install for a lockfile change because a plain push would publish a
 * stale copy
 */
export class ManagedConfigUnpublishedError extends UserError {
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

export async function runManagedConfigMutation<T>(
  repoContext: Pick<RepositoryContext, "markDirty">,
  syncService: DatastoreSyncService | undefined,
  datastoreConfig: DatastoreConfig,
  marker: RepoMarkerData | null,
  reason: string,
  mutate: () => Promise<T>,
  options: { readonly outputOnlyOnSuccess?: boolean } = {},
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
      ...(options.outputOnlyOnSuccess === true
        ? { outputOnlyOnSuccess: true }
        : {}),
    },
    async (root) => {
      const value = await mutate();
      if (publishes) await stageManagedConfigChanges(root, reason);
      return value;
    },
  );
}

/**
 * after a completed mutation a failed push throws
 * ManagedConfigUnpublishedError; otherwise the error goes to onCleanupError so
 * it cannot replace one already propagating
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
 * the change is refused: making it on a stale lockfile would publish over other
 * checkouts' entries
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

const HELD_LOCK: ManagedLockfileLock = {
  acquire: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

export interface ManagedLockfileTransactionDeps {
  syncService: DatastoreSyncService;
  datastoreConfig: DatastoreConfig;
  repoDir: string;
  lockfilePath: string;
  lock: ManagedLockfileLock;
}

/**
 * the root is per run, not per command: extension commands resolve the
 * datastore on first lockfile use, and some never make one. a failed publish
 * records the change in .swamp/ for the next transaction to replay
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
  const namespace = datastoreConfig.namespace;
  // One hook for the root and the publish: the publish finds its root by
  // hook identity.
  const markDirty = buildMarkDirtyHook(syncService, cachePath, repoDir);
  const sync = createRootLockfileSync({
    syncService,
    namespace,
    timeoutMs: resolveSyncTimeoutMs(datastoreConfig),
    lockfilePath,
    markDirty,
  });
  const logger = getSwampLogger(["cli", "managed-config"]);
  return new ManagedLockfileTransaction({
    lockfilePath,
    inRoot: (fn) =>
      runInRootUnitOfWork(
        { markDirty },
        {
          flush: undefined,
          checkpoint: ({ signal }) =>
            pushNamespaceCounted(syncService, namespace, signal),
        },
        () => fn(),
      ),
    lock: {
      // an unreachable datastore fails here, before anything is downloaded;
      // errors that explain themselves (lock timeout, misconfigured datastore)
      // pass through
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
          // A wiring mistake, not an unpublished change: no retry advice.
          if (error instanceof LockfilePublishWiringError) throw error;
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
 * undefined when the lockfile is not shared through a datastore. the datastore
 * resolves on first use and the held-global-lock check runs when built, so a
 * transaction must not outlive its command
 */
export function createManagedLockfileTransaction(
  repoDir: string,
  marker: RepoMarkerData | null,
  write: ManagedLockfileWrite,
): LockfileTransaction | undefined {
  if (write.publish && isV3ManagedConfigDatastore(repoDir, marker)) {
    return lazyLockfileTransaction(write.lockfilePath, async () => {
      const resolved = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "log",
      });
      return buildV3ManagedLockfileTransaction(
        resolved.repoContext,
        resolved.repoDir,
        write.lockfilePath,
        resolved.datastoreResolver.resolvePath("config"),
        resolved.datastoreConfig,
      );
    });
  }
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

function isV3ManagedConfigDatastore(
  repoDir: string,
  marker: RepoMarkerData | null,
): boolean {
  return marker?.datastore?.managedConfig === true &&
    datastoreBlockEngine(repoDir, marker.datastore) === "v3";
}

/** the writer lock the repo context holds stands in for the global lock */
export function buildV3ManagedLockfileTransaction(
  repoContext: RepositoryContext,
  repoDir: string,
  lockfilePath: string,
  configBase: string,
  datastoreConfig: DatastoreConfig,
): ManagedLockfileTransaction {
  const markDirty = repoContext.markDirty;
  if (markDirty === undefined || repoContext.commitLog === undefined) {
    throw new ManagedLockfileUnavailableError(
      "the datastore's managed config is v3, but the repository did not open as v3",
    );
  }
  return new ManagedLockfileTransaction({
    lockfilePath,
    inRoot: (fn) =>
      runInRootUnitOfWork(
        repoContext,
        { flush: undefined, checkpoint: () => Promise.resolve() },
        () => fn(),
      ),
    // The global lock serialises lockfile changes, as on v2, unless this
    // command already holds it.
    lock: getRegisteredLockKeys().includes(GLOBAL_LOCK_KEY)
      ? HELD_LOCK
      : coordinatedGlobalLock(datastoreConfig),
    sync: createV3LockfileSync({
      markDirty,
      lockfilePath,
      configBase,
      commitLog: repoContext.commitLog,
    }),
    pending: createRepoPendingLockfileStore(repoDir),
  });
}

const MANAGED_LOCKFILE_LOCK_KEY = "__managed_lockfile__";

/**
 * held through the sync coordinator so its SIGINT handler releases it: Ctrl-C
 * mid-transaction must not leave other checkouts waiting out the lock TTL
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
 * pulled workflow dirs are re-enumerated after the pull because the repo
 * context was created before it; type registries load lazily, workflows are the
 * one kind enumerated eagerly
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
