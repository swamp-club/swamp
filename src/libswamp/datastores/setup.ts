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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  DEFAULT_SYNC_TIMEOUT_MS,
  type FilesystemDatastoreConfig,
  getDatastoreDirectories,
  SYNC_TIMEOUT_ENV_VAR,
} from "../../domain/datastore/datastore_config.ts";
import {
  migrateDatastore,
  verifyMigration,
} from "../../domain/datastore/datastore_migration_service.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { createNamespace } from "../../domain/data/namespace.ts";
import { UserError } from "../../domain/errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { collapseEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { getSwampDataDir } from "../../infrastructure/persistence/paths.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { summarizeSyncError } from "../../infrastructure/persistence/sync_error_diagnostic.ts";
import { SyncTimeoutError } from "../../domain/datastore/datastore_sync_service.ts";
import { writeNamespaceManifest } from "../../infrastructure/persistence/namespace_manifest.ts";
import { runBoundedSync } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Output data for datastore setup operations. */
export interface DatastoreSetupData {
  type: string;
  path?: string;
  filesCopied: number;
  /**
   * Files pulled from the remote datastore into the local cache during
   * setup hydration. Always 0 for filesystem datastores (no separate
   * cache to hydrate). For extension datastores, reflects the count
   * returned by the sync service's pullChanged after migration.
   */
  filesPulled: number;
  bytesCopied: number;
  directoriesMigrated: string[];
  errors: string[];
  retryHint?: string;
  namespace?: string;
}

export interface DatastoreSetupWarningData {
  message: string;
  existingNamespaces: string[];
}

export type DatastoreSetupEvent =
  | { kind: "validating" }
  | { kind: "migrating" }
  | { kind: "hydrating" }
  | { kind: "warning"; data: DatastoreSetupWarningData }
  | { kind: "completed"; data: DatastoreSetupData }
  | { kind: "error"; error: SwampError };

/** Input for filesystem datastore setup. */
export interface DatastoreSetupFilesystemInput {
  datastorePath: string;
  repoDir: string;
  directories?: string[];
  skipMigration: boolean;
}

/** Dependencies for datastore setup operations. */
export interface DatastoreSetupDeps {
  requireUpgradedRepo: (repoDir: string) => Promise<void>;
  verifyPath: (
    path: string,
  ) => Promise<{ healthy: boolean; message: string }>;
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

      // Update .swamp.yaml only when migration succeeded (or was skipped).
      // Mirrors the extension path guard — avoids pointing the config at
      // a destination with incomplete data.
      if (errors.length === 0) {
        const collapsedPath = deps.collapseEnvVars(input.datastorePath);
        await deps.updateRepoConfig(input.repoDir, {
          type: "filesystem",
          path: collapsedPath,
          directories: input.directories ?? undefined,
        });
      }

      yield {
        kind: "completed",
        data: {
          type: "filesystem",
          path: input.datastorePath,
          filesCopied,
          filesPulled: 0,
          bytesCopied,
          directoriesMigrated,
          errors,
          ...(errors.length > 0
            ? {
              retryHint:
                "Re-run the same command to retry. Local data is preserved and the retry is safe.",
            }
            : {}),
        },
      };
    })(),
  );
}

/** Input for extension datastore setup. */
export interface DatastoreSetupExtensionInput {
  type: string;
  config: Record<string, unknown>;
  repoDir: string;
  repoId?: string;
  skipMigration: boolean;
  hydrationStrategy?: "full" | "lazy";
  namespace?: string;
  syncTimeoutMsOverride?: number;
}

/** Sets up an extension-provided datastore. */
export async function* datastoreSetupExtension(
  ctx: LibSwampContext,
  deps: DatastoreSetupDeps,
  input: DatastoreSetupExtensionInput,
): AsyncIterable<DatastoreSetupEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.setup",
    { "datastore.type": input.type },
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

      // Look up the extension type in the registry
      await datastoreTypeRegistry.ensureTypeLoaded(input.type);
      const typeInfo = datastoreTypeRegistry.get(input.type);
      if (!typeInfo?.createProvider) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message:
              `Datastore type "${input.type}" is not registered or has no provider. ` +
              `Install it with: swamp extension pull ${input.type}`,
          },
        };
        return;
      }

      // Validate config against extension schema
      if (typeInfo.configSchema) {
        const result = typeInfo.configSchema.safeParse(input.config);
        if (!result.success) {
          yield {
            kind: "error",
            error: {
              code: "validation_failed",
              message:
                `Invalid config for "${input.type}": ${result.error.message}`,
            },
          };
          return;
        }
      }

      // Create provider and verify health
      const provider = typeInfo.createProvider(input.config);
      const verifier = provider.createVerifier();
      const health = await verifier.verify();
      if (!health.healthy) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: `Datastore is not accessible: ${health.message}`,
          },
        };
        return;
      }

      // Check for existing data at the remote prefix and warn if no
      // namespace is set. This prevents silently absorbing foreign data.
      if (provider.listNamespaces) {
        const datastorePath = provider.resolveDatastorePath(input.repoDir);
        try {
          const remoteNamespaces = await provider.listNamespaces(
            datastorePath,
          );
          if (remoteNamespaces.length > 0 && !input.namespace) {
            yield {
              kind: "warning",
              data: {
                message:
                  `This datastore contains existing namespaces: ${
                    remoteNamespaces.join(", ")
                  }. ` +
                  `Set a namespace with 'swamp datastore namespace set <name>' before ` +
                  `connecting to avoid absorbing foreign data.`,
                existingNamespaces: remoteNamespaces,
              },
            };
          }
        } catch (error) {
          ctx.logger
            .debug`Failed to list remote namespaces (non-fatal): ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }

      // Migrate existing data, then hydrate the cache from the remote.
      // Both legs share the same syncService instance and timeout — the
      // sync service is constructed once up front and reused for the
      // optional push and the unconditional pull below.
      const errors: string[] = [];
      let filesCopied = 0;
      let filesPulled = 0;
      let onlyTimeouts = true;

      // Setup runs outside the flush coordinator, so it does not pick up
      // per-config syncTimeoutMs. Resolution: CLI --timeout > env var > default.
      const timeoutMs = (() => {
        if (
          input.syncTimeoutMsOverride != null && input.syncTimeoutMsOverride > 0
        ) {
          return input.syncTimeoutMsOverride;
        }
        const envValue = Deno.env.get(SYNC_TIMEOUT_ENV_VAR);
        const parsedTimeout = envValue ? Number.parseInt(envValue, 10) : NaN;
        return Number.isFinite(parsedTimeout) && parsedTimeout > 0
          ? parsedTimeout
          : DEFAULT_SYNC_TIMEOUT_MS;
      })();

      const cachePath = provider.resolveCachePath?.(input.repoDir) ??
        join(getSwampDataDir(), "repos", input.repoId ?? "unknown");
      const syncService = provider.createSyncService?.(
        input.repoDir,
        cachePath,
      );
      const ns = input.namespace;

      if (ns) {
        try {
          createNamespace(ns);
        } catch (error) {
          yield {
            kind: "error",
            error: {
              code: "validation_failed",
              message: `Invalid namespace: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          };
          return;
        }
      }

      let migrationResult:
        | {
          filesCopied: number;
          directoriesMigrated: string[];
        }
        | undefined;

      if (!input.skipMigration && syncService) {
        yield { kind: "migrating" };

        const sourceDir = `${input.repoDir}/.swamp`;

        // Migrate local .swamp/ data to cache path
        const config = { type: "filesystem" as const, path: cachePath };
        const result = await deps.migrateData(
          sourceDir,
          cachePath,
          config,
        );
        errors.push(...result.errors);
        if (result.errors.length > 0) onlyTimeouts = false;
        filesCopied = result.filesCopied;
        migrationResult = result;

        // Push cache to remote via sync service. Always pass namespace
        // so the extension scopes the push to {namespace}/ on the remote.
        if (result.filesCopied > 0) {
          ctx.logger.debug`Pushing data to remote datastore...`;
          try {
            await runBoundedSync(
              input.type,
              "push",
              timeoutMs,
              (signal) =>
                syncService.pushChanged({
                  signal,
                  namespace: ns,
                }),
            );
            ctx.logger.debug`Push complete`;
          } catch (error) {
            if (!(error instanceof SyncTimeoutError)) onlyTimeouts = false;
            const { summary } = summarizeSyncError(
              "push",
              input.type,
              error,
            );
            errors.push(summary);
          }
        }
      }

      // Hydrate the local cache from the remote. Runs unconditionally
      // when the extension exposes a sync service — independent of
      // --skip-migration. Migration moves data UP (local → remote);
      // hydration moves data DOWN (remote → local). A contributor
      // joining a populated remote needs hydration even when there is
      // nothing local to migrate. Runs AFTER the optional push so any
      // files we just migrated are already in the remote index when
      // pullChanged walks it (size match → no redundant download).
      if (syncService && errors.length === 0) {
        // Belt-and-suspenders: ensure the cache directory exists before
        // pull. The non-skip path creates it implicitly via migrateData;
        // the skip path doesn't, so a sync service that doesn't ensureDir
        // internally would ENOENT on the first pulled file write.
        await deps.ensureDir(cachePath);
        yield { kind: "hydrating" };
        ctx.logger.debug`Hydrating cache from remote datastore...`;
        try {
          // Always pass namespace so the extension scopes the pull to
          // {namespace}/ on the remote. Without this, the extension
          // reads the root index and downloads ALL data — including
          // foreign namespaces — into the local cache (#1314, #1320).
          const pulled = await runBoundedSync(
            input.type,
            "pull",
            timeoutMs,
            (signal) =>
              syncService.pullChanged({
                signal,
                namespace: ns,
                ...(input.hydrationStrategy === "lazy"
                  ? { metadataOnly: true }
                  : {}),
              }),
          );
          filesPulled = typeof pulled === "number" ? pulled : 0;
          ctx.logger.debug`Hydration complete: ${filesPulled} file(s) pulled`;
        } catch (error) {
          if (!(error instanceof SyncTimeoutError)) onlyTimeouts = false;
          const { summary } = summarizeSyncError(
            "pull",
            input.type,
            error,
          );
          errors.push(summary);
        }
      }

      // Clean up migrated directories from .swamp/ only after BOTH push
      // and pull have succeeded. Pull failure must keep .swamp/ intact
      // so the user can retry setup without losing local data.
      if (
        migrationResult &&
        errors.length === 0 &&
        migrationResult.filesCopied > 0 &&
        migrationResult.directoriesMigrated.length > 0
      ) {
        await deps.cleanupSourceDirs(
          `${input.repoDir}/.swamp`,
          migrationResult.directoriesMigrated,
        );
      }

      // Update .swamp.yaml when data movement succeeded OR when only
      // timeouts occurred. A timeout means the datastore is correctly
      // configured but the data transfer was slow — the user can resume
      // with `swamp datastore sync --push --timeout <big>`. Hard failures
      // (auth, network, config) still block the type commit.
      // Persist the datastore config to .swamp.yaml. Always include
      // namespace when one was resolved — this replaces the entire
      // datastore block, so omitting it would drop a pre-set namespace.
      if (errors.length === 0 || onlyTimeouts) {
        const persistedConfig: Record<string, unknown> = {
          type: input.type,
          config: input.config,
        };
        if (input.hydrationStrategy) {
          persistedConfig.hydrationStrategy = input.hydrationStrategy;
        }
        if (ns) {
          persistedConfig.namespace = ns;
        }
        await deps.updateRepoConfig(input.repoDir, persistedConfig);
      }

      // Register namespace manifest after config is persisted.
      // provider.registerNamespace handles conflict detection internally.
      if ((errors.length === 0 || onlyTimeouts) && ns && input.repoId) {
        const datastorePath = provider.resolveDatastorePath(input.repoDir);
        if (provider.registerNamespace) {
          try {
            await provider.registerNamespace(datastorePath, ns, input.repoId);
            // Materialize the manifest into the local cache so push's
            // orphan detection sees a local counterpart and does not
            // delete the remote copy (swamp-club#834).
            await writeNamespaceManifest(cachePath, ns, input.repoId);
            ctx.logger.info`Registered namespace ${ns} in datastore`;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            ctx.logger
              .warn`Namespace registration failed: ${msg}`;
          }
        } else {
          ctx.logger
            .warn`Datastore backend does not support namespace registration — conflict detection is unavailable`;
        }
      }

      yield {
        kind: "completed",
        data: {
          type: input.type,
          filesCopied,
          filesPulled,
          bytesCopied: 0,
          directoriesMigrated: [],
          errors,
          ...(ns ? { namespace: ns } : {}),
          ...(errors.length > 0
            ? {
              retryHint:
                "Re-run the same command to retry. Local data is preserved and the retry is safe.",
            }
            : {}),
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
    collapseEnvVars,
  };
}
