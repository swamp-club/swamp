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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  type FilesystemDatastoreConfig,
  getDatastoreDirectories,
  type S3ConnectionConfig,
} from "../../domain/datastore/datastore_config.ts";
import {
  migrateDatastore,
  verifyMigration,
} from "../../domain/datastore/datastore_migration_service.ts";
import { UserError } from "../../domain/errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { collapseEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { getSwampDataDir } from "../../infrastructure/persistence/paths.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { S3CacheSyncService } from "../../infrastructure/persistence/s3_cache_sync.ts";
import { S3Client } from "../../infrastructure/persistence/s3_client.ts";
import { S3DatastoreVerifier } from "../../infrastructure/persistence/s3_datastore_verifier.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Output data for datastore setup operations. */
export interface DatastoreSetupData {
  type: string;
  path?: string;
  bucket?: string;
  prefix?: string;
  filesCopied: number;
  bytesCopied: number;
  directoriesMigrated: string[];
  errors: string[];
}

export type DatastoreSetupEvent =
  | { kind: "validating" }
  | { kind: "migrating" }
  | { kind: "completed"; data: DatastoreSetupData }
  | { kind: "error"; error: SwampError };

/** Input for filesystem datastore setup. */
export interface DatastoreSetupFilesystemInput {
  datastorePath: string;
  repoDir: string;
  directories?: string[];
  skipMigration: boolean;
}

/** Input for S3 datastore setup. */
export interface DatastoreSetupS3Input {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  repoDir: string;
  repoId?: string;
  skipMigration: boolean;
}

/** Dependencies for datastore setup operations. */
export interface DatastoreSetupDeps {
  requireUpgradedRepo: (repoDir: string) => Promise<void>;
  verifyPath: (
    path: string,
  ) => Promise<{ healthy: boolean; message: string }>;
  verifyS3: (
    config: S3ConnectionConfig,
  ) => Promise<{ healthy: boolean; message: string }>;
  checkS3DatastoreExists: (
    config: S3ConnectionConfig,
  ) => Promise<boolean>;
  ensureDir: (path: string) => Promise<void>;
  getDatastoreDirectories: (config: {
    type: string;
    directories?: string[];
  }) => readonly string[];
  migrateData: (
    sourceDir: string,
    destPath: string,
    config: { type: string; path: string },
  ) => Promise<{
    filesCopied: number;
    bytesCopied: number;
    directoriesMigrated: string[];
    errors: string[];
  }>;
  verifyMigration: (
    sourceDir: string,
    destPath: string,
    config: { type: string; path: string },
  ) => Promise<{ valid: boolean; sourceCount: number; destCount: number }>;
  cleanupSourceDirs: (sourceDir: string, dirs: string[]) => Promise<void>;
  updateRepoConfig: (
    repoDir: string,
    datastoreConfig: Record<string, unknown>,
  ) => Promise<void>;
  pushAllToS3: (
    config: S3ConnectionConfig,
    cachePath: string,
  ) => Promise<number>;
  getSwampDataDir: () => string;
  getCachePath: (repoId: string) => string;
  collapseEnvVars: (path: string) => string;
}

/** Sets up a filesystem datastore. */
export async function* datastoreSetupFilesystem(
  ctx: LibSwampContext,
  deps: DatastoreSetupDeps,
  input: DatastoreSetupFilesystemInput,
): AsyncIterable<DatastoreSetupEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.setup",
    { "datastore.type": "filesystem" },
    (async function* () {
      yield { kind: "validating" };

      try {
        await deps.requireUpgradedRepo(input.repoDir);
      } catch (err) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        };
        return;
      }

      // Validate target path is accessible
      await deps.ensureDir(input.datastorePath);
      const health = await deps.verifyPath(input.datastorePath);
      if (!health.healthy) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: `Datastore path is not accessible: ${health.message}`,
          },
        };
        return;
      }

      // Create datastore subdirectory structure
      const directories = deps.getDatastoreDirectories({
        type: "filesystem",
        directories: input.directories,
      });
      for (const subdir of directories) {
        await deps.ensureDir(`${input.datastorePath}/${subdir}`);
      }

      // Migrate existing data
      let filesCopied = 0;
      let bytesCopied = 0;
      let directoriesMigrated: string[] = [];
      const errors: string[] = [];

      if (!input.skipMigration) {
        yield { kind: "migrating" };
        ctx.logger.debug`Migrating data to ${input.datastorePath}...`;
        const sourceDir = `${input.repoDir}/.swamp`;
        const config = {
          type: "filesystem" as const,
          path: input.datastorePath,
        };
        const result = await deps.migrateData(
          sourceDir,
          input.datastorePath,
          config,
        );
        filesCopied = result.filesCopied;
        bytesCopied = result.bytesCopied;
        directoriesMigrated = result.directoriesMigrated;
        errors.push(...result.errors);

        // Verify migration
        const verification = await deps.verifyMigration(
          sourceDir,
          input.datastorePath,
          config,
        );
        if (!verification.valid) {
          errors.push(
            `Migration verification: source has ${verification.sourceCount} files, destination has ${verification.destCount}`,
          );
        }

        // Clean up migrated directories from .swamp/ on success
        if (errors.length === 0 && directoriesMigrated.length > 0) {
          await deps.cleanupSourceDirs(sourceDir, directoriesMigrated);
        }
      }

      // Update .swamp.yaml with new datastore config
      const collapsedPath = deps.collapseEnvVars(input.datastorePath);
      await deps.updateRepoConfig(input.repoDir, {
        type: "filesystem",
        path: collapsedPath,
        directories: input.directories ?? undefined,
      });

      yield {
        kind: "completed",
        data: {
          type: "filesystem",
          path: input.datastorePath,
          filesCopied,
          bytesCopied,
          directoriesMigrated,
          errors,
        },
      };
    })(),
  );
}

/** Sets up an S3 datastore. */
export async function* datastoreSetupS3(
  ctx: LibSwampContext,
  deps: DatastoreSetupDeps,
  input: DatastoreSetupS3Input,
): AsyncIterable<DatastoreSetupEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.setup",
    { "datastore.type": "s3" },
    (async function* () {
      yield { kind: "validating" };

      try {
        await deps.requireUpgradedRepo(input.repoDir);
      } catch (err) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        };
        return;
      }

      // Build connection config once from input
      const s3Conn: S3ConnectionConfig = {
        bucket: input.bucket,
        prefix: input.prefix,
        region: input.region,
        endpoint: input.endpoint,
        forcePathStyle: input.forcePathStyle,
      };

      // Verify S3 bucket is accessible
      const health = await deps.verifyS3(s3Conn);
      if (!health.healthy) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: `S3 bucket is not accessible: ${health.message}`,
          },
        };
        return;
      }

      // Check if this S3 location already has datastore data
      const exists = await deps.checkS3DatastoreExists(s3Conn);
      if (exists) {
        const prefixStr = input.prefix ?? "";
        yield {
          kind: "error",
          error: {
            code: "already_exists",
            message:
              `S3 location s3://${input.bucket}/${prefixStr} already contains a datastore. ` +
              `If you want to share this datastore, configure it in .swamp.yaml directly:\n\n` +
              `  datastore:\n` +
              `    type: s3\n` +
              `    bucket: ${input.bucket}\n` +
              (input.prefix ? `    prefix: ${input.prefix}\n` : "") +
              (input.region ? `    region: ${input.region}\n` : "") +
              `\nThen run 'swamp datastore sync --pull' to populate the local cache.`,
          },
        };
        return;
      }

      // Update .swamp.yaml with S3 datastore config
      await deps.updateRepoConfig(input.repoDir, {
        type: "s3",
        bucket: input.bucket,
        prefix: input.prefix,
        region: input.region,
        endpoint: input.endpoint,
        forcePathStyle: input.forcePathStyle,
      });

      // Migrate existing data to S3
      let filesPushed = 0;
      const errors: string[] = [];

      if (!input.skipMigration) {
        yield { kind: "migrating" };

        // Compute cache path
        const cachePath = deps.getCachePath(input.repoId ?? "unknown");
        const sourceDir = `${input.repoDir}/.swamp`;
        const config = { type: "filesystem" as const, path: cachePath };

        // Migrate local .swamp/ to cache, then push to S3
        const migrationResult = await deps.migrateData(
          sourceDir,
          cachePath,
          config,
        );
        errors.push(...migrationResult.errors);

        // Push cache to S3
        ctx.logger.debug`Pushing data to S3...`;
        try {
          filesPushed = await deps.pushAllToS3(s3Conn, cachePath);
          ctx.logger.debug`Pushed ${filesPushed} file(s) to S3`;
        } catch (error) {
          errors.push(
            `Failed to push to S3: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        // Clean up migrated directories from local .swamp/ on success
        if (
          errors.length === 0 && migrationResult.filesCopied > 0 &&
          migrationResult.directoriesMigrated.length > 0
        ) {
          await deps.cleanupSourceDirs(
            sourceDir,
            migrationResult.directoriesMigrated,
          );
        }
      }

      yield {
        kind: "completed",
        data: {
          type: "s3",
          bucket: input.bucket,
          prefix: input.prefix,
          filesCopied: filesPushed,
          bytesCopied: 0,
          directoriesMigrated: [],
          errors,
        },
      };
    })(),
  );
}

const TOP_LEVEL_DIRS = ["models", "workflows", "vaults"] as const;

/**
 * Checks if the repository still uses the old symlink-based layout.
 */
async function requireUpgradedRepo(repoDir: string): Promise<void> {
  const dirsWithSymlinks: string[] = [];
  for (const dir of TOP_LEVEL_DIRS) {
    const dirPath = join(repoDir, dir);
    try {
      const stat = await Deno.lstat(dirPath);
      if (stat.isSymlink) {
        dirsWithSymlinks.push(dir);
        continue;
      }
      if (stat.isDirectory && await hasSymlinks(dirPath)) {
        dirsWithSymlinks.push(dir);
      }
    } catch {
      // Directory doesn't exist — that's fine
    }
  }
  if (dirsWithSymlinks.length > 0) {
    throw new UserError(
      `This repository has symlinks in ${
        dirsWithSymlinks.join(", ")
      }/ from an old layout. ` +
        `Run 'swamp repo upgrade' before setting up a datastore.`,
    );
  }
}

async function hasSymlinks(dirPath: string): Promise<boolean> {
  for await (const entry of Deno.readDir(dirPath)) {
    if (entry.isSymlink) {
      return true;
    }
    if (entry.isDirectory) {
      if (await hasSymlinks(join(dirPath, entry.name))) {
        return true;
      }
    }
  }
  return false;
}

/** Creates real infrastructure deps for datastore setup. */
export function createDatastoreSetupDeps(
  _repoDir: string,
): DatastoreSetupDeps {
  return {
    requireUpgradedRepo,
    verifyPath: async (path: string) => {
      const verifier = new FilesystemDatastoreVerifier(path);
      return await verifier.verify();
    },
    verifyS3: async (config) => {
      const verifier = new S3DatastoreVerifier(config);
      return await verifier.verify();
    },
    checkS3DatastoreExists: async (config) => {
      const s3 = new S3Client(config);
      try {
        await s3.getObject(".datastore-index.json");
        return true;
      } catch {
        return false;
      }
    },
    ensureDir,
    getDatastoreDirectories: (config) =>
      getDatastoreDirectories(config as FilesystemDatastoreConfig),
    migrateData: (sourceDir, destPath, config) =>
      migrateDatastore(
        sourceDir,
        destPath,
        config as FilesystemDatastoreConfig,
      ),
    verifyMigration: (sourceDir, destPath, config) =>
      verifyMigration(
        sourceDir,
        destPath,
        config as FilesystemDatastoreConfig,
      ),
    cleanupSourceDirs: async (sourceDir: string, dirs: string[]) => {
      for (const subdir of dirs) {
        try {
          await Deno.remove(join(sourceDir, subdir), { recursive: true });
        } catch {
          // Non-fatal: source dir may already be gone
        }
      }
    },
    updateRepoConfig: async (
      dir: string,
      datastoreConfig: Record<string, unknown>,
    ) => {
      const markerRepo = new RepoMarkerRepository();
      const repoPath = RepoPath.create(dir);
      const marker = await markerRepo.read(repoPath);
      if (marker) {
        marker.datastore =
          datastoreConfig as unknown as typeof marker.datastore;
        await markerRepo.write(repoPath, marker);
      }
    },
    pushAllToS3: async (config, cachePath) => {
      const s3 = new S3Client(config);
      const syncService = new S3CacheSyncService(s3, cachePath);
      return await syncService.pushAll();
    },
    getSwampDataDir,
    getCachePath: (repoId: string) => join(getSwampDataDir(), "repos", repoId),
    collapseEnvVars,
  };
}
