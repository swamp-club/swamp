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

import { isAbsolute, join, relative, resolve } from "@std/path";
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
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import { resolveDatastoreConfig } from "./resolve_datastore.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { ensureDir, walk } from "@std/fs";
import {
  flushDatastoreSyncNamed,
  registerDatastoreSync,
  registerDatastoreSyncNamed,
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { FileLock } from "../infrastructure/persistence/file_lock.ts";
import {
  type DistributedLock,
  LockTimeoutError,
} from "../domain/datastore/distributed_lock.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../domain/datastore/datastore_provider.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";

/**
 * Resolves a DatastoreProvider for a custom datastore config.
 */
function resolveCustomProvider(
  config: CustomDatastoreConfig,
): DatastoreProvider {
  const typeInfo = datastoreTypeRegistry.get(config.type);
  if (!typeInfo?.createProvider) {
    throw new UserError(
      `Datastore type "${config.type}" is not registered or has no provider.`,
    );
  }
  return typeInfo.createProvider(config.config);
}

/**
 * Options for requireInitializedRepo.
 */
export interface RequireRepoOptions {
  repoDir: string;
  outputMode: OutputMode;
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

  // Create repository context with the validated directory and datastore resolver
  const repoContext = createRepositoryContext({
    repoDir: repoPath.value,
    workflowsDir,
    additionalWorkflowsDirs: [
      swampPath(repoPath.value, SWAMP_SUBDIRS.pulledWorkflows),
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

    // Verify datastore is accessible
    if (isCustomDatastoreConfig(datastoreConfig)) {
      const provider = resolveCustomProvider(datastoreConfig);
      const lock = provider.createLock(datastoreConfig.datastorePath);

      // If the custom provider supports sync, register sync service too
      const syncService = datastoreConfig.cachePath
        ? provider.createSyncService?.(
          repoPath.value,
          datastoreConfig.cachePath,
        )
        : undefined;

      if (datastoreConfig.cachePath) {
        await ensureDir(datastoreConfig.cachePath);
      }

      await registerDatastoreSync({
        service: syncService,
        lock,
        label: datastoreConfig.type,
      });
      // Invalidate catalog after pull so next query backfills from fresh data
      if (syncService) {
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

      // Wait for any held per-model locks to be released before acquiring global lock.
      // This prevents the global lock from racing with in-progress per-model operations.
      await waitForPerModelLocks(datastoreConfig.path);

      // Wire file-based lock for filesystem datastores
      const lock = new FileLock(datastoreConfig.path);
      await registerDatastoreSync({ lock });
    }

    // Compute top-level directories for definitions, workflows, and vaults
    const definitionsDir = join(repoPath.value, "models");
    const yamlWorkflowsDir = join(repoPath.value, "workflows");
    const vaultsDir = join(repoPath.value, "vaults");

    // Create repository context with the validated directory and datastore resolver
    const repoContext = createRepositoryContext({
      repoDir: repoPath.value,
      workflowsDir,
      definitionsDir,
      yamlWorkflowsDir,
      vaultsDir,
      datastoreResolver,
      ...factoryConfig,
    });

    // If a remote sync pulled fresh data, invalidate the catalog so the
    // next query backfills from the freshly-pulled local cache.
    if (needsCatalogInvalidation) {
      repoContext.catalogStore?.invalidate();
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
): Promise<RepoValidationContext & { datastoreConfig: DatastoreConfig }> {
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

  // Verify datastore is accessible (same checks as requireInitializedRepo)
  if (isCustomDatastoreConfig(datastoreConfig)) {
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
  }

  // Compute top-level directories for definitions, workflows, and vaults
  const definitionsDir = join(repoPath.value, "models");
  const yamlWorkflowsDir = join(repoPath.value, "workflows");
  const vaultsDir = join(repoPath.value, "vaults");

  // Create repository context with the validated directory and datastore resolver
  const repoContext = createRepositoryContext({
    repoDir: repoPath.value,
    workflowsDir,
    additionalWorkflowsDirs: [
      swampPath(repoPath.value, SWAMP_SUBDIRS.pulledWorkflows),
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
    datastoreConfig,
  };
}

/**
 * Creates a per-model distributed lock.
 *
 * Lock key: `data/{modelType}/{modelId}/.lock`
 */
export function createModelLock(
  config: DatastoreConfig,
  modelType: string,
  modelId: string,
): DistributedLock {
  const lockKey = `data/${modelType}/${modelId}/.lock`;
  if (isCustomDatastoreConfig(config)) {
    const provider = resolveCustomProvider(config);
    return provider.createLock(config.datastorePath, { lockKey });
  }
  return new FileLock(config.path, { lockKey });
}

/**
 * Waits for any held per-model locks to be released.
 *
 * Called before acquiring the global lock so that structural commands
 * (data gc, model create/delete) don't race with in-progress per-model
 * operations. Only works for filesystem datastores — S3 datastores use
 * distributed locks that cannot be scanned locally.
 */
async function waitForPerModelLocks(datastorePath: string): Promise<void> {
  const logger = getSwampLogger(["datastore", "lock"]);

  const findModelLocks = async (): Promise<number> => {
    let count = 0;
    try {
      for await (
        const entry of walk(datastorePath, {
          includeDirs: false,
          match: [/\.lock$/],
        })
      ) {
        const rel = relative(datastorePath, entry.path);
        const parts = rel.split("/");
        // Match pattern: data/{modelType}/{modelId}/.lock
        if (
          parts.length === 4 && parts[0] === "data" && parts[3] === ".lock"
        ) {
          try {
            const content = await Deno.readTextFile(entry.path);
            const info = JSON.parse(content) as {
              acquiredAt: string;
              ttlMs: number;
            };
            // Only count non-stale locks
            const acquiredAt = new Date(info.acquiredAt).getTime();
            if (Date.now() - acquiredAt <= info.ttlMs) {
              count++;
            }
          } catch {
            // Skip unreadable lock files
          }
        }
      }
    } catch {
      // Datastore directory may not exist yet
    }
    return count;
  };

  const held = await findModelLocks();
  if (held > 0) {
    logger.info(
      "Waiting for {count} per-model lock(s) to be released before acquiring global lock",
      { count: held },
    );
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const remaining = await findModelLocks();
      if (remaining === 0) break;
    }
    logger.info`Per-model locks released, proceeding with global lock`;
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

export async function acquireModelLocks(
  config: DatastoreConfig,
  models: Array<{ modelType: string; modelId: string }>,
  repoDir?: string,
): Promise<ModelLockResult> {
  const logger = getSwampLogger(["datastore", "lock"]);
  let synced = false;

  // For custom datastores, resolve the provider once and reuse it everywhere
  let customProvider: DatastoreProvider | undefined;
  let customSyncService:
    | ReturnType<NonNullable<DatastoreProvider["createSyncService"]>>
    | undefined;
  if (isCustomDatastoreConfig(config)) {
    customProvider = resolveCustomProvider(config);
    if (config.cachePath) {
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
    : createDatastoreLock(config);
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
      : createModelLock(config, modelType, modelId);
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

      // Restart the entire per-model lock acquisition from scratch
      return acquireModelLocks(config, models, repoDir);
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
          const msg = error instanceof Error ? error.message : String(error);
          logger.error("Failed to push changes to datastore: {error}", {
            error: msg,
          });
          throw new Error(
            `Datastore sync failed: could not push changes: ${msg}`,
          );
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
export function createDatastoreLock(config: DatastoreConfig): DistributedLock {
  if (isCustomDatastoreConfig(config)) {
    const provider = resolveCustomProvider(config);
    return provider.createLock(config.datastorePath);
  }
  return new FileLock(config.path);
}
