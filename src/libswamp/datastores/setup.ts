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
import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path";
import {
  classifyInRepoConfig,
  type ConfigTierConflict,
  type DatastoreConfigData,
  DEFAULT_SYNC_TIMEOUT_MS,
  type FilesystemDatastoreConfig,
  getDatastoreDirectories,
  inRepoConfigMigrationSkips,
  type InRepoConfigRole,
  mergeSetupDatastoreBlock,
  planConfigTierMerge,
  PULLED_EXTENSIONS_SUBDIR,
  SYNC_TIMEOUT_ENV_VAR,
} from "../../domain/datastore/datastore_config.ts";
import {
  migrateDatastore,
  verifyMigration,
} from "../../domain/datastore/datastore_migration_service.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import {
  getMigrationSentinelPath,
  isConfigTierPopulated,
} from "../../domain/datastore/managed_config_migration.ts";
import { createNamespace } from "../../domain/data/namespace.ts";
import { UserError } from "../../domain/errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { collapseEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import {
  getSwampDataDir,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
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
  sourcePath?: string;
  destinationPath?: string;
}

/** A warning raised during datastore setup, keyed by `code`. */
export type DatastoreSetupWarningData =
  | {
    code: "existing_namespaces";
    message: string;
    existingNamespaces: string[];
  }
  | {
    /**
     * managedConfig is on but the new datastore's config tier holds no
     * config (swamp-club#2845).
     */
    code: "empty_config_tier";
    message: string;
    configTierPath: string;
  }
  | {
    /**
     * The datastore already had a config tier, so local config files that
     * differ from it were not uploaded and stay in the repo
     * (swamp-club#2844).
     */
    code: "remote_config_tier_kept";
    message: string;
    /** Paths relative to `localConfigPath`. */
    keptPaths: string[];
    localConfigPath: string;
  };

/**
 * The config tier of the datastore `.swamp.yaml` names. `tierPath` is
 * undefined when that datastore cannot be resolved.
 */
export type ManagedConfigTierInspection =
  | { managed: false }
  | { managed: true; tierPath: string | undefined; populated: boolean };

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
  /**
   * When switching from a remote/sync-based datastore, the absolute path
   * to the outgoing datastore's local cache (e.g. ~/.swamp/repos/{repoId}).
   * If provided and the directory exists, migration reads from this path
   * instead of {repoDir}/.swamp.
   */
  outgoingCachePath?: string;
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
  /**
   * Copies the datastore subdirs from `sourceDir` to `destPath`, leaving
   * out `skip` (paths relative to `sourceDir`).
   */
  migrateData: (
    sourceDir: string,
    destPath: string,
    config: { type: string; path: string },
    skip?: readonly string[],
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
    skip?: readonly string[],
  ) => Promise<{ valid: boolean; sourceCount: number; destCount: number }>;
  /**
   * Removes the migrated `dirs` from `sourceDir`, leaving any `keep` path
   * (relative to `sourceDir`) that lies inside one of them in place.
   */
  cleanupSourceDirs: (
    sourceDir: string,
    dirs: string[],
    keep?: readonly string[],
  ) => Promise<void>;
  /**
   * What the repo's `.swamp/config` holds, judged against the datastore
   * the repo uses before setup switches it (swamp-club#2837).
   */
  resolveInRepoConfigRole: (repoDir: string) => Promise<InRepoConfigRole>;
  /**
   * Lists the files of the in-repo config tier at `localConfigDir`, other
   * than pulled extension sources, that already exist under
   * `destConfigDir`, and whether each differs (swamp-club#2844).
   */
  listConfigTierConflicts: (
    localConfigDir: string,
    destConfigDir: string,
  ) => Promise<ConfigTierConflict[]>;
  /**
   * Inspects the config tier of the datastore `.swamp.yaml` names. Setup
   * calls it after rewriting `.swamp.yaml`, so it sees the new datastore
   * (swamp-club#2845).
   */
  inspectManagedConfigTier: (
    repoDir: string,
  ) => Promise<ManagedConfigTierInspection>;
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
      let sourceDir = `${input.repoDir}/.swamp`;
      let migrationSkips: readonly string[] = [];

      if (!input.skipMigration) {
        yield { kind: "migrating" };

        // When switching from a remote/sync-based datastore, content lives
        // in the local cache, not under .swamp/. Use the cache path when
        // it was provided and actually exists on disk.
        if (input.outgoingCachePath) {
          try {
            const stat = await Deno.stat(input.outgoingCachePath);
            if (stat.isDirectory) {
              sourceDir = input.outgoingCachePath;
              ctx.logger
                .debug`Migrating from outgoing datastore cache at ${sourceDir}`;
            }
          } catch {
            ctx.logger
              .warn`Outgoing cache path ${input.outgoingCachePath} not found, falling back to ${sourceDir}`;
          }
        }

        // An outgoing cache's config dir is the real config tier. The
        // repo's own .swamp/config may hold instance-local state that must
        // not move (swamp-club#2837).
        if (sourceDir === `${input.repoDir}/.swamp`) {
          migrationSkips = inRepoConfigMigrationSkips(
            await deps.resolveInRepoConfigRole(input.repoDir),
          );
        }

        // Setup onto the migration source itself (e.g. --path .swamp) has
        // nothing to move. Copying would fail on every open file, and with
        // no failures cleanup would delete the datastore (swamp-club#3162).
        if (await isSamePath(sourceDir, input.datastorePath)) {
          ctx.logger
            .debug`Datastore path ${input.datastorePath} is the migration source; nothing to migrate`;
        } else {
          ctx.logger.debug`Migrating data to ${input.datastorePath}...`;
          const config = {
            type: "filesystem" as const,
            path: input.datastorePath,
          };
          const result = await deps.migrateData(
            sourceDir,
            input.datastorePath,
            config,
            migrationSkips,
          );
          filesCopied = result.filesCopied;
          bytesCopied = result.bytesCopied;
          directoriesMigrated = result.directoriesMigrated;
          for (const error of result.errors) errors.push(error);

          // Verify migration
          const verification = await deps.verifyMigration(
            sourceDir,
            input.datastorePath,
            config,
            migrationSkips,
          );
          if (!verification.valid) {
            errors.push(
              `Migration verification: source has ${verification.sourceCount} files, destination has ${verification.destCount}`,
            );
          }
        }
      }

      // Update .swamp.yaml only when migration succeeded (or was skipped).
      // Persists BEFORE source cleanup so a crash leaves orphaned source
      // data (harmless) rather than a repo still pointing at the old
      // datastore with its cache already cleaned up.
      if (errors.length === 0) {
        const collapsedPath = deps.collapseEnvVars(input.datastorePath);
        await deps.updateRepoConfig(input.repoDir, {
          type: "filesystem",
          path: collapsedPath,
          directories: input.directories ?? undefined,
        });
      }

      // Clean up migrated directories from source after config is persisted
      if (
        !input.skipMigration && errors.length === 0 &&
        directoriesMigrated.length > 0
      ) {
        await deps.cleanupSourceDirs(
          sourceDir,
          directoriesMigrated,
          migrationSkips,
        );
      }

      if (errors.length === 0) {
        const warning = await emptyConfigTierWarning(ctx, deps, input.repoDir);
        if (warning) yield warning;
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
          ...(directoriesMigrated.length > 0
            ? {
              sourcePath: sourceDir,
              destinationPath: input.datastorePath,
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
                code: "existing_namespaces",
                message:
                  `This datastore contains existing namespaces: ${
                    remoteNamespaces.join(", ")
                  }. ` +
                  `Re-run setup with --namespace <name> to scope this connection ` +
                  `and avoid absorbing foreign data from other projects.`,
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
          bytesCopied: number;
          directoriesMigrated: string[];
        }
        | undefined;
      let migrationSkips: readonly string[] = [];
      let cleanupKeeps: readonly string[] = [];
      let keptConfigPaths: string[] = [];
      const sourceDir = `${input.repoDir}/.swamp`;

      if (!input.skipMigration && syncService) {
        yield { kind: "migrating" };

        // Under managedConfig the repo's .swamp/config is either the config
        // tier or instance-local state (pulled extension sources, the
        // transitional lockfile). Instance-local state must never reach the
        // cache: the push below would upload it over the remote config tier
        // (swamp-club#2837).
        const role = await deps.resolveInRepoConfigRole(input.repoDir);
        migrationSkips = inRepoConfigMigrationSkips(role);
        cleanupKeeps = migrationSkips;

        // Migrate local .swamp/ data to cache path (namespace-scoped when set)
        const migrationDest = ns ? join(cachePath, ns) : cachePath;

        // An in-repo tier may be joining a datastore whose remote already
        // holds the team's config tier. Pull that tier first so the push
        // below never overwrites it: the remote copy wins on every path
        // both hold (swamp-club#2844). Any failure here, a timeout
        // included, stops setup before anything moves or .swamp.yaml
        // changes; committing the new datastore without the migration
        // would leave a retry classifying the tier as instance-local.
        if (role === "tier") {
          await deps.ensureDir(migrationDest);
          try {
            await runBoundedSync(
              input.type,
              "pull",
              timeoutMs,
              (signal) =>
                syncService.pullChanged({
                  signal,
                  namespace: ns,
                  subdirs: ["config"],
                  ...(input.hydrationStrategy === "lazy"
                    ? { metadataOnly: true }
                    : {}),
                }),
            );
          } catch (error) {
            onlyTimeouts = false;
            const { summary } = summarizeSyncError(
              "pull",
              input.type,
              error,
            );
            errors.push(summary);
          }
          if (errors.length === 0) {
            const merge = planConfigTierMerge(
              await deps.listConfigTierConflicts(
                join(sourceDir, "config"),
                join(migrationDest, "config"),
              ),
            );
            migrationSkips = [...migrationSkips, ...merge.copySkips];
            cleanupKeeps = [...cleanupKeeps, ...merge.cleanupKeeps];
            keptConfigPaths = merge.keptPaths;
          }
        }

        if (errors.length === 0) {
          const config = { type: "filesystem" as const, path: migrationDest };
          const result = await deps.migrateData(
            sourceDir,
            migrationDest,
            config,
            migrationSkips,
          );
          for (const error of result.errors) errors.push(error);
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
          cleanupKeeps,
        );
      }

      if (errors.length === 0 && keptConfigPaths.length > 0) {
        const localConfigPath = join(sourceDir, "config");
        yield {
          kind: "warning",
          data: {
            code: "remote_config_tier_kept",
            message:
              `This datastore already has a config tier, so setup kept it ` +
              `and did not upload these local config files, which differ ` +
              `from it: ${keptConfigPaths.join(", ")}. The local copies ` +
              `are still in ${localConfigPath} for you to reconcile.`,
            keptPaths: keptConfigPaths,
            localConfigPath,
          },
        };
      }

      // Update .swamp.yaml when data movement succeeded OR when only
      // timeouts occurred. A timeout means the datastore is correctly
      // configured but the data transfer was slow — the user can resume
      // with `swamp datastore sync --push --timeout <big>`. Hard failures
      // (auth, network, config) still block the type commit.
      // Persist the datastore config to .swamp.yaml. Always include
      // namespace when one was resolved — setup owns the namespace key, so
      // omitting it would drop a pre-set namespace. Keys setup does not own
      // (managedConfig, exclude) are kept by updateRepoConfig.
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

      // Only after a complete transfer: a timeout-only commit may leave the
      // tier partly hydrated, which proves nothing about the remote.
      // Under lazy hydration the sentinel may not be on disk yet; the
      // fetch shares the setup timeout so a stalled remote cannot hang it.
      if (errors.length === 0) {
        const hydrateFile = input.hydrationStrategy === "lazy"
          ? syncService?.hydrateFile?.bind(syncService)
          : undefined;
        const warning = await emptyConfigTierWarning(
          ctx,
          deps,
          input.repoDir,
          hydrateFile
            ? (tierPath) =>
              hydrateSentinel(
                ctx,
                (relPath) =>
                  runBoundedSync(
                    input.type,
                    "pull",
                    timeoutMs,
                    (signal) => hydrateFile(relPath, { signal }),
                  ),
                cachePath,
                tierPath,
              )
            : undefined,
        );
        if (warning) yield warning;
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

      const migratedDirs = migrationResult?.directoriesMigrated ?? [];
      const migratedBytes = migrationResult?.bytesCopied ?? 0;

      yield {
        kind: "completed",
        data: {
          type: input.type,
          filesCopied,
          filesPulled,
          bytesCopied: migratedBytes,
          directoriesMigrated: migratedDirs,
          errors,
          ...(ns ? { namespace: ns } : {}),
          ...(errors.length > 0
            ? {
              retryHint:
                "Re-run the same command to retry. Local data is preserved and the retry is safe.",
            }
            : {}),
          ...(migratedDirs.length > 0
            ? {
              sourcePath: `${input.repoDir}/.swamp`,
              destinationPath: cachePath,
            }
            : {}),
        },
      };
    })(),
  );
}

/**
 * Whether two paths name the same directory. Symlinks resolve through
 * `Deno.realPath` (on macOS /tmp is /private/tmp); a path that cannot be
 * resolved is compared as given.
 */
async function isSamePath(a: string, b: string): Promise<boolean> {
  const real = async (path: string) => {
    try {
      return await Deno.realPath(path);
    } catch {
      return resolve(path);
    }
  };
  return await real(a) === await real(b);
}

/**
 * The warning for a managedConfig repo whose datastore config tier holds no
 * config, or undefined when there is nothing to warn about. `hydrateSentinel`
 * gives a lazily hydrated tier one chance to fetch the migration sentinel
 * before the tier counts as empty (swamp-club#2845). The check is advisory:
 * setup has already committed `.swamp.yaml`, so a failed inspection is
 * logged and skipped rather than failing setup.
 */
async function emptyConfigTierWarning(
  ctx: LibSwampContext,
  deps: DatastoreSetupDeps,
  repoDir: string,
  hydrateSentinel?: (tierPath: string) => Promise<boolean>,
): Promise<DatastoreSetupEvent | undefined> {
  let tier: ManagedConfigTierInspection;
  try {
    tier = await deps.inspectManagedConfigTier(repoDir);
  } catch (error) {
    ctx.logger.debug`Could not inspect the config tier: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return undefined;
  }
  if (!tier.managed || tier.populated) return undefined;
  if (tier.tierPath === undefined) {
    ctx.logger
      .debug`Could not resolve the config tier; skipping the empty tier check`;
    return undefined;
  }
  if (hydrateSentinel && await hydrateSentinel(tier.tierPath)) {
    return undefined;
  }
  return {
    kind: "warning",
    data: {
      code: "empty_config_tier",
      message:
        `managedConfig is on, but the config tier at ${tier.tierPath} has ` +
        `no model, workflow or vault definitions, so this repo will not ` +
        `find any. Run 'swamp datastore config migrate' to copy this repo's ` +
        `models/, workflows/ and vaults/ into the tier. Setup does not move ` +
        `definitions that were only in the previous datastore's config ` +
        `tier; copy those in yourself.`,
      configTierPath: tier.tierPath,
    },
  };
}

/**
 * Fetches the migration sentinel of a lazily hydrated config tier into the
 * cache. Returns whether it was fetched. A tier outside the cache (an
 * excluded `config`) is never fetched, and a failed or timed-out fetch
 * counts as absent.
 */
async function hydrateSentinel(
  ctx: LibSwampContext,
  hydrateFile: (relPath: string) => Promise<boolean>,
  cachePath: string,
  tierPath: string,
): Promise<boolean> {
  const rel = relative(cachePath, tierPath);
  if (rel === ".." || rel.startsWith(`..${SEPARATOR}`) || isAbsolute(rel)) {
    return false;
  }
  const relPath = getMigrationSentinelPath(rel).split(SEPARATOR).join("/");
  try {
    return await hydrateFile(relPath);
  } catch (error) {
    ctx.logger.debug`Could not hydrate the migration sentinel: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return false;
  }
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

/**
 * Resolves the config tier path of the datastore a repo uses now, or
 * undefined when that datastore cannot be resolved. Supplied by the caller
 * because resolving a datastore is a CLI concern.
 */
export type ResolveConfigTierPath = (
  repoDir: string,
  marker: RepoMarkerData,
) => Promise<string | undefined>;

/**
 * Creates real infrastructure deps for datastore setup.
 *
 * @param resolveConfigTierPath Required so every caller decides, through
 *   the same datastore resolution the CLI uses at startup, whether the
 *   repo's `.swamp/config` is the config tier (swamp-club#2837).
 */
export function createDatastoreSetupDeps(
  _repoDir: string,
  resolveConfigTierPath: ResolveConfigTierPath,
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
    migrateData: (sourceDir, destPath, config, skip) =>
      migrateDatastore(
        sourceDir,
        destPath,
        config as FilesystemDatastoreConfig,
        skip,
      ),
    verifyMigration: (sourceDir, destPath, config, skip) =>
      verifyMigration(
        sourceDir,
        destPath,
        config as FilesystemDatastoreConfig,
        skip,
      ),
    cleanupSourceDirs: async (
      sourceDir: string,
      dirs: string[],
      keep: readonly string[] = [],
    ) => {
      const kept = keep.map((p) => resolve(sourceDir, p));
      for (const subdir of dirs) {
        await removeExcept(resolve(sourceDir, subdir), kept);
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
        marker.datastore = mergeSetupDatastoreBlock(
          marker.datastore,
          datastoreConfig as unknown as DatastoreConfigData,
        );
        await markerRepo.write(repoPath, marker);
      }
    },
    resolveInRepoConfigRole: async (repoDir: string) => {
      const marker = await new RepoMarkerRepository().read(
        RepoPath.create(repoDir),
      );
      const managedConfig = marker?.datastore?.managedConfig === true;
      const tierPath = marker && managedConfig
        ? await resolveConfigTierPath(repoDir, marker)
        : undefined;
      return classifyInRepoConfig(
        managedConfig,
        tierPath,
        swampPath(repoDir, "config"),
      );
    },
    listConfigTierConflicts: async (
      localConfigDir: string,
      destConfigDir: string,
    ) => {
      const conflicts: ConfigTierConflict[] = [];
      await collectConfigTierConflicts(
        localConfigDir,
        destConfigDir,
        "",
        conflicts,
      );
      return conflicts;
    },
    inspectManagedConfigTier: async (repoDir: string) => {
      const marker = await new RepoMarkerRepository().read(
        RepoPath.create(repoDir),
      );
      if (!marker || marker.datastore?.managedConfig !== true) {
        return { managed: false };
      }
      const tierPath = await resolveConfigTierPath(repoDir, marker);
      return {
        managed: true,
        tierPath,
        populated: tierPath !== undefined &&
          await isConfigTierPopulated(tierPath),
      };
    },
    collapseEnvVars,
  };
}

/**
 * Appends to `out` every file under `localRoot/relDir` that also exists
 * under `destRoot`, skipping pulled extension sources. The root may be a
 * symlink; a nested symlink is compared as a file and never descended into,
 * matching how migration copies it.
 */
async function collectConfigTierConflicts(
  localRoot: string,
  destRoot: string,
  relDir: string,
  out: ConfigTierConflict[],
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(join(localRoot, relDir)));
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relDir === "" ? entry.name : join(relDir, entry.name);
    if (rel === PULLED_EXTENSIONS_SUBDIR) continue;
    if (entry.isDirectory) {
      await collectConfigTierConflicts(localRoot, destRoot, rel, out);
      continue;
    }
    let dest: Deno.FileInfo;
    try {
      dest = await Deno.lstat(join(destRoot, rel));
    } catch {
      continue;
    }
    out.push({
      path: rel,
      differs: await configFileDiffers(
        join(localRoot, rel),
        entry.isSymlink,
        join(destRoot, rel),
        dest,
      ),
    });
  }
}

async function configFileDiffers(
  localPath: string,
  localIsSymlink: boolean,
  destPath: string,
  dest: Deno.FileInfo,
): Promise<boolean> {
  if (localIsSymlink || dest.isSymlink) {
    return !(localIsSymlink && dest.isSymlink &&
      await Deno.readLink(localPath) === await Deno.readLink(destPath));
  }
  if (!dest.isFile) return true;
  const [local, remote] = await Promise.all([
    Deno.readFile(localPath),
    Deno.readFile(destPath),
  ]);
  if (local.length !== remote.length) return true;
  return local.some((byte, i) => byte !== remote[i]);
}

/**
 * Removes `path` recursively, except any `kept` path inside it, which stays
 * with its ancestors. A symlink is never descended into: with nothing kept
 * inside, only the link is removed; with a kept path inside, the link is
 * left in place so cleanup never deletes the files of its target and the
 * kept path stays reachable. Removal failures are non-fatal: the source may
 * already be gone.
 */
async function removeExcept(
  path: string,
  kept: readonly string[],
): Promise<void> {
  if (kept.includes(path)) return;
  const keptInside = kept.filter((k) => k.startsWith(path + SEPARATOR));
  try {
    if (keptInside.length === 0) {
      await Deno.remove(path, { recursive: true });
      return;
    }
    if ((await Deno.lstat(path)).isSymlink) return;
    for await (const entry of Deno.readDir(path)) {
      await removeExcept(join(path, entry.name), keptInside);
    }
  } catch {
    // Non-fatal: source dir may already be gone
  }
}
