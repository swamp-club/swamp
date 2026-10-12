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

import { ensureDir, walk } from "@std/fs";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import {
  CATALOG_FILES,
  classifyInRepoConfig,
  type ConfigTierConflict,
  type DatastoreConfig,
  type DatastoreConfigData,
  DEFAULT_SYNC_TIMEOUT_MS,
  type FilesystemDatastoreConfig,
  getDatastoreDirectories,
  inRepoConfigMigrationSkips,
  type InRepoConfigRole,
  isRunLogFile,
  mayHoldRunLogs,
  mergeSetupDatastoreBlock,
  planConfigTierMerge,
  PULLED_EXTENSIONS_SUBDIR,
  SYNC_TIMEOUT_ENV_VAR,
} from "../../domain/datastore/datastore_config.ts";
import {
  migrateDatastore,
  verifyMigration,
} from "../../domain/datastore/datastore_migration_service.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import {
  getMigrationSentinelPath,
  isConfigTierPopulated,
} from "../../domain/datastore/managed_config_migration.ts";
import {
  createNamespace,
  isReservedNamespaceName,
} from "../../domain/data/namespace.ts";
import { layoutCollisionMessage } from "./namespace_migrate.ts";
import { UserError } from "../../domain/errors.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { collapseEnvVars } from "../../infrastructure/persistence/env_path.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { removeCatalogDb } from "../../infrastructure/persistence/repository_factory.ts";
import {
  datastoreBlockEngine,
  ensureSupportedDatastoreFormat,
} from "../../infrastructure/persistence/datastore_format_guard.ts";
import type { DatastoreEngine } from "../../domain/datastore/datastore_format.ts";
import { REPO_LOCAL_STREAM_SUBDIRS } from "../../infrastructure/datastore_v3/record_path_guard.ts";
import {
  initializeV3Datastore,
  isFreshV3Skeleton,
} from "../../infrastructure/datastore_v3/v3_datastore.ts";
import {
  getSwampDataDir,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { summarizeSyncError } from "../../infrastructure/persistence/sync_error_diagnostic.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { isLocalEncryptionType } from "../../domain/vaults/local_encryption_key_source.ts";
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
  /**
   * True when the data was copied from an external filesystem datastore and
   * left in place there, which setup never cleans up (swamp-club#3238).
   */
  sourceKept?: boolean;
  /** The format the datastore was created in, when setup chose v3. */
  format?: 3;
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
  }
  | {
    /**
     * The repo's default vault is a local_encryption vault, whose key and
     * secrets stay on this machine (swamp-club#3259).
     */
    code: "local_default_vault";
    message: string;
    vaultName: string;
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
  /**
   * When the current datastore is a filesystem datastore outside the repo,
   * its root (see externalFilesystemDatastoreRoot). Migration reads from
   * it instead of {repoDir}/.swamp, and setup stops when it is missing
   * (swamp-club#3238).
   */
  outgoingDatastorePath?: string;
  /**
   * The format to create the datastore in: 2 (files, the default) or 3, the
   * v3 commit log (swamp-club#3279). Format 3 needs a new, empty path and a
   * current datastore with no records to migrate.
   */
  format?: 2 | 3;
}

/** What a filesystem datastore path holds, for a v3 setup. */
export type V3TargetState =
  | { readonly kind: "absent" }
  | { readonly kind: "empty" }
  | { readonly kind: "refused"; readonly reason: string };

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
  /**
   * The name of the repo's `defaultVault` when it is a local_encryption
   * vault, or undefined when there is no default vault or it is another
   * type (swamp-club#3259).
   */
  findLocalDefaultVault: (repoDir: string) => Promise<string | undefined>;
  updateRepoConfig: (
    repoDir: string,
    datastoreConfig: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * Removes the repo's local catalog, so the next command rebuilds it from
   * the datastore `.swamp.yaml` now names (swamp-club#3238).
   */
  invalidateCatalog: (repoDir: string) => Promise<void>;
  collapseEnvVars: (path: string) => string;
  /**
   * Refuses the target datastore when its format marker names a format this
   * binary cannot read. Setup calls it before its first write to the
   * target (swamp-club#3189). `provider` is the target's provider, already
   * built, for extension datastores.
   */
  assertDatastoreFormat: (
    repoDir: string,
    config: DatastoreConfig,
    provider?: DatastoreProvider,
  ) => Promise<DatastoreEngine | void>;
  /**
   * Whether a v3 datastore may be created at `path`: absent or an empty
   * directory, never a symlink (swamp-club#3279).
   */
  inspectV3Target: (path: string) => Promise<V3TargetState>;
  /**
   * Whether `sourceDir` holds any record under the datastore `subdirs`,
   * other than the `skip` paths (relative to `sourceDir`).
   */
  hasDatastoreRecords: (
    sourceDir: string,
    subdirs: readonly string[],
    skip: readonly string[],
  ) => Promise<boolean>;
  /**
   * Creates a v3 datastore at `path`: the format marker first, then
   * `commits.db` and `_blobs/`, so a crash part-way leaves a marked but
   * empty datastore or an unmarked empty directory, never v3 files without
   * a marker.
   */
  createV3Datastore: (path: string) => Promise<void>;
  /**
   * The datastore the repo uses now (swamp-club#3279): its engine, since
   * setup refuses to move a repo off a v3 datastore, and its namespace,
   * which a v3 setup keeps.
   */
  currentDatastore: (
    repoDir: string,
  ) => Promise<{ engine: DatastoreEngine; namespace?: string }>;
}

/** The refusal for a setup that would move a repo off a v3 datastore. */
const MOVE_OFF_V3_REFUSAL: DatastoreSetupEvent = {
  kind: "error",
  error: {
    code: "validation_failed",
    message: "This repository uses a v3 datastore. Moving it to another " +
      "datastore is not supported yet: its records live in the checkout and " +
      "its commit log, and migrating v3 data is not available. Nothing was " +
      "changed.",
  },
};

/** The error event for a datastore format check that refused. */
function formatRefusal(err: unknown): DatastoreSetupEvent {
  if (err instanceof UserError && err.code) {
    return {
      kind: "error",
      error: { code: err.code, message: err.message, cause: err },
    };
  }
  throw err;
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

      if ((await deps.currentDatastore(input.repoDir)).engine === "v3") {
        yield MOVE_OFF_V3_REFUSAL;
        return;
      }

      let targetEngine: DatastoreEngine | void;
      try {
        targetEngine = await deps.assertDatastoreFormat(input.repoDir, {
          type: "filesystem",
          path: input.datastorePath,
        });
      } catch (err) {
        yield formatRefusal(err);
        return;
      }
      // A target that is already a v3 datastore takes no v2 setup: v2's
      // migration would copy the repo's records into it, where a v3 checkout
      // never reads them (swamp-club#3279).
      if (targetEngine === "v3" && input.format !== 3) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: `${input.datastorePath} is a v3 datastore. Set it up ` +
              "with `swamp datastore setup filesystem --path <dir> --format 3`" +
              " (a v3 datastore takes a repository with no records). Nothing " +
              "was changed.",
          },
        };
        return;
      }

      if (input.format === 3) {
        yield* setupV3Filesystem(ctx, deps, input);
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

      // Where the current datastore's data is. A missing filesystem
      // datastore stops setup: migrating from .swamp/ instead would report
      // success and leave the data behind (swamp-club#3238).
      const source = await resolveMigrationSource(ctx, input);
      if (!input.skipMigration && "error" in source) {
        yield { kind: "error", error: source.error };
        return;
      }
      // Under --skip-migration an unreadable source is still the current
      // datastore: nothing is read from it, but a switch away from it must
      // still drop the catalog.
      const sourceDir = "error" in source
        ? source.currentPath
        : source.sourceDir;
      const fromOutgoingCache = !("error" in source) &&
        source.fromOutgoingCache;
      const ontoSource = await isSamePath(sourceDir, input.datastorePath);

      if (!input.skipMigration && !ontoSource) {
        const nested = await migratedSubdirHolding(
          sourceDir,
          input.datastorePath,
          deps.getDatastoreDirectories({ type: "filesystem" }),
        );
        if (nested) {
          yield {
            kind: "error",
            error: {
              code: "validation_failed",
              message:
                `Datastore path ${input.datastorePath} is inside ${nested}, ` +
                `which setup moves from the current datastore. Choose a path ` +
                `outside it.`,
            },
          };
          return;
        }
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
      let migrationSkips: readonly string[] = [];

      if (!input.skipMigration) {
        yield { kind: "migrating" };

        // An outgoing cache's config dir is the real config tier. The
        // repo's own .swamp/config may hold instance-local state that must
        // not move (swamp-club#2837).
        if (!fromOutgoingCache) {
          migrationSkips = inRepoConfigMigrationSkips(
            await sourceConfigRole(deps, input.repoDir, sourceDir),
          );
        }

        // Setup onto the migration source itself (e.g. --path .swamp) has
        // nothing to move. Copying would fail on every open file, and with
        // no failures cleanup would delete the datastore (swamp-club#3162).
        if (ontoSource) {
          ctx.logger
            .info`Datastore path ${input.datastorePath} is the current datastore; nothing to migrate`;
        } else {
          ctx.logger.debug`Migrating data to ${input.datastorePath}...`;
          const config = {
            type: "filesystem" as const,
            path: input.datastorePath,
          };
          // The catalog is a local index: never copied, rebuilt below.
          const copySkips = [...migrationSkips, ...CATALOG_FILES];
          const result = await deps.migrateData(
            sourceDir,
            input.datastorePath,
            config,
            copySkips,
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
            copySkips,
          );
          if (!verification.valid) {
            errors.push(
              `Migration verification: ${verification.destCount} of ${verification.sourceCount} source files arrived at the destination`,
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

      // Clean up migrated directories from source after config is persisted.
      // An external filesystem datastore is copied, never cleaned up: other
      // repositories may share it (swamp-club#3238).
      if (
        !input.skipMigration && errors.length === 0 &&
        directoriesMigrated.length > 0
      ) {
        if (input.outgoingDatastorePath) {
          ctx.logger
            .info`Left the previous datastore's data in place at ${sourceDir}`;
        } else {
          await deps.cleanupSourceDirs(
            sourceDir,
            directoriesMigrated,
            migrationSkips,
          );
        }
      }

      // The catalog indexes the old datastore. Drop it so the next command
      // rebuilds it from the new one; a kept catalog misses whatever the
      // new datastore already held (swamp-club#3238).
      if (errors.length === 0 && !ontoSource) {
        await deps.invalidateCatalog(input.repoDir);
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
              ...(input.outgoingDatastorePath ? { sourceKept: true } : {}),
            }
            : {}),
        },
      };
    })(),
  );
}

/**
 * The v3 part of filesystem setup (swamp-club#3279): a new, empty datastore
 * in the commit-log format, with nothing migrated. Migrating v2 records is
 * Phase 6, so setup refuses while the current datastore holds any; their
 * files would sit in the checkout with no commit behind them.
 */
async function* setupV3Filesystem(
  ctx: LibSwampContext,
  deps: DatastoreSetupDeps,
  input: DatastoreSetupFilesystemInput,
): AsyncIterable<DatastoreSetupEvent> {
  const refuse = (message: string): DatastoreSetupEvent => ({
    kind: "error",
    error: { code: "validation_failed", message },
  });

  const target = await deps.inspectV3Target(input.datastorePath);
  if (target.kind === "refused") {
    yield refuse(
      `A v3 datastore needs a new, empty directory: ${target.reason}. ` +
        "Migrating an existing datastore to v3 is not supported yet.",
    );
    return;
  }

  // Records the repo uses now would be left behind: their files stay where
  // they are and no commit names them. The checkout's own .swamp is where a
  // v3 datastore materialises records, so it must hold none even under
  // --skip-migration.
  const source = await resolveMigrationSource(ctx, input);
  // A current datastore that cannot be read may hold records: refuse, as v2
  // setup does, rather than leave them behind (swamp-club#3238).
  if (!input.skipMigration && "error" in source) {
    yield { kind: "error", error: source.error };
    return;
  }
  const sourceDir = "error" in source ? source.currentPath : source.sourceDir;
  const { namespace } = await deps.currentDatastore(input.repoDir);
  const repoSwampDir = swampPath(input.repoDir);
  const subdirs = deps.getDatastoreDirectories({ type: "filesystem" })
    .filter((subdir) =>
      !(REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(subdir)
    );
  // The checkout's own .swamp is always checked, even under
  // --skip-migration: a record left there would be materialised in the v3
  // checkout with no commit behind it. The current datastore is checked too
  // unless the user skips migration.
  const dirs = [
    repoSwampDir,
    ...(namespace ? [swampPath(input.repoDir, namespace)] : []),
  ];
  if (
    !input.skipMigration && !("error" in source) &&
    !await isSamePath(sourceDir, repoSwampDir)
  ) {
    dirs.push(sourceDir);
  }
  for (const dir of dirs) {
    if (await deps.hasDatastoreRecords(dir, subdirs, CATALOG_FILES)) {
      yield refuse(
        `${dir} holds records. A v3 datastore starts empty, and migrating ` +
          "existing records to v3 is not supported yet. Set up v3 in a " +
          "repository with no data.",
      );
      return;
    }
  }

  await deps.createV3Datastore(input.datastorePath);
  const collapsedPath = deps.collapseEnvVars(input.datastorePath);
  await deps.updateRepoConfig(input.repoDir, {
    type: "filesystem",
    path: collapsedPath,
    directories: input.directories ?? undefined,
    // A namespace set before setup is the datastore's namespace: setup owns
    // the key, so leaving it out would drop it.
    ...(namespace ? { namespace } : {}),
    format: 3,
  });
  // The v2 catalog indexes the old datastore; the v3 one is the read model's.
  await deps.invalidateCatalog(input.repoDir);

  yield {
    kind: "completed",
    data: {
      type: "filesystem",
      path: input.datastorePath,
      format: 3,
      filesCopied: 0,
      filesPulled: 0,
      bytesCopied: 0,
      directoriesMigrated: [],
      errors: [],
    },
  };
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
  /**
   * True when `namespace` is the one the repo's config already holds, rather
   * than one this setup is claiming. Only changes the error for a reserved
   * name: a repo already bound to one is told how to move off it.
   */
  namespaceAlreadyBound?: boolean;
  syncTimeoutMsOverride?: number;
  /** See {@link DatastoreSetupFilesystemInput.outgoingDatastorePath}. */
  outgoingDatastorePath?: string;
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

      if ((await deps.currentDatastore(input.repoDir)).engine === "v3") {
        yield MOVE_OFF_V3_REFUSAL;
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
      const cachePath = provider.resolveCachePath?.(input.repoDir) ??
        join(getSwampDataDir(), "repos", input.repoId ?? "unknown");

      try {
        await deps.assertDatastoreFormat(input.repoDir, {
          type: input.type,
          config: input.config,
          datastorePath: provider.resolveDatastorePath(input.repoDir),
          cachePath,
          ...(input.namespace ? { namespace: input.namespace } : {}),
        }, provider);
      } catch (err) {
        yield formatRefusal(err);
        return;
      }

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

      const syncService = provider.createSyncService?.(
        input.repoDir,
        cachePath,
      );
      const ns = input.namespace;

      if (ns && input.namespaceAlreadyBound && isReservedNamespaceName(ns)) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: layoutCollisionMessage(ns),
          },
        };
        return;
      }

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
      // Config files left out of the copy because the cache already holds
      // them. A cache left by an earlier failed setup can hold every one,
      // so a copy of nothing still needs its push and cleanup.
      let skippedConfigFiles = 0;
      // A filesystem datastore outside the repo is the source, not .swamp/
      // (swamp-club#3238).
      const sourceDir = input.outgoingDatastorePath ??
        swampPath(input.repoDir);
      if (input.outgoingDatastorePath && !input.skipMigration) {
        const error = await inaccessibleSourceError(
          input.outgoingDatastorePath,
        );
        if (error) {
          yield { kind: "error", error };
          return;
        }
      }

      if (!input.skipMigration && syncService) {
        yield { kind: "migrating" };

        // Under managedConfig the repo's .swamp/config is either the config
        // tier or instance-local state (pulled extension sources, the
        // transitional lockfile). Instance-local state must never reach the
        // cache: the push below would upload it over the remote config tier
        // (swamp-club#2837).
        const role = await sourceConfigRole(deps, input.repoDir, sourceDir);
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
            skippedConfigFiles = merge.copySkips.length;
          }
        }

        if (errors.length === 0) {
          const config = { type: "filesystem" as const, path: migrationDest };
          // The catalog is a local index: never copied, rebuilt below.
          const result = await deps.migrateData(
            sourceDir,
            migrationDest,
            config,
            [...migrationSkips, ...CATALOG_FILES],
          );
          for (const error of result.errors) errors.push(error);
          if (result.errors.length > 0) onlyTimeouts = false;
          filesCopied = result.filesCopied;
          migrationResult = result;

          // Push cache to remote via sync service. Always pass namespace
          // so the extension scopes the push to {namespace}/ on the remote.
          if (result.filesCopied > 0 || skippedConfigFiles > 0) {
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
      // so the user can retry setup without losing local data. An external
      // filesystem datastore is copied, never cleaned up: other
      // repositories may share it (swamp-club#3238).
      if (
        migrationResult &&
        errors.length === 0 &&
        (migrationResult.filesCopied > 0 || skippedConfigFiles > 0) &&
        migrationResult.directoriesMigrated.length > 0
      ) {
        if (input.outgoingDatastorePath) {
          ctx.logger
            .info`Left the previous datastore's data in place at ${sourceDir}`;
        } else {
          await deps.cleanupSourceDirs(
            sourceDir,
            migrationResult.directoriesMigrated,
            cleanupKeeps,
          );
        }
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
        // The catalog indexes the old datastore; rebuild it from the new
        // one (swamp-club#3238).
        await deps.invalidateCatalog(input.repoDir);
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

      const vaultWarning = await localDefaultVaultWarning(
        ctx,
        deps,
        input.repoDir,
      );
      if (vaultWarning) yield vaultWarning;

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
              sourcePath: sourceDir,
              destinationPath: cachePath,
              ...(input.outgoingDatastorePath ? { sourceKept: true } : {}),
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
  return await realOrResolved(a) === await realOrResolved(b);
}

/** `path` through `Deno.realPath`, or resolved as given when it cannot be. */
async function realOrResolved(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The error for a current datastore root setup cannot read, or undefined
 * when it is a readable directory.
 */
async function inaccessibleSourceError(
  path: string,
): Promise<SwampError | undefined> {
  let reason: string | undefined;
  try {
    if (!(await Deno.stat(path)).isDirectory) reason = "not a directory";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  // Setup creates every datastore subdir when it first moves data to a
  // path, so a root holding none of them is not a datastore: typically an
  // unmounted mount point, whose empty directory would otherwise migrate
  // as zero files.
  if (!reason && !(await holdsDatastoreSubdir(path))) {
    reason = "it holds no datastore data; if it is a mount point, mount it";
  }
  if (!reason) return undefined;
  return {
    code: "validation_failed",
    message:
      `The current datastore at ${path} is not accessible (${reason}), ` +
      `so its data cannot be moved. Make it available and re-run, or ` +
      `switch without moving any data with 'swamp datastore setup ` +
      `filesystem' or 'swamp datastore setup extension' and ` +
      `--skip-migration.`,
  };
}

/** Whether `root` holds at least one datastore subdir. */
async function holdsDatastoreSubdir(root: string): Promise<boolean> {
  for (
    const subdir of getDatastoreDirectories({ type: "filesystem", path: root })
  ) {
    try {
      if ((await Deno.stat(join(root, subdir))).isDirectory) return true;
    } catch {
      // Not there; try the next one.
    }
  }
  return false;
}

/**
 * Where setup migrates from: an external filesystem datastore's root, the
 * outgoing extension datastore's cache when it exists, or the repo's own
 * `.swamp/`. An external root that is missing or not a directory is an
 * error, never a fallback to `.swamp/` (swamp-club#3238).
 */
async function resolveMigrationSource(
  ctx: LibSwampContext,
  input: DatastoreSetupFilesystemInput,
): Promise<
  | { sourceDir: string; fromOutgoingCache: boolean }
  | { error: SwampError; currentPath: string }
> {
  if (input.outgoingDatastorePath) {
    const path = input.outgoingDatastorePath;
    const error = await inaccessibleSourceError(path);
    if (error) return { error, currentPath: path };
    return { sourceDir: path, fromOutgoingCache: false };
  }

  // When switching from a remote/sync-based datastore, content lives
  // in the local cache, not under .swamp/. Use the cache path when
  // it was provided and actually exists on disk.
  const swampDir = swampPath(input.repoDir);
  if (input.outgoingCachePath) {
    try {
      const stat = await Deno.stat(input.outgoingCachePath);
      if (stat.isDirectory) {
        ctx.logger
          .debug`Migrating from outgoing datastore cache at ${input.outgoingCachePath}`;
        return { sourceDir: input.outgoingCachePath, fromOutgoingCache: true };
      }
    } catch {
      ctx.logger
        .warn`Outgoing cache path ${input.outgoingCachePath} not found, falling back to ${swampDir}`;
    }
  }
  return { sourceDir: swampDir, fromOutgoingCache: false };
}

/**
 * What the `config` dir under `sourceDir` holds. The repo's own `.swamp/`
 * is classified by `resolveInRepoConfigRole`. An external filesystem
 * datastore's `config` is the managed config tier when `.swamp.yaml` says
 * so; an inspection that fails counts as instance-local, so nothing moves.
 */
async function sourceConfigRole(
  deps: DatastoreSetupDeps,
  repoDir: string,
  sourceDir: string,
): Promise<InRepoConfigRole> {
  if (await isSamePath(sourceDir, swampPath(repoDir))) {
    return await deps.resolveInRepoConfigRole(repoDir);
  }
  try {
    const tier = await deps.inspectManagedConfigTier(repoDir);
    if (!tier.managed) return "unmanaged";
    return classifyInRepoConfig(
      true,
      tier.tierPath && await realOrResolved(tier.tierPath),
      await realOrResolved(join(sourceDir, "config")),
    );
  } catch {
    return "instance_local";
  }
}

/**
 * The migrated subdir of `sourceDir` that holds `destPath`, if any. Copying
 * into one would recurse into its own output, and cleanup would then delete
 * the destination.
 */
async function migratedSubdirHolding(
  sourceDir: string,
  destPath: string,
  subdirs: readonly string[],
): Promise<string | undefined> {
  const dest = await realOrResolved(destPath);
  const source = await realOrResolved(sourceDir);
  for (const subdir of subdirs) {
    const dir = join(source, subdir);
    const rel = relative(dir, dest);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return join(sourceDir, subdir);
    }
  }
  return undefined;
}

/**
 * The warning for a repo whose default vault is a local_encryption vault,
 * or undefined when there is nothing to warn about. Its key and secrets stay
 * on this machine, so other machines sharing the datastore cannot read the
 * values it holds (swamp-club#3259). The check is advisory: a failed lookup
 * is logged and skipped rather than failing setup.
 */
async function localDefaultVaultWarning(
  ctx: LibSwampContext,
  deps: DatastoreSetupDeps,
  repoDir: string,
): Promise<DatastoreSetupEvent | undefined> {
  let vaultName: string | undefined;
  try {
    vaultName = await deps.findLocalDefaultVault(repoDir);
  } catch (error) {
    ctx.logger.debug`Could not inspect the default vault: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return undefined;
  }
  if (vaultName === undefined) return undefined;
  return {
    kind: "warning",
    data: {
      code: "local_default_vault",
      message:
        `The default vault '${vaultName}' is a local_encryption vault: its ` +
        `key and secrets stay on this machine, so other machines using this ` +
        `datastore cannot read secrets or sensitive outputs stored in it. ` +
        `To share them, migrate it with 'swamp vault migrate ${vaultName}', ` +
        `or create a vault with a shared provider and set it as ` +
        `defaultVault in .swamp.yaml.`,
      vaultName,
    },
  };
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
  options: {
    /** Recorded as `writtenBy` in a v3 datastore's format marker. */
    readonly swampVersion?: string;
  } = {},
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
        // Run logs stay with the checkout: their records point at them in
        // .swamp whatever the datastore (swamp-club#3281).
        const keepFile = mayHoldRunLogs(subdir)
          ? (name: string) => isRunLogFile(subdir, name)
          : undefined;
        await removeExcept(resolve(sourceDir, subdir), kept, keepFile);
      }
    },
    invalidateCatalog: (repoDir: string) => removeCatalogDb(repoDir),
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
    findLocalDefaultVault: async (repoDir: string) => {
      const marker = await new RepoMarkerRepository().read(
        RepoPath.create(repoDir),
      );
      if (!marker?.defaultVault) return undefined;
      const tierPath = marker.datastore?.managedConfig === true
        ? await resolveConfigTierPath(repoDir, marker)
        : undefined;
      const vault = await new YamlVaultConfigRepository(
        repoDir,
        undefined,
        join(tierPath ?? repoDir, "vaults"),
      ).findByName(marker.defaultVault, true);
      return vault && isLocalEncryptionType(vault.type)
        ? vault.name
        : undefined;
    },
    collapseEnvVars,
    inspectV3Target,
    hasDatastoreRecords,
    currentDatastore,
    createV3Datastore: (path) =>
      initializeV3Datastore(path, options.swampVersion ?? "unknown"),
    assertDatastoreFormat: (repoDir, config, provider) =>
      ensureSupportedDatastoreFormat(
        repoDir,
        config,
        provider ? { resolveProvider: () => Promise.resolve(provider) } : {},
      ),
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
    let dest: Deno.FileInfo | undefined;
    try {
      dest = await Deno.lstat(join(destRoot, rel));
    } catch {
      dest = undefined;
    }
    if (entry.isDirectory) {
      // A local directory where the destination has a file cannot be
      // copied; it conflicts as a whole.
      if (dest && !dest.isDirectory) {
        out.push({ path: rel, differs: true });
      } else {
        await collectConfigTierConflicts(localRoot, destRoot, rel, out);
      }
      continue;
    }
    if (!dest) continue;
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
  // A file that cannot be read counts as differing, so its local copy is
  // kept and reported rather than failing setup.
  try {
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
  } catch {
    return true;
  }
}

/**
 * Removes `path` recursively, except any `kept` path inside it, which stays
 * with its ancestors, and any regular file whose name `keepFile` accepts.
 * When `keepFile` is given the tree is walked file by file and directories
 * it leaves empty are removed. A symlink is never descended into: with
 * nothing kept inside, only the link is removed; with a kept path inside,
 * the link is left in place so cleanup never deletes the files of its
 * target and the kept path stays reachable. Removal failures are non-fatal:
 * the source may already be gone.
 */
async function removeExcept(
  path: string,
  kept: readonly string[],
  keepFile?: (name: string) => boolean,
): Promise<void> {
  if (kept.includes(path)) return;
  const keptInside = kept.filter((k) => k.startsWith(path + SEPARATOR));
  try {
    if (keptInside.length === 0 && !keepFile) {
      await Deno.remove(path, { recursive: true });
      return;
    }
    const stat = await Deno.lstat(path);
    if (stat.isSymlink) {
      if (keptInside.length === 0) await Deno.remove(path);
      return;
    }
    if (!stat.isDirectory) {
      if (!keepFile?.(basename(path))) await Deno.remove(path);
      return;
    }
    for await (const entry of Deno.readDir(path)) {
      await removeExcept(join(path, entry.name), keptInside, keepFile);
    }
  } catch {
    // Non-fatal: source dir may already be gone
    return;
  }
  if (keepFile) await removeIfEmpty(path);
}

/** Removes the directory `path` when nothing is left in it. */
async function removeIfEmpty(path: string): Promise<void> {
  try {
    for await (const _ of Deno.readDir(path)) return;
    await Deno.remove(path);
  } catch {
    // Non-fatal: already gone, or not empty
  }
}

/** Whether a v3 datastore may be created at `path` (swamp-club#3279). */
async function inspectV3Target(path: string): Promise<V3TargetState> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "absent" };
    throw error;
  }
  if (info.isSymlink) {
    return { kind: "refused", reason: `${path} is a symbolic link` };
  }
  if (!info.isDirectory) {
    return { kind: "refused", reason: `${path} is not a directory` };
  }
  // A setup that stopped after writing the marker leaves a fresh skeleton;
  // a re-run completes it.
  if (await isFreshV3Skeleton(path)) return { kind: "empty" };
  for await (const entry of Deno.readDir(path)) {
    return {
      kind: "refused",
      reason: `${path} is not empty (it holds ${entry.name})`,
    };
  }
  return { kind: "empty" };
}

/**
 * Whether `sourceDir` holds a file under any of `subdirs`, other than the
 * `skip` paths (relative to `sourceDir`). Stops at the first one.
 */
async function hasDatastoreRecords(
  sourceDir: string,
  subdirs: readonly string[],
  skip: readonly string[],
): Promise<boolean> {
  const skipped = new Set(skip.map((path) => resolve(sourceDir, path)));
  for (const subdir of subdirs) {
    const root = join(sourceDir, subdir);
    try {
      for await (
        const entry of walk(root, { includeDirs: false, followSymlinks: false })
      ) {
        if (!skipped.has(resolve(entry.path))) return true;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
  }
  return false;
}

/** The datastore `.swamp.yaml` names: its engine and namespace. */
async function currentDatastore(
  repoDir: string,
): Promise<{ engine: DatastoreEngine; namespace?: string }> {
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repoDir),
  );
  const namespace = marker?.datastore?.namespace;
  return {
    engine: datastoreBlockEngine(repoDir, marker?.datastore),
    ...(namespace ? { namespace } : {}),
  };
}
