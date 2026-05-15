// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * CLI adapter for validating repository initialization.
 *
 * This module bridges CLI commands with the domain's RepoService by:
 * - Checking if a directory is an initialized swamp repository
 * - Throwing clear errors when not initialized
 */

import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import type { OutputMode } from "../presentation/output/output.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
  type RepositoryFactoryConfig,
} from "../infrastructure/persistence/repository_factory.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { RepoService } from "../domain/repo/repo_service.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { UserError } from "../domain/errors.ts";
import { VERSION } from "./commands/version.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";
import { resolveModelsDir } from "./resolve_models_dir.ts";
import {
  enumeratePulledExtensionDirs,
  parseModelLockKey,
} from "../libswamp/mod.ts";
import { resolveDatastoreConfig } from "./resolve_datastore.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { ensureDir, walk } from "@std/fs";
import {
  flushDatastoreSyncNamed,
  registerDatastoreSync,
  registerDatastoreSyncNamed,
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { summarizeSyncError } from "../infrastructure/persistence/sync_error_diagnostic.ts";
import { FileLock } from "../infrastructure/persistence/file_lock.ts";
import {
  type DistributedLock,
  type LockInfo,
  LockTimeoutError,
} from "../domain/datastore/distributed_lock.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  isCustomDatastoreConfig,
  resolveSyncTimeoutMs,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../domain/datastore/datastore_provider.ts";
import type {
  DatastoreSyncService,
  MarkDirtyHook,
} from "../domain/datastore/datastore_sync_service.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";

/**
 * Resolves source workflow directories from `.swamp-sources.yaml`.
 * Results are cached per repoDir to avoid re-reading and re-expanding on
 * every call (multiple repo context functions call this per command).
 * Returns an empty array if no sources are configured or file doesn't exist.
 */
const sourceWorkflowDirCache = new Map<string, string[]>();
async function getSourceWorkflowDirs(repoDir: string): Promise<string[]> {
  const cached = sourceWorkflowDirCache.get(repoDir);
  if (cached) return cached;
  const sourcesConfig = await readSwampSources(repoDir);
  if (!sourcesConfig) {
    sourceWorkflowDirCache.set(repoDir, []);
    return [];
  }
  const expanded = await expandSourcePaths(sourcesConfig, repoDir);
  const resolved = await resolveSourceExtensionDirs(expanded);
  const dirs = collectDirsForKind(resolved, "workflows");
  sourceWorkflowDirCache.set(repoDir, dirs);
  return dirs;
}

/**
 * Resolves a DatastoreProvider for a custom datastore config.
 * Ensures the datastore extension registry is loaded before lookup.
 */
async function resolveCustomProvider(
  config: CustomDatastoreConfig,
): Promise<DatastoreProvider> {
  await datastoreTypeRegistry.ensureLoaded();
  await datastoreTypeRegistry.ensureTypeLoaded(config.type);
  const typeInfo = datastoreTypeRegistry.get(config.type);
  if (!typeInfo?.createProvider) {
    throw new UserError(
      `Datastore type "${config.type}" is not registered or has no provider.`,
    );
  }
  return typeInfo.createProvider(config.config);
}

/**
 * Bridges a `DatastoreSyncService` into a `MarkDirtyHook` that repositories
 * can call without knowing the cache root. Repositories pass the absolute
 * path of the about-to-be-written file (or `undefined` for bulk mutations);
 * the hook computes the cache-relative form and forwards it to the sync
 * service via `DatastoreSyncOptions.relPath`.
 *
 * Path conversion: `relative(cacheRoot, absPath)` then forward-slash
 * normalize. Forward-slash on the wire is the cross-platform key
 * convention (matching `.datastore-index.json`); extensions consuming
 * `relPath` for disk access on Windows convert back to native separators.
 */
function buildMarkDirtyHook(
  syncService: DatastoreSyncService,
  cacheRoot: string,
): MarkDirtyHook {
  return (absPath?: string) => {
    if (absPath === undefined) {
      return syncService.markDirty();
    }
    const rel = relative(cacheRoot, absPath);
    const relPath = SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/");
    return syncService.markDirty({ relPath });
  };
}

/**
 * Options for requireInitializedRepo.
 */
export interface RequireRepoOptions {
  repoDir: string;
  outputMode: OutputMode;
  /**
   * Skip the coordinator's implicit pull-at-startup and push-at-flush.
   * The lock is still acquired (so concurrent writers are blocked), but
   * no sync service is registered with the coordinator. Used by the
   * `swamp datastore sync` command, which owns its own pull/push and
   * must not race with the coordinator's implicit phase — without this
   * flag the implicit pull silently moves files and the explicit pull
   * fast-paths to 0, causing `filesPulled: 0` to be reported even when
   * data was hydrated. See lab #220.
   */
  skipImplicitSync?: boolean;
}

/**
 * Result of successful repo validation containing the validated directory
 * and repository context.
 */
export interface RepoValidationContext {
  repoDir: string;
  repoContext: RepositoryContext;
  datastoreResolver: DatastorePathResolver;
}

/**
 * Lightweight repo + datastore resolution without acquiring the datastore lock.
 *
 * Used by breakglass commands (lock status, lock release) that need the
 * datastore config to inspect/release a lock but must not acquire it.
 */
export interface DatastoreResolutionResult {
  repoDir: string;
  datastoreConfig: DatastoreConfig;
  marker: RepoMarkerData | null;
}

export async function resolveDatastoreForRepo(
  repoDir: string,
): Promise<DatastoreResolutionResult> {
  const repoPath = RepoPath.create(repoDir);
  const service = new RepoService(VERSION);
  const isInit = await service.isInitialized(repoPath);

  if (!isInit) {
    throw new UserError(
      `Not a swamp repository: ${repoPath.value}. To initialize a new repository, run 'swamp repo init', or specify an existing repository with 'swamp <command> --repo-dir /path/to/repo'.`,
    );
  }

  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);

  const datastoreConfig = await resolveDatastoreConfig(
    marker,
    undefined,
    repoPath.value,
  );

  return { repoDir: repoPath.value, datastoreConfig, marker };
}

/**
 * Validates that a directory is an initialized swamp repository without
 * acquiring the datastore lock or performing sync operations.
 *
 * Use this for read-only commands (search, get, list, validate, etc.)
 * that do not modify the datastore. This allows read-only operations to
 * run concurrently with write operations like workflow runs.
 *
 * For remote datastores, this reads from the local cache without pulling
 * latest. The cache reflects whatever was last synced by a write command.
 * For filesystem datastores, reads see writes immediately.
 *
 * @param options - The repo directory and output mode
 * @param factoryConfig - Optional factory configuration overrides
 * @returns The validated repo context
 * @throws UserError if not initialized
 */
export async function requireInitializedRepoReadOnly(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<RepoValidationContext> {
  const { repoDir, datastoreConfig, marker } = await resolveDatastoreForRepo(
    options.repoDir,
  );

  const repoPath = RepoPath.create(repoDir);

  const workflowsDirRel = resolveWorkflowsDir(marker);
  const workflowsDir = isAbsolute(workflowsDirRel)
    ? workflowsDirRel
    : resolve(repoPath.value, workflowsDirRel);

  const datastoreResolver = new DefaultDatastorePathResolver(
    repoPath.value,
    datastoreConfig,
  );

  // Verify datastore is accessible
  if (isCustomDatastoreConfig(datastoreConfig)) {
    // Ensure cache/datastore dir exists — no health check or lock on read-only path
    if (datastoreConfig.cachePath) {
      await ensureDir(datastoreConfig.cachePath);
    }
  } else if (datastoreConfig.type === "filesystem") {
    try {
      const stat = await Deno.stat(datastoreConfig.path);
      if (!stat.isDirectory) {
        throw new UserError(
          `Datastore path is not a directory: ${datastoreConfig.path}`,
        );
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Directory doesn't exist yet - that's OK, it will be created
      } else if (error instanceof UserError) {
        throw error;
      } else {
        throw new UserError(
          `Cannot access datastore at ${datastoreConfig.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // No lock acquisition — read-only path
  }

  // Compute top-level directories for definitions, workflows, and vaults
  const definitionsDir = join(repoPath.value, "models");
  const yamlWorkflowsDir = join(repoPath.value, "workflows");
  const vaultsDir = join(repoPath.value, "vaults");

  // Resolve source workflow directories from .swamp-sources.yaml
  const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

  // Create repository context with the validated directory and datastore resolver
  const repoContext = createRepositoryContext({
    repoDir: repoPath.value,
    workflowsDir,
    additionalWorkflowsDirs: [
      ...sourceWorkflowDirs,
      ...(await enumeratePulledExtensionDirs(
        join(
          isAbsolute(resolveModelsDir(marker))
            ? resolveModelsDir(marker)
            : resolve(repoPath.value, resolveModelsDir(marker)),
          "upstream_extensions.json",
        ),
        repoPath.value,
        "workflows",
      )),
    ],
    definitionsDir,
    yamlWorkflowsDir,
    vaultsDir,
    datastoreResolver,
    ...factoryConfig,
  });

  return {
    repoDir: repoPath.value,
    repoContext,
    datastoreResolver,
  };
}

/**
 * Validates that a directory is an initialized swamp repository.
 *
 * Acquires the datastore lock and performs sync operations (pull on start,
 * push on end). Use this for commands that modify the datastore.
 *
 * For read-only commands, use requireInitializedRepoReadOnly() instead
 * to avoid blocking on the datastore lock.
 *
 * @param options - The repo directory and output mode
 * @param factoryConfig - Optional factory configuration overrides
 * @returns The validated repo context
 * @throws UserError if not initialized
 */
export function requireInitializedRepo(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<RepoValidationContext> {
  return withSpan("swamp.repo.init", {}, async () => {
    const { repoDir, datastoreConfig, marker } = await resolveDatastoreForRepo(
      options.repoDir,
    );

    const repoPath = RepoPath.create(repoDir);

    const workflowsDirRel = resolveWorkflowsDir(marker);
    const workflowsDir = isAbsolute(workflowsDirRel)
      ? workflowsDirRel
      : resolve(repoPath.value, workflowsDirRel);

    const datastoreResolver = new DefaultDatastorePathResolver(
      repoPath.value,
      datastoreConfig,
    );

    // Track whether a remote sync happened so we can invalidate the catalog
    let needsCatalogInvalidation = false;

    // Sync service is shared between the coordinator (pull/push) and the
    // repositories (markDirty on cache writes). Hoisted so both wirings
    // reference the same instance.
    let syncService:
      | ReturnType<
        NonNullable<DatastoreProvider["createSyncService"]>
      >
      | undefined;

    // Verify datastore is accessible
    if (isCustomDatastoreConfig(datastoreConfig)) {
      const provider = await resolveCustomProvider(datastoreConfig);
      const lock = provider.createLock(datastoreConfig.datastorePath);

      // If the custom provider supports sync, register sync service too
      syncService = datastoreConfig.cachePath
        ? provider.createSyncService?.(
          repoPath.value,
          datastoreConfig.cachePath,
        )
        : undefined;

      if (datastoreConfig.cachePath) {
        await ensureDir(datastoreConfig.cachePath);
      }

      // See `RequireRepoOptions.skipImplicitSync` JSDoc. When set, the
      // sync service is not registered with the coordinator (no implicit
      // pull/push); the repository factory still receives it for
      // markDirty hooks, harmlessly so for explicit-sync callers that
      // don't write through repositories.
      const registerService = options.skipImplicitSync
        ? undefined
        : syncService;
      await registerDatastoreSync({
        service: registerService,
        lock,
        label: datastoreConfig.type,
        syncTimeoutMs: resolveSyncTimeoutMs(datastoreConfig),
      });
      // Invalidate catalog after pull so next query backfills from fresh data
      if (registerService) {
        needsCatalogInvalidation = true;
      }
    } else if (datastoreConfig.type === "filesystem") {
      try {
        const stat = await Deno.stat(datastoreConfig.path);
        if (!stat.isDirectory) {
          throw new UserError(
            `Datastore path is not a directory: ${datastoreConfig.path}`,
          );
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          // Directory doesn't exist yet - that's OK, it will be created
        } else if (error instanceof UserError) {
          throw error;
        } else {
          throw new UserError(
            `Cannot access datastore at ${datastoreConfig.path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Symmetric drain — see design/datastores.md "Lock Lifecycle".
      //
      // First drain: wait for any per-model locks visible at command start
      // to be released. A writer that has *already* acquired a per-model
      // lock and passed its TOCTOU recheck (acquireModelLocks, this file)
      // is committed to writing data; we must let it finish.
      await waitForPerModelLocks(datastoreConfig.path);

      // Acquire the global lock. From here on, any writer that inspects
      // the global lock will back off — but a writer that slipped past the
      // first drain may have acquired a per-model lock between the drain
      // ending and this acquisition, so its in-flight write would still
      // race our structural work.
      const lock = new FileLock(datastoreConfig.path);
      await registerDatastoreSync({ lock });

      // Second drain: with the global lock now held, wait for any such
      // straggling per-model locks to release. Writers in the middle of
      // their own TOCTOU recheck will see the global lock and abandon
      // their per-model lock; writers already past the recheck and into
      // the data write must finish before we touch the filesystem. This
      // closes the symmetric TOCTOU window — do not remove without
      // updating the lock-lifecycle contract documented in
      // design/datastores.md.
      await waitForPerModelLocks(datastoreConfig.path);
    }

    // Compute top-level directories for definitions, workflows, and vaults
    const definitionsDir = join(repoPath.value, "models");
    const yamlWorkflowsDir = join(repoPath.value, "workflows");
    const vaultsDir = join(repoPath.value, "vaults");

    // Resolve source workflow directories from .swamp-sources.yaml
    const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

    // Create repository context with the validated directory and datastore resolver
    const repoContext = createRepositoryContext({
      repoDir: repoPath.value,
      workflowsDir,
      additionalWorkflowsDirs: [
        ...sourceWorkflowDirs,
        ...(await enumeratePulledExtensionDirs(
          join(
            isAbsolute(resolveModelsDir(marker))
              ? resolveModelsDir(marker)
              : resolve(repoPath.value, resolveModelsDir(marker)),
            "upstream_extensions.json",
          ),
          repoPath.value,
          "workflows",
        )),
      ],
      definitionsDir,
      yamlWorkflowsDir,
      vaultsDir,
      datastoreResolver,
      markDirty: syncService && isCustomDatastoreConfig(datastoreConfig) &&
          datastoreConfig.cachePath
        ? buildMarkDirtyHook(syncService, datastoreConfig.cachePath)
        : undefined,
      ...factoryConfig,
    });

    // If a remote sync pulled fresh data, invalidate the catalog so the
    // next query backfills from the freshly-pulled local cache.
    if (needsCatalogInvalidation) {
      repoContext.catalogStore.invalidate();
    }

    return {
      repoDir: repoPath.value,
      repoContext,
      datastoreResolver,
    };
  });
}

/**
 * Validates that a directory is an initialized swamp repository without
 * acquiring any lock. Returns the repo context plus the datastore config
 * so callers can acquire per-model locks after resolving which model(s)
 * they target.
 *
 * Use this for model-scoped commands (model method run, workflow run)
 * that acquire per-model locks AFTER resolving which model they target.
 *
 * @param options - The repo directory and output mode
 * @param factoryConfig - Optional factory configuration overrides
 * @returns The validated repo context and datastore config
 * @throws UserError if not initialized
 */
export async function requireInitializedRepoUnlocked(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<
  RepoValidationContext & {
    datastoreConfig: DatastoreConfig;
    /**
     * Single sync service instance shared by this repo context's markDirty
     * hook and any subsequent `acquireModelLocks` pull/push call. Undefined
     * for filesystem datastores or custom datastores without a cache. Passed
     * into `acquireModelLocks` so cache writes and the fast-path watermark
     * read go through the same instance — implementations that cache the
     * sidecar flag in memory stay coherent. See `design/datastores.md`.
     */
    syncService?: DatastoreSyncService;
  }
> {
  const { repoDir, datastoreConfig, marker } = await resolveDatastoreForRepo(
    options.repoDir,
  );

  const repoPath = RepoPath.create(repoDir);

  const workflowsDirRel = resolveWorkflowsDir(marker);
  const workflowsDir = isAbsolute(workflowsDirRel)
    ? workflowsDirRel
    : resolve(repoPath.value, workflowsDirRel);

  const datastoreResolver = new DefaultDatastorePathResolver(
    repoPath.value,
    datastoreConfig,
  );

  let syncService: DatastoreSyncService | undefined;

  // Verify datastore is accessible (same checks as requireInitializedRepo)
  if (isCustomDatastoreConfig(datastoreConfig)) {
    if (datastoreConfig.cachePath) {
      await ensureDir(datastoreConfig.cachePath);
      const provider = await resolveCustomProvider(datastoreConfig);
      syncService = provider.createSyncService?.(
        repoPath.value,
        datastoreConfig.cachePath,
      );
    }
  } else if (datastoreConfig.type === "filesystem") {
    try {
      const stat = await Deno.stat(datastoreConfig.path);
      if (!stat.isDirectory) {
        throw new UserError(
          `Datastore path is not a directory: ${datastoreConfig.path}`,
        );
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Directory doesn't exist yet - that's OK, it will be created
      } else if (error instanceof UserError) {
        throw error;
      } else {
        throw new UserError(
          `Cannot access datastore at ${datastoreConfig.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  // Compute top-level directories for definitions, workflows, and vaults
  const definitionsDir = join(repoPath.value, "models");
  const yamlWorkflowsDir = join(repoPath.value, "workflows");
  const vaultsDir = join(repoPath.value, "vaults");

  // Resolve source workflow directories from .swamp-sources.yaml
  const sourceWorkflowDirs = await getSourceWorkflowDirs(repoPath.value);

  // Create repository context with the validated directory and datastore resolver
  const repoContext = createRepositoryContext({
    repoDir: repoPath.value,
    workflowsDir,
    additionalWorkflowsDirs: [
      ...sourceWorkflowDirs,
      ...(await enumeratePulledExtensionDirs(
        join(
          isAbsolute(resolveModelsDir(marker))
            ? resolveModelsDir(marker)
            : resolve(repoPath.value, resolveModelsDir(marker)),
          "upstream_extensions.json",
        ),
        repoPath.value,
        "workflows",
      )),
    ],
    definitionsDir,
    yamlWorkflowsDir,
    vaultsDir,
    datastoreResolver,
    markDirty: syncService && isCustomDatastoreConfig(datastoreConfig) &&
        datastoreConfig.cachePath
      ? buildMarkDirtyHook(syncService, datastoreConfig.cachePath)
      : undefined,
    ...factoryConfig,
  });

  return {
    repoDir: repoPath.value,
    repoContext,
    datastoreResolver,
    datastoreConfig,
    syncService,
  };
}

/**
 * Creates a per-model distributed lock.
 *
 * Lock key: `data/{modelType}/{modelId}/.lock`
 */
export async function createModelLock(
  config: DatastoreConfig,
  modelType: string,
  modelId: string,
): Promise<DistributedLock> {
  const lockKey = `data/${modelType}/${modelId}/.lock`;
  if (isCustomDatastoreConfig(config)) {
    const provider = await resolveCustomProvider(config);
    return provider.createLock(config.datastorePath, { lockKey });
  }
  return new FileLock(config.path, { lockKey });
}

/**
 * Waits for any held per-model locks to be released.
 *
 * Called twice during structural command setup (`requireInitializedRepo`):
 * once before acquiring the global lock to drain in-flight writers, and
 * once after to catch writers that slipped past the first drain. See
 * design/datastores.md "Lock Lifecycle" for the full contract.
 *
 * Only works for filesystem datastores — S3 datastores use distributed
 * locks that cannot be scanned locally.
 *
 * Test seam: `findModelLocksOverride` is for unit tests only — production
 * callers must omit it. Not exported from any barrel; used solely by
 * `repo_context_test.ts`.
 */
export const SWAMP_LOCK_HOLDER_PID = "SWAMP_LOCK_HOLDER_PID";

export async function waitForPerModelLocks(
  datastorePath: string,
  findModelLocksOverride?: () => Promise<number>,
): Promise<void> {
  const logger = getSwampLogger(["datastore", "lock"]);

  const parentPid = Deno.env.get(SWAMP_LOCK_HOLDER_PID);

  const findModelLocks = findModelLocksOverride ??
    (async (): Promise<number> => {
      let count = 0;
      try {
        for await (
          const entry of walk(datastorePath, {
            includeDirs: false,
            match: [/\.lock$/],
          })
        ) {
          const rel = relative(datastorePath, entry.path);
          if (!parseModelLockKey(rel)) continue;
          try {
            const content = await Deno.readTextFile(entry.path);
            const info = JSON.parse(content) as {
              acquiredAt: string;
              ttlMs: number;
              pid?: number;
            };
            // Skip locks held by our parent process (prevents deadlock
            // when a workflow shell step spawns a nested swamp command).
            if (parentPid && info.pid === Number(parentPid)) continue;
            // Only count non-stale locks
            const acquiredAt = new Date(info.acquiredAt).getTime();
            if (Date.now() - acquiredAt <= info.ttlMs) {
              count++;
            }
          } catch {
            // Skip unreadable lock files
          }
        }
      } catch {
        // Datastore directory may not exist yet
      }
      return count;
    });

  const held = await findModelLocks();
  if (held > 0) {
    logger.info(
      "Waiting for {count} per-model lock(s) to be released",
      { count: held },
    );
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const remaining = await findModelLocks();
      if (remaining === 0) break;
    }
    logger.info`Per-model locks released`;
  }
}

/**
 * Acquires per-model locks in sorted order (deadlock prevention).
 *
 * Checks for the global `.datastore.lock` before acquiring per-model locks.
 * If a structural command holds the global lock, per-model acquisition
 * waits for it to release (reuses existing stale detection).
 *
 * For custom datastores with sync support, pulls model-scoped files after
 * acquiring per-model locks, and the returned flush function pushes changed
 * files under a brief global lock.
 *
 * Registers each lock with the coordinator so SIGINT cleanup works.
 *
 * @returns A flush function that releases all acquired per-model locks
 *          (and pushes changes for sync-capable datastores).
 */
export interface ModelLockResult {
  flush: () => Promise<void>;
  /** True if a remote datastore sync pulled data during lock acquisition. */
  synced: boolean;
}

/**
 * Best-effort delete of a stale global lock whose `info` was just observed.
 *
 * Without this, the wait loops in `acquireModelLocks` only `break` past a
 * stale lock — the file remains on disk/in S3 and the post-acquire TOCTOU
 * re-check immediately re-detects it, triggering an infinite recursive
 * retry. Using the existing `forceRelease(expectedNonce)` breakglass
 * primitive (defined on `DistributedLock` for exactly this purpose)
 * actually clears the stale state so subsequent inspects return null.
 *
 * Failure modes are benign and intentionally swallowed:
 *   - `info.nonce` missing (older lock format) — skip; the surrounding
 *     wait-loop timeout still bounds the wait.
 *   - `forceRelease` returns false (nonce changed: the holder
 *     legitimately re-acquired or another process force-released first)
 *     — the next inspect will see the new state and we re-loop.
 *   - Backend transient error — same recovery; one extra loop iteration.
 */
async function tryForceReleaseStaleLock(
  lock: DistributedLock,
  info: LockInfo,
): Promise<void> {
  if (!info.nonce) return;
  const logger = getSwampLogger(["datastore", "lock"]);
  try {
    await lock.forceRelease(info.nonce);
  } catch (error) {
    logger.debug(
      "Best-effort forceRelease of stale global lock failed: {error}",
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

export async function acquireModelLocks(
  config: DatastoreConfig,
  models: Array<{ modelType: string; modelId: string }>,
  repoDir?: string,
  /**
   * Sync service to use for pull/push. Normally supplied by the caller
   * (e.g. via `requireInitializedRepoUnlocked` or the serve context) so the
   * same instance handles both the markDirty hook on cache writes and the
   * fast-path watermark read here — implementations that cache the sidecar
   * flag in memory stay coherent across the two call sites. Omit to let
   * this function create one; doing so is only safe when no separate
   * repo-context markDirty hook will race this instance.
   */
  syncService?: DatastoreSyncService,
): Promise<ModelLockResult> {
  const logger = getSwampLogger(["datastore", "lock"]);
  let synced = false;

  // For custom datastores, resolve the provider once and reuse it everywhere
  let customProvider: DatastoreProvider | undefined;
  let customSyncService = syncService;
  if (isCustomDatastoreConfig(config)) {
    customProvider = await resolveCustomProvider(config);
    if (!customSyncService && config.cachePath) {
      customSyncService = customProvider.createSyncService?.(
        repoDir ?? ".",
        config.cachePath,
      );
    }
  }

  // Wait for global lock to be released (if held by a structural command).
  // Use the cached provider for custom types so all locks share the same instance.
  const globalLock = customProvider && isCustomDatastoreConfig(config)
    ? customProvider.createLock(config.datastorePath)
    : await createDatastoreLock(config);
  const globalInfo = await globalLock.inspect();
  if (globalInfo) {
    logger.info(
      "Global lock held by {holder} — waiting for structural command to finish",
      { holder: globalInfo.holder },
    );
    // Poll until the global lock is released or expires (stale lock).
    // Timeout after 2x TTL to prevent indefinite hangs if staleness
    // detection fails (e.g. clock skew, S3 consistency issues).
    const globalWaitStart = Date.now();
    const globalMaxWaitMs = (globalInfo.ttlMs ?? 30_000) * 2;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const info = await globalLock.inspect();
      if (!info) break;
      // Check if the lock has exceeded its TTL (stale/crashed process)
      const acquiredAt = new Date(info.acquiredAt).getTime();
      if (Date.now() - acquiredAt > info.ttlMs) {
        logger.warn(
          "Global lock held by {holder} appears stale (exceeded TTL of {ttl}ms) — proceeding",
          { holder: info.holder, ttl: info.ttlMs },
        );
        await tryForceReleaseStaleLock(globalLock, info);
        break;
      }
      // Hard timeout to prevent indefinite hangs
      const globalElapsed = Date.now() - globalWaitStart;
      if (globalElapsed >= globalMaxWaitMs) {
        throw new LockTimeoutError(
          ".datastore.lock",
          info,
          globalElapsed,
        );
      }
    }
    logger.info`Global lock released, proceeding with per-model locks`;
  }

  // Sort models for deterministic lock ordering (deadlock prevention)
  const sorted = [...models].sort((a, b) => {
    const keyA = `${a.modelType}/${a.modelId}`;
    const keyB = `${b.modelType}/${b.modelId}`;
    return keyA.localeCompare(keyB);
  });

  // Deduplicate
  const seen = new Set<string>();
  const unique = sorted.filter((m) => {
    const key = `${m.modelType}/${m.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const lockKeys: string[] = [];

  for (const { modelType, modelId } of unique) {
    const key = `data/${modelType}/${modelId}/.lock`;
    // Use cached provider for custom types to avoid repeated registry lookups
    const lock = customProvider && isCustomDatastoreConfig(config)
      ? customProvider.createLock(config.datastorePath, { lockKey: key })
      : await createModelLock(config, modelType, modelId);
    // Register lock only (no sync service — we handle S3 pull/push manually)
    await registerDatastoreSyncNamed(key, { lock });
    lockKeys.push(key);

    // Re-check global lock after acquiring each per-model lock to close TOCTOU race.
    // If a structural command acquired the global lock between our initial check
    // and this per-model acquisition, release everything and wait.
    const postAcquireGlobalInfo = await globalLock.inspect();
    if (postAcquireGlobalInfo) {
      logger.info(
        "Global lock acquired by {holder} during per-model lock acquisition — releasing and retrying",
        { holder: postAcquireGlobalInfo.holder },
      );
      // Release all per-model locks acquired so far
      for (const acquiredKey of lockKeys) {
        await flushDatastoreSyncNamed(acquiredKey);
      }
      lockKeys.length = 0;

      // Wait for global lock to be released (with timeout)
      const retryWaitStart = Date.now();
      const retryMaxWaitMs = (postAcquireGlobalInfo.ttlMs ?? 30_000) * 2;
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const info = await globalLock.inspect();
        if (!info) break;
        const acquiredAt = new Date(info.acquiredAt).getTime();
        if (Date.now() - acquiredAt > info.ttlMs) {
          logger.warn(
            "Global lock held by {holder} appears stale (exceeded TTL of {ttl}ms) — proceeding",
            { holder: info.holder, ttl: info.ttlMs },
          );
          await tryForceReleaseStaleLock(globalLock, info);
          break;
        }
        const retryElapsed = Date.now() - retryWaitStart;
        if (retryElapsed >= retryMaxWaitMs) {
          throw new LockTimeoutError(
            ".datastore.lock",
            info,
            retryElapsed,
          );
        }
      }

      // Restart the entire per-model lock acquisition from scratch —
      // propagate the shared sync service so the retry keeps single-instance
      // semantics.
      return acquireModelLocks(config, models, repoDir, customSyncService);
    }

    // For custom sync-capable datastores: pull after acquiring per-model lock
    if (customSyncService) {
      try {
        logger.info("Syncing model {type}/{id} from datastore...", {
          type: modelType,
          id: modelId,
        });
        await customSyncService.pullChanged();
        synced = true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("Failed to pull model data from datastore: {error}", {
          error: msg,
        });
        throw new Error(
          `Datastore sync failed: could not pull data for ${modelType}/${modelId}: ${msg}`,
        );
      }
    }
  }

  Deno.env.set(SWAMP_LOCK_HOLDER_PID, String(Deno.pid));

  const flush = async () => {
    try {
      // For custom sync-capable datastores: push under global lock
      if (
        customSyncService && customProvider && isCustomDatastoreConfig(config)
      ) {
        const pushLock = customProvider.createLock(config.datastorePath);
        try {
          await pushLock.acquire();
          logger.info`Pushing changes to datastore...`;
          const pushed = await customSyncService.pushChanged();
          if (pushed && pushed > 0) {
            logger.info("Pushed {count} file(s) to datastore", {
              count: pushed,
            });
          } else {
            logger.info`Push complete, no changes`;
          }
        } catch (error) {
          const { summary, fields } = summarizeSyncError(
            "push",
            config.type,
            error,
          );
          logger.error("{summary}", { summary, ...fields });
          throw new Error(summary, { cause: error });
        } finally {
          try {
            await pushLock.release();
          } catch {
            // Best-effort release
          }
        }
      }
    } finally {
      // Always release per-model locks, even if S3 push fails
      for (const key of lockKeys) {
        await flushDatastoreSyncNamed(key);
      }
      Deno.env.delete(SWAMP_LOCK_HOLDER_PID);
    }
  };

  return { flush, synced };
}

/**
 * Creates the appropriate distributed lock for a datastore configuration.
 *
 * Used by the lock breakglass commands to inspect/release locks without
 * going through the full sync coordinator lifecycle.
 */
export async function createDatastoreLock(
  config: DatastoreConfig,
): Promise<DistributedLock> {
  if (isCustomDatastoreConfig(config)) {
    const provider = await resolveCustomProvider(config);
    return provider.createLock(config.datastorePath);
  }
  return new FileLock(config.path);
}
