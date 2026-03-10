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
import { RepoMarkerRepository } from "../infrastructure/persistence/repo_marker_repository.ts";
import { UserError } from "../domain/errors.ts";
import { VERSION } from "./commands/version.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";
import { resolveDatastoreConfig } from "./resolve_datastore.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { ensureDir } from "@std/fs";
import { S3CacheSyncService } from "../infrastructure/persistence/s3_cache_sync.ts";
import { registerDatastoreSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { S3Lock } from "../infrastructure/persistence/s3_lock.ts";
import { S3Client } from "../infrastructure/persistence/s3_client.ts";
import { FileLock } from "../infrastructure/persistence/file_lock.ts";
import type { DistributedLock } from "../domain/datastore/distributed_lock.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";

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
 * Validates that a directory is an initialized swamp repository.
 *
 * Throws a UserError with helpful instructions if the directory
 * is not initialized.
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
  const { repoDir } = options;

  const repoPath = RepoPath.create(repoDir);
  const service = new RepoService(VERSION);
  const isInit = await service.isInitialized(repoPath);

  if (!isInit) {
    throw new UserError(
      `Not a swamp repository: ${repoPath.value}. To initialize a new repository, run 'swamp repo init', or specify an existing repository with 'swamp <command> --repo-dir /path/to/repo'.`,
    );
  }

  // Read marker to resolve workflowsDir and datastore config
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(repoPath);

  const workflowsDirRel = resolveWorkflowsDir(marker);
  const workflowsDir = isAbsolute(workflowsDirRel)
    ? workflowsDirRel
    : resolve(repoPath.value, workflowsDirRel);

  // Resolve datastore configuration
  const datastoreConfig = resolveDatastoreConfig(
    marker,
    undefined,
    repoPath.value,
  );
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
