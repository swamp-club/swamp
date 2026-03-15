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

import { isAbsolute, join, resolve } from "@std/path";
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
import { resolveDatastoreConfig } from "./resolve_datastore.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { ensureDir } from "@std/fs";
import { S3CacheSyncService } from "../infrastructure/persistence/s3_cache_sync.ts";
import {
  flushDatastoreSyncNamed,
  registerDatastoreSync,
  registerDatastoreSyncNamed,
} from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { S3Lock } from "../infrastructure/persistence/s3_lock.ts";
import { S3Client } from "../infrastructure/persistence/s3_client.ts";
import { FileLock } from "../infrastructure/persistence/file_lock.ts";
import type { DistributedLock } from "../domain/datastore/distributed_lock.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

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

  const datastoreConfig = resolveDatastoreConfig(
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
 * For S3 datastores, this reads from the local cache without pulling
 * latest from S3. The cache reflects whatever was last synced by a
 * write command. For filesystem datastores, reads see writes immediately.
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
  if (datastoreConfig.type === "filesystem") {
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
  } else if (datastoreConfig.type === "s3") {
    // Ensure local cache directory exists for S3 datastore
    await ensureDir(datastoreConfig.cachePath);
    // No lock acquisition or sync — read-only path reads from local cache
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
export async function requireInitializedRepo(
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
  if (datastoreConfig.type === "filesystem") {
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

    // Wire file-based lock for filesystem datastores
    const lock = new FileLock(datastoreConfig.path);
    await registerDatastoreSync({ lock });
  } else if (datastoreConfig.type === "s3") {
    // Ensure local cache directory exists for S3 datastore
    await ensureDir(datastoreConfig.cachePath);

    // Share a single S3Client for both lock and sync service
    const s3 = new S3Client({
      bucket: datastoreConfig.bucket,
      prefix: datastoreConfig.prefix,
      region: datastoreConfig.region,
    });

    const lock = new S3Lock(s3);
    const syncService = new S3CacheSyncService(s3, datastoreConfig.cachePath);
    await registerDatastoreSync({ service: syncService, lock });
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

  return {
    repoDir: repoPath.value,
    repoContext,
    datastoreResolver,
  };
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
  if (datastoreConfig.type === "filesystem") {
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
  } else if (datastoreConfig.type === "s3") {
    await ensureDir(datastoreConfig.cachePath);
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
  if (config.type === "s3") {
    const s3 = new S3Client({
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
    });
    return new S3Lock(s3, { lockKey });
  }
  return new FileLock(config.path, { lockKey });
}

/**
 * Acquires per-model locks in sorted order (deadlock prevention).
 *
 * Checks for the global `.datastore.lock` before acquiring per-model locks.
 * If a structural command holds the global lock, per-model acquisition
 * waits for it to release (reuses existing stale detection).
 *
 * For S3 datastores, pulls model-scoped files after acquiring per-model
 * locks, and the returned flush function pushes changed files under a
 * brief global lock.
 *
 * Registers each lock with the coordinator so SIGINT cleanup works.
 *
 * @returns A flush function that releases all acquired per-model locks
 *          (and pushes to S3 + releases the global lock for S3 datastores).
 */
export async function acquireModelLocks(
  config: DatastoreConfig,
  models: Array<{ modelType: string; modelId: string }>,
): Promise<() => Promise<void>> {
  const logger = getSwampLogger(["datastore", "lock"]);

  // Wait for global lock to be released (if held by a structural command)
  const globalLock = createDatastoreLock(config);
  const globalInfo = await globalLock.inspect();
  if (globalInfo) {
    logger.info(
      "Global lock held by {holder} — waiting for structural command to finish",
      { holder: globalInfo.holder },
    );
    // Poll until the global lock is released
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const info = await globalLock.inspect();
      if (!info) break;
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

  // For S3 datastores, create a shared sync service for model-scoped pulls
  let s3SyncService: S3CacheSyncService | undefined;
  if (config.type === "s3") {
    const s3 = new S3Client({
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
    });
    s3SyncService = new S3CacheSyncService(s3, config.cachePath);
  }

  for (const { modelType, modelId } of unique) {
    const lock = createModelLock(config, modelType, modelId);
    const key = `data/${modelType}/${modelId}/.lock`;
    // Register lock only (no sync service — we handle S3 pull/push manually)
    await registerDatastoreSyncNamed(key, { lock });
    lockKeys.push(key);

    // For S3: pull model-scoped files after acquiring the per-model lock
    if (s3SyncService) {
      try {
        logger.info("Syncing model {type}/{id} from S3...", {
          type: modelType,
          id: modelId,
        });
        const pulled = await s3SyncService.pullChangedForModel(
          modelType,
          modelId,
        );
        if (pulled > 0) {
          logger.info`Synced ${pulled} file(s) from S3 for model`;
        }
      } catch (error) {
        logger.warn("Failed to pull model data from S3: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return async () => {
    // Release per-model locks first
    for (const key of lockKeys) {
      await flushDatastoreSyncNamed(key);
    }

    // For S3 datastores: acquire a brief global lock to push changed files
    // and update the index. This is held for seconds (uploading files),
    // not minutes (like method execution).
    if (s3SyncService && config.type === "s3") {
      const pushLock = createDatastoreLock(config);
      try {
        await pushLock.acquire();
        logger.info`Pushing changes to S3...`;
        const pushed = await s3SyncService.pushChanged();
        if (pushed > 0) {
          logger.info`Pushed ${pushed} file(s) to S3`;
        }
      } catch (error) {
        logger.warn("Failed to push changes to S3: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        try {
          await pushLock.release();
        } catch {
          // Best-effort release
        }
      }
    }
  };
}

/**
 * Creates the appropriate distributed lock for a datastore configuration.
 *
 * Used by the lock breakglass commands to inspect/release locks without
 * going through the full sync coordinator lifecycle.
 */
export function createDatastoreLock(config: DatastoreConfig): DistributedLock {
  if (config.type === "s3") {
    const s3 = new S3Client({
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
    });
    return new S3Lock(s3);
  }
  return new FileLock(config.path);
}
