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

import { Command } from "@cliffy/command";
import { ensureDir } from "@std/fs";
import { isAbsolute, join, resolve } from "@std/path";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import {
  DEFAULT_DATASTORE_SUBDIRS,
  getDatastoreDirectories,
} from "../../domain/datastore/datastore_config.ts";
import type { FilesystemDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import {
  migrateDatastore,
  verifyMigration,
} from "../../domain/datastore/datastore_migration_service.ts";
import {
  type DatastoreSetupData,
  renderDatastoreSetup,
} from "../../presentation/output/datastore_output.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  getSwampDataDir,
  SWAMP_DATA_DIR,
} from "../../infrastructure/persistence/paths.ts";
import { collapseEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { S3CacheSyncService } from "../../infrastructure/persistence/s3_cache_sync.ts";
import { S3Client } from "../../infrastructure/persistence/s3_client.ts";
import { S3DatastoreVerifier } from "../../infrastructure/persistence/s3_datastore_verifier.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const TOP_LEVEL_DIRS = ["models", "workflows", "vaults"] as const;

/**
 * Checks if the repository still uses the old symlink-based layout.
 * The old layout either has models/, workflows/, vaults/ as symlinks
 * themselves, or as real directories containing symlinks inside.
 * The user must run `swamp repo upgrade` before setting up a datastore.
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

/**
 * Checks if a directory contains any symlinks (recursive).
 */
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

const datastoreSetupFilesystemCommand = new Command()
  .description("Set up a filesystem datastore")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--path <path:string>", "Path for the datastore directory", {
    required: true,
  })
  .option(
    "--directories <dirs:string[]>",
    "Subdirectories to store in the datastore (comma-separated)",
  )
  .option("--skip-migration", "Skip migrating existing data")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "datastore",
      "setup",
      "filesystem",
    ]);

    const { repoDir } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    await requireUpgradedRepo(repoDir);

    // Resolve path
    const datastorePath = isAbsolute(options.path)
      ? options.path
      : resolve(repoDir, options.path);

    // Validate target is accessible
    await ensureDir(datastorePath);
    const verifier = new FilesystemDatastoreVerifier(datastorePath);
    const health = await verifier.verify();
    if (!health.healthy) {
      throw new UserError(
        `Datastore path is not accessible: ${health.message}`,
      );
    }

    // Build config
    const config: FilesystemDatastoreConfig = {
      type: "filesystem",
      path: datastorePath,
      directories: options.directories ?? undefined,
    };

    // Create datastore subdirectory structure
    const directories = getDatastoreDirectories(config);
    for (const subdir of directories) {
      await ensureDir(join(datastorePath, subdir));
    }

    // Migrate existing data
    let filesCopied = 0;
    let bytesCopied = 0;
    let directoriesMigrated: string[] = [];
    const errors: string[] = [];

    if (!options.skipMigration) {
      const logger = ctx.logger;
      logger.info`Migrating data to ${datastorePath}...`;
      const sourceDir = join(repoDir, SWAMP_DATA_DIR);
      const result = await migrateDatastore(sourceDir, datastorePath, config);
      filesCopied = result.filesCopied;
      bytesCopied = result.bytesCopied;
      directoriesMigrated = result.directoriesMigrated;
      errors.push(...result.errors);
      logger.info`Migrated ${filesCopied} file(s)`;

      // Verify migration
      const verification = await verifyMigration(
        sourceDir,
        datastorePath,
        config,
      );
      if (!verification.valid) {
        errors.push(
          `Migration verification: source has ${verification.sourceCount} files, destination has ${verification.destCount}`,
        );
      }

      // Clean up migrated directories from .swamp/ on success
      if (errors.length === 0 && directoriesMigrated.length > 0) {
        for (const subdir of directoriesMigrated) {
          try {
            await Deno.remove(join(sourceDir, subdir), { recursive: true });
          } catch {
            // Non-fatal: source dir may already be gone
          }
        }
      }
    }

    // Update .swamp.yaml with new datastore config
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    const marker = await markerRepo.read(repoPath);
    if (marker) {
      marker.datastore = {
        type: "filesystem",
        path: collapseEnvVars(datastorePath),
        directories: options.directories ?? [...DEFAULT_DATASTORE_SUBDIRS],
      };
      await markerRepo.write(repoPath, marker);
    }

    const data: DatastoreSetupData = {
      type: "filesystem",
      path: datastorePath,
      filesCopied,
      bytesCopied,
      directoriesMigrated,
      errors,
    };

    renderDatastoreSetup(data, ctx.outputMode);
  });

const datastoreSetupS3Command = new Command()
  .description("Set up an S3 datastore")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--bucket <bucket:string>", "S3 bucket name", { required: true })
  .option("--prefix <prefix:string>", "Key prefix within the bucket")
  .option("--region <region:string>", "AWS region")
  .option("--skip-migration", "Skip pushing existing data to S3")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "datastore",
      "setup",
      "s3",
    ]);

    const { repoDir } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });

    await requireUpgradedRepo(repoDir);

    const logger = ctx.logger;

    // Verify S3 bucket is accessible
    const verifier = new S3DatastoreVerifier(
      options.bucket,
      options.prefix,
      options.region,
    );
    const health = await verifier.verify();
    if (!health.healthy) {
      throw new UserError(
        `S3 bucket is not accessible: ${health.message}`,
      );
    }

    // Check if this S3 location already has datastore data
    const s3 = new S3Client({
      bucket: options.bucket,
      prefix: options.prefix,
      region: options.region,
    });
    try {
      await s3.getObject(".datastore-index.json");
      // Index exists — this is an active datastore
      throw new UserError(
        `S3 location s3://${options.bucket}/${
          options.prefix ?? ""
        } already contains a datastore. ` +
          `If you want to share this datastore, configure it in .swamp.yaml directly:\n\n` +
          `  datastore:\n` +
          `    type: s3\n` +
          `    bucket: ${options.bucket}\n` +
          (options.prefix ? `    prefix: ${options.prefix}\n` : "") +
          (options.region ? `    region: ${options.region}\n` : "") +
          `\nThen run 'swamp datastore sync --pull' to populate the local cache.`,
      );
    } catch (error) {
      if (error instanceof UserError) throw error;
      // Index doesn't exist — safe to proceed
    }

    // Update .swamp.yaml with S3 datastore config
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    const marker = await markerRepo.read(repoPath);
    if (marker) {
      marker.datastore = {
        type: "s3",
        bucket: options.bucket,
        prefix: options.prefix,
        region: options.region,
      };
      await markerRepo.write(repoPath, marker);
    }

    // Migrate existing data to S3
    let filesPushed = 0;
    const errors: string[] = [];

    if (!options.skipMigration) {
      // Compute cache path (same logic as resolveDatastoreConfig)
      const cachePath = join(
        getSwampDataDir(),
        "repos",
        marker?.repoId ?? "unknown",
      );

      // Migrate local .swamp/ runtime data to cache, then push to S3.
      // Only migrates when local data exists (not when switching between S3 buckets).
      const sourceDir = join(repoDir, SWAMP_DATA_DIR);
      const config = {
        type: "filesystem" as const,
        path: cachePath,
      };
      const migrationResult = await migrateDatastore(
        sourceDir,
        cachePath,
        config,
      );
      errors.push(...migrationResult.errors);

      // Push cache to S3
      logger.info`Pushing data to S3...`;

      const s3 = new S3Client({
        bucket: options.bucket,
        prefix: options.prefix,
        region: options.region,
      });
      const syncService = new S3CacheSyncService(s3, cachePath);

      try {
        filesPushed = await syncService.pushAll();
        logger.info`Pushed ${filesPushed} file(s) to S3`;
      } catch (error) {
        errors.push(
          `Failed to push to S3: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // Clean up migrated directories from local .swamp/ on success.
      // Only cleans up when local data was actually migrated (local → S3),
      // not when switching between S3 buckets.
      if (
        errors.length === 0 && migrationResult.filesCopied > 0 &&
        migrationResult.directoriesMigrated.length > 0
      ) {
        for (const subdir of migrationResult.directoriesMigrated) {
          try {
            await Deno.remove(join(sourceDir, subdir), { recursive: true });
          } catch {
            // Non-fatal: source dir may already be gone
          }
        }
        logger
          .info`Cleaned up ${migrationResult.directoriesMigrated.length} migrated directories from .swamp/`;
      }
    }

    const data: DatastoreSetupData = {
      type: "s3",
      bucket: options.bucket,
      prefix: options.prefix,
      filesCopied: filesPushed,
      bytesCopied: 0,
      directoriesMigrated: [],
      errors,
    };

    renderDatastoreSetup(data, ctx.outputMode);
  });

/**
 * Sets up a filesystem or S3 datastore.
 */
export const datastoreSetupCommand = new Command()
  .description("Configure a datastore for this repository")
  .command("filesystem", datastoreSetupFilesystemCommand)
  .command("s3", datastoreSetupS3Command);
