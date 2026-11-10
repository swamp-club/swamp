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
  namespaceCollidesWithLayout,
  restoreNamespace,
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
import {
  type DatastoreEngine,
  InvalidDatastoreFormatMarkerError,
  LostDatastoreFormatMarkerError,
} from "../../domain/datastore/datastore_format.ts";
import {
  isCheckoutLocalKey,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "../../infrastructure/datastore_v3/record_path_guard.ts";
import { hasDatastoreRecords } from "../../infrastructure/persistence/datastore_records.ts";
import {
  initializeV3Datastore,
  isFreshV3Skeleton,
} from "../../infrastructure/datastore_v3/v3_datastore.ts";
import { assertV3BucketHost } from "../../infrastructure/datastore_v3/v3_datastore_binding.ts";
import { assertV3CacheSubdirsContained } from "../../infrastructure/datastore_v3/cache_root_containment.ts";
import { assertV3BucketExtensionVersions } from "../../infrastructure/persistence/datastore_extension_version.ts";
import { resolveModelsDir } from "../../infrastructure/persistence/resolve_models_dir.ts";
import {
  initializeV3BucketDatastore,
  inspectV3BucketTarget,
} from "../../infrastructure/datastore_v3/v3_bucket_setup.ts";
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
import {
  readNamespaceManifest,
  writeNamespaceManifest,
} from "../../infrastructure/persistence/namespace_manifest.ts";
import { runBoundedSync } from "../../infrastructure/persistence/datastore_sync_coordinator.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export interface DatastoreSetupData {
  type: string;
  path?: string;
  filesCopied: number;
  /** always 0 for filesystem datastores, which have no separate cache to hydrate */
  filesPulled: number;
  bytesCopied: number;
  directoriesMigrated: string[];
  errors: string[];
  retryHint?: string;
  namespace?: string;
  sourcePath?: string;
  destinationPath?: string;
  /**
   * data copied from an external filesystem datastore is left in place there,
   * which setup never cleans up
   */
  sourceKept?: boolean;
  format?: 3;
}

export type DatastoreSetupWarningData =
  | {
    code: "existing_namespaces";
    message: string;
    existingNamespaces: string[];
  }
  | {
    /** managedConfig is on but the new datastore's config tier holds no config */
    code: "empty_config_tier";
    message: string;
    configTierPath: string;
  }
  | {
    /**
     * the datastore already had a config tier, so differing local config files
     * were not uploaded and stay in the repo
     */
    code: "remote_config_tier_kept";
    message: string;
    keptPaths: string[];
    localConfigPath: string;
  }
  | {
    code: "local_default_vault";
    message: string;
    vaultName: string;
  };

/** tierPath is undefined when the named datastore cannot be resolved */
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

export interface DatastoreSetupFilesystemInput {
  datastorePath: string;
  repoDir: string;
  directories?: string[];
  skipMigration: boolean;
  outgoingCachePath?: string;
  /**
   * migration reads from it instead of {repoDir}/.swamp, and setup stops when
   * it is missing
   */
  outgoingDatastorePath?: string;
  /**
   * format 3 needs a new, empty path and a current datastore with no records to
   * migrate
   */
  format?: 2 | 3;
}

export type V3BucketTarget =
  | { readonly kind: "new" }
  | { readonly kind: "resumable" }
  | { readonly kind: "refused"; readonly reason: string };

export type V3TargetState =
  | { readonly kind: "absent" }
  | { readonly kind: "empty" }
  | { readonly kind: "refused"; readonly reason: string };

export interface DatastoreSetupDeps {
  requireUpgradedRepo: (repoDir: string) => Promise<void>;
  /** throws a UserError for an expression that cannot or may not resolve */
  resolveConfigExpressions: ResolveConfigExpressions;
  /**
   * throws a UserError when a subdirectory a v3 checkout would materialise
   * records in links out of its cache root
   */
  assertV3CacheContained: (
    repoDir: string,
    namespace: string,
    directories: readonly string[] | undefined,
  ) => Promise<void>;
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
  /** leaves any keep path that lies inside one of the removed dirs in place */
  cleanupSourceDirs: (
    sourceDir: string,
    dirs: string[],
    keep?: readonly string[],
  ) => Promise<void>;
  resolveInRepoConfigRole: (repoDir: string) => Promise<InRepoConfigRole>;
  listConfigTierConflicts: (
    localConfigDir: string,
    destConfigDir: string,
  ) => Promise<ConfigTierConflict[]>;
  /** setup calls it after rewriting .swamp.yaml, so it sees the new datastore */
  inspectManagedConfigTier: (
    repoDir: string,
  ) => Promise<ManagedConfigTierInspection>;
  findLocalDefaultVault: (repoDir: string) => Promise<string | undefined>;
  updateRepoConfig: (
    repoDir: string,
    datastoreConfig: Record<string, unknown>,
  ) => Promise<void>;
  invalidateCatalog: (repoDir: string) => Promise<void>;
  collapseEnvVars: (path: string) => string;
  /**
   * setup calls it before its first write to the target; provider is the
   * target's, already built, for extension datastores
   */
  assertDatastoreFormat: (
    repoDir: string,
    config: DatastoreConfig,
    provider?: DatastoreProvider,
  ) => Promise<DatastoreEngine | void>;
  /**
   * a v3 datastore may be created at an absent path or an empty directory,
   * never a symlink
   */
  inspectV3Target: (path: string) => Promise<V3TargetState>;
  hasDatastoreRecords: (
    sourceDir: string,
    subdirs: readonly string[],
    skip: readonly string[],
    isOwn?: (segments: readonly string[]) => boolean,
  ) => Promise<boolean>;
  /**
   * the format marker comes first, then commits.db and _blobs/, so a crash
   * leaves a marked empty datastore or an unmarked empty directory, never v3
   * files without a marker
   */
  createV3Datastore: (path: string) => Promise<void>;
  assertV3BucketHost: (provider: DatastoreProvider, type: string) => void;
  assertV3ExtensionVersion: (type: string, repoDir: string) => Promise<void>;
  inspectV3BucketTarget: (
    provider: DatastoreProvider,
    type: string,
    repoDir: string,
    namespace: string | undefined,
  ) => Promise<V3BucketTarget>;
  /**
   * writes the format marker through the datastore-wide control plane, only if
   * none is there
   */
  createV3BucketDatastore: (
    provider: DatastoreProvider,
    type: string,
  ) => Promise<void>;
  /**
   * engine, since setup refuses to move a repo off v3; namespace, which a v3
   * setup keeps; repoId registers a namespace kept by a v2 setup
   */
  currentDatastore: (
    repoDir: string,
  ) => Promise<
    { engine: DatastoreEngine; namespace?: string; repoId?: string }
  >;
}

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

function formatRefusal(err: unknown): DatastoreSetupEvent {
  if (err instanceof UserError && err.code) {
    return {
      kind: "error",
      error: { code: err.code, message: err.message, cause: err },
    };
  }
  throw err;
}

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

      let targetEngine: DatastoreEngine | void = undefined;
      try {
        targetEngine = await deps.assertDatastoreFormat(input.repoDir, {
          type: "filesystem",
          path: input.datastorePath,
        });
      } catch (err) {
        // a v3 setup that stopped before its marker reached disk leaves a
        // skeleton with a lost marker: re-running with --format 3 completes it
        // when it holds nothing else
        const resumable = input.format === 3 &&
          (err instanceof LostDatastoreFormatMarkerError ||
            err instanceof InvalidDatastoreFormatMarkerError) &&
          (await deps.inspectV3Target(input.datastorePath)).kind === "empty";
        if (!resumable) {
          yield formatRefusal(err);
          return;
        }
      }
      // a v3 target takes no v2 setup: v2's migration would copy the repo's
      // records into it, where a v3 checkout never reads them
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

      // a missing filesystem datastore stops setup: migrating from .swamp/
      // instead would report success and leave the data behind
      const source = await resolveMigrationSource(ctx, deps, input);
      if (!input.skipMigration && "error" in source) {
        yield { kind: "error", error: source.error };
        return;
      }
      // a namespace set before setup with no data yet: nothing moves and the
      // new datastore keeps the namespace
      const freshNamespace = "error" in source
        ? undefined
        : source.freshNamespace;
      const migrate = !input.skipMigration && !freshNamespace;
      // Under --skip-migration an unreadable source is still the current
      // datastore: nothing is read from it, but a switch away from it must
      // still drop the catalog.
      const sourceDir = "error" in source
        ? source.currentPath
        : source.sourceDir;
      const fromOutgoingCache = !("error" in source) &&
        source.fromOutgoingCache;
      const ontoSource = await isSamePath(sourceDir, input.datastorePath);

      if (migrate && !ontoSource) {
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

      const repoId = freshNamespace
        ? (await deps.currentDatastore(input.repoDir)).repoId
        : undefined;
      if (freshNamespace) {
        const claimed = await readNamespaceManifest(
          input.datastorePath,
          freshNamespace,
        );
        if (claimed?.repoId && claimed.repoId !== repoId) {
          yield {
            kind: "error",
            error: {
              code: "validation_failed",
              message: `Namespace "${freshNamespace}" is already registered ` +
                `in ${input.datastorePath} by repo ${claimed.repoId}. ` +
                `Nothing was changed.`,
            },
          };
          return;
        }
      }

      const dataRoot = freshNamespace
        ? join(input.datastorePath, freshNamespace)
        : input.datastorePath;
      const directories = deps.getDatastoreDirectories({
        type: "filesystem",
        directories: input.directories,
      });
      for (const subdir of directories) {
        await deps.ensureDir(`${dataRoot}/${subdir}`);
      }

      let filesCopied = 0;
      let bytesCopied = 0;
      let directoriesMigrated: string[] = [];
      const errors: string[] = [];
      let migrationSkips: readonly string[] = [];

      if (migrate) {
        yield { kind: "migrating" };

        // an outgoing cache's config dir is the real config tier; the repo's
        // own .swamp/config may hold instance-local state that must not move
        if (!fromOutgoingCache) {
          migrationSkips = inRepoConfigMigrationSkips(
            await sourceConfigRole(deps, input.repoDir, sourceDir),
          );
        }

        // setup onto the migration source itself has nothing to move: copying
        // would fail on every open file, and with no failures cleanup would
        // delete the datastore
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

      // persists before source cleanup, so a crash leaves orphaned source data
      // (harmless) rather than a repo still pointing at the old datastore with
      // its cache cleaned up
      if (errors.length === 0) {
        const collapsedPath = deps.collapseEnvVars(input.datastorePath);
        await deps.updateRepoConfig(input.repoDir, {
          type: "filesystem",
          path: collapsedPath,
          directories: input.directories ?? undefined,
          ...(freshNamespace ? { namespace: freshNamespace } : {}),
        });
        if (freshNamespace && repoId) {
          await writeNamespaceManifest(
            input.datastorePath,
            freshNamespace,
            repoId,
          );
        }
      }

      // an external filesystem datastore is copied, never cleaned up: other
      // repositories may share it
      if (
        migrate && errors.length === 0 &&
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

      // the catalog indexes the old datastore; drop it so the next command
      // rebuilds from the new one, since a kept catalog misses what the new
      // datastore already held
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
 * a new, empty v3 datastore with nothing migrated; setup refuses while the
 * current datastore holds records, since their files would sit in the checkout
 * with no commit behind them
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

  // a v3 checkout materialises its namespace at .swamp/{namespace}/, so one
  // named after a directory swamp keeps there would be written over it; the
  // repo is not on v3 yet, so the v2 steps to move off the name still apply
  const { namespace } = await deps.currentDatastore(input.repoDir);
  if (namespace && isReservedNamespaceName(namespace)) {
    yield refuse(layoutCollisionMessage(namespace));
    return;
  }
  // a materialised subdirectory linking out of .swamp would fail every catch-up
  // of the new datastore
  try {
    await deps.assertV3CacheContained(
      input.repoDir,
      namespace ?? "",
      input.directories ?? undefined,
    );
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    yield refuse(error.message);
    return;
  }

  const target = await deps.inspectV3Target(input.datastorePath);
  if (target.kind === "refused") {
    yield refuse(
      `A v3 datastore needs a new, empty directory: ${target.reason}. ` +
        "Migrating an existing datastore to v3 is not supported yet.",
    );
    return;
  }

  // records the repo uses now would be left behind with no commit naming them;
  // .swamp is where v3 materialises records, so it must hold none even under
  // --skip-migration
  const source = await resolveMigrationSource(ctx, deps, input);
  // a current datastore that cannot be read may hold records: refuse, as v2
  // setup does, rather than leave them behind
  if (!input.skipMigration && "error" in source) {
    yield { kind: "error", error: source.error };
    return;
  }
  const sourceDir = "error" in source ? source.currentPath : source.sourceDir;
  const repoSwampDir = swampPath(input.repoDir);
  const subdirs = deps.getDatastoreDirectories({ type: "filesystem" })
    .filter((subdir) =>
      !(REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(subdir)
    );
  // the checkout's own .swamp is always checked, even under --skip-migration,
  // since a record left there would be materialised with no commit behind it;
  // the current datastore is checked unless migration is skipped
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
    // the files a v3 checkout keeps as its own are no records, as on its first
    // open
    if (
      await deps.hasDatastoreRecords(
        dir,
        subdirs,
        CATALOG_FILES,
        isCheckoutLocalKey,
      )
    ) {
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
    // a namespace set before setup is the datastore's namespace: setup owns the
    // key, so leaving it out would drop it
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

/**
 * refuses, writing nothing, a datastore that cannot host v3, a non-empty bucket
 * prefix, or a repository holding records; nothing is migrated, pushed or
 * pulled, and no v2 manifest is registered
 */
async function* setupV3Extension(
  ctx: LibSwampContext,
  deps: DatastoreSetupDeps,
  input: DatastoreSetupExtensionInput,
  provider: DatastoreProvider,
): AsyncIterable<DatastoreSetupEvent> {
  const refuse = (message: string): DatastoreSetupEvent => ({
    kind: "error",
    error: { code: "validation_failed", message },
  });

  try {
    deps.assertV3BucketHost(provider, input.type);
    await deps.assertV3ExtensionVersion(input.type, input.repoDir);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    yield {
      kind: "error",
      error: {
        code: err.code ?? "validation_failed",
        message: err.message,
        cause: err,
      },
    };
    return;
  }

  // as on a v3 filesystem setup: a materialised subdirectory linking out of
  // .swamp would fail every open of the new datastore
  try {
    await deps.assertV3CacheContained(
      input.repoDir,
      input.namespace ?? "",
      undefined,
    );
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    yield refuse(err.message);
    return;
  }

  const target = await deps.inspectV3BucketTarget(
    provider,
    input.type,
    input.repoDir,
    input.namespace,
  );
  if (target.kind === "refused") {
    yield refuse(
      `A v3 datastore needs a new, empty bucket prefix, but ${target.reason}. ` +
        "Migrating an existing datastore to v3 is not supported yet. " +
        "Nothing was changed.",
    );
    return;
  }

  // as on a v3 filesystem setup: .swamp is where the v3 datastore materialises
  // records, so it is always checked
  const subdirs = deps.getDatastoreDirectories({ type: "filesystem" })
    .filter((subdir) =>
      !(REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(subdir)
    );
  const dirs = [
    swampPath(input.repoDir),
    ...(input.namespace ? [swampPath(input.repoDir, input.namespace)] : []),
    ...(!input.skipMigration && input.outgoingDatastorePath
      ? [input.outgoingDatastorePath]
      : []),
    ...(!input.skipMigration && input.outgoingCachePath
      ? [
        input.namespace
          ? join(input.outgoingCachePath, input.namespace)
          : input.outgoingCachePath,
      ]
      : []),
  ];
  for (const dir of dirs) {
    // the files a v3 checkout keeps as its own are no records, as on its first
    // open
    if (
      await deps.hasDatastoreRecords(
        dir,
        subdirs,
        CATALOG_FILES,
        isCheckoutLocalKey,
      )
    ) {
      yield refuse(
        `${dir} holds records. A v3 datastore starts empty, and migrating ` +
          "existing records to v3 is not supported yet. Set up v3 in a " +
          "repository with no data.",
      );
      return;
    }
  }

  if (target.kind === "resumable") {
    ctx.logger
      .info`Resuming the v3 setup of this ${input.type} datastore: it holds only its format marker`;
  }
  try {
    await deps.createV3BucketDatastore(provider, input.type);
  } catch (err) {
    yield formatRefusal(err);
    return;
  }
  await deps.updateRepoConfig(input.repoDir, {
    type: input.type,
    config: input.config,
    // a namespace set before setup is the datastore's namespace: setup owns the
    // key, so leaving it out would drop it
    ...(input.namespace ? { namespace: input.namespace } : {}),
    format: 3,
  });
  // The v2 catalog indexes the old datastore; the v3 one is the read model's.
  await deps.invalidateCatalog(input.repoDir);

  yield {
    kind: "completed",
    data: {
      type: input.type,
      format: 3,
      filesCopied: 0,
      filesPulled: 0,
      bytesCopied: 0,
      directoriesMigrated: [],
      errors: [],
      ...(input.namespace ? { namespace: input.namespace } : {}),
    },
  };
}

export interface DatastoreSetupExtensionInput {
  type: string;
  config: Record<string, unknown>;
  repoDir: string;
  repoId?: string;
  skipMigration: boolean;
  hydrationStrategy?: "full" | "lazy";
  namespace?: string;
  /**
   * true when namespace is the one the repo's config already holds, not one
   * this setup claims; only changes the error for a reserved name
   */
  namespaceAlreadyBound?: boolean;
  syncTimeoutMsOverride?: number;
  outgoingDatastorePath?: string;
  /**
   * the current extension datastore's local cache, which a v3 setup checks for
   * records, as it checks the checkout
   */
  outgoingCachePath?: string;
  /**
   * format 3 needs a provider that can host it, a new and empty bucket prefix
   * and a repository with no records
   */
  format?: 2 | 3;
}

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

      let config: Record<string, unknown>;
      try {
        config = await deps.resolveConfigExpressions(
          input.repoDir,
          input.config,
        );
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

      if (typeInfo.configSchema) {
        const result = typeInfo.configSchema.safeParse(config);
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

      const provider = typeInfo.createProvider(config);
      const cachePath = provider.resolveCachePath?.(input.repoDir) ??
        join(getSwampDataDir(), "repos", input.repoId ?? "unknown");

      let targetEngine: DatastoreEngine | void;
      try {
        targetEngine = await deps.assertDatastoreFormat(input.repoDir, {
          type: input.type,
          config,
          datastorePath: provider.resolveDatastorePath(input.repoDir),
          cachePath,
          ...(input.namespace ? { namespace: input.namespace } : {}),
          // not persisted yet: its marker says what it is
          override: true,
        }, provider);
      } catch (err) {
        yield formatRefusal(err);
        return;
      }
      // a bucket that is already v3 takes no v2 setup: v2's sync would write v2
      // files beside it
      if (targetEngine === "v3" && input.format !== 3) {
        yield {
          kind: "error",
          error: {
            code: "validation_failed",
            message: `This ${input.type} datastore is a v3 datastore. Set ` +
              "it up with `swamp datastore setup extension " +
              `${input.type} --config '...' --format 3\` (a v3 datastore ` +
              "takes a repository with no records). Nothing was changed.",
          },
        };
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

      // warns about existing data at the remote prefix when no namespace is
      // set, so foreign data is not silently absorbed
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

      // a v2 binding to a name reserved later still works unless it is a layout
      // directory; v3 refuses every reserved name
      if (
        ns && input.namespaceAlreadyBound &&
        (namespaceCollidesWithLayout(ns, []) ||
          (input.format === 3 && isReservedNamespaceName(ns)))
      ) {
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
          if (input.namespaceAlreadyBound) restoreNamespace(ns);
          else createNamespace(ns);
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

      if (input.format === 3) {
        yield* setupV3Extension(ctx, deps, input, provider);
        return;
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
      // a filesystem datastore outside the repo is the source, not .swamp/
      const sourceDir = input.outgoingDatastorePath ??
        swampPath(input.repoDir);
      // a namespace set before setup with no data yet has nothing to copy into
      // the cache; pull and namespace registration still run
      let freshNamespace = false;
      if (input.outgoingDatastorePath && !input.skipMigration) {
        const fresh = await freshNamespaceStart(
          deps,
          input.repoDir,
          input.outgoingDatastorePath,
        );
        if (fresh && "error" in fresh) {
          yield { kind: "error", error: fresh.error };
          return;
        }
        freshNamespace = fresh !== undefined;
        const error = fresh
          ? undefined
          : await inaccessibleSourceError(input.outgoingDatastorePath);
        if (error) {
          yield { kind: "error", error };
          return;
        }
      }

      if (!input.skipMigration && !freshNamespace && syncService) {
        yield { kind: "migrating" };

        // under managedConfig, instance-local state in .swamp/config (pulled
        // extension sources, the lockfile) must never reach the cache: the push
        // would upload it over the remote config tier
        const role = await sourceConfigRole(deps, input.repoDir, sourceDir);
        migrationSkips = inRepoConfigMigrationSkips(role);
        cleanupKeeps = migrationSkips;

        const migrationDest = ns ? join(cachePath, ns) : cachePath;

        // An in-repo tier may be joining a remote holding the team's config
        // tier: pull it first so the push never overwrites it. Any failure
        // stops setup.
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

          // always pass namespace so the extension scopes the push to
          // {namespace}/ on the remote
          if (result.filesCopied > 0 || skippedConfigFiles > 0) {
            ctx.logger.debug`Pushing data to remote datastore...`;
            try {
              // the copy wrote into the cache behind the sync service; a clean
              // cache would otherwise take the push fast path and upload none
              // of it
              await syncService.markDirty();
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

      // Hydration runs unconditionally with a sync service, independent of
      // skip-migration: a contributor joining a populated remote needs it.
      if (syncService && errors.length === 0) {
        // ensures the cache directory exists before pull: the skip-migration
        // path does not create it, and a sync service that does not ensureDir
        // would ENOENT on the first write
        await deps.ensureDir(cachePath);
        yield { kind: "hydrating" };
        ctx.logger.debug`Hydrating cache from remote datastore...`;
        try {
          // always pass namespace so the pull is scoped to {namespace}/;
          // without it the extension reads the root index and downloads all
          // data, foreign namespaces included
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

      // clean up only after both push and pull succeed, so a pull failure keeps
      // .swamp/ intact for a retry; an external filesystem datastore is never
      // cleaned up since other repositories may share it
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

      // persist when data movement succeeded or only timeouts occurred: a
      // timeout means the datastore is configured but the transfer was slow;
      // hard failures still block. Setup owns the namespace key
      if (errors.length === 0 || onlyTimeouts) {
        const persistedConfig: Record<string, unknown> = {
          type: input.type,
          // the expressions, never what they resolved to: a vault secret must
          // not reach .swamp.yaml
          config: input.config,
        };
        if (input.hydrationStrategy) {
          persistedConfig.hydrationStrategy = input.hydrationStrategy;
        }
        if (ns) {
          persistedConfig.namespace = ns;
        }
        await deps.updateRepoConfig(input.repoDir, persistedConfig);
        await deps.invalidateCatalog(input.repoDir);
      }

      // Only after a complete transfer: a timeout-only commit may leave the
      // tier partly hydrated, which proves nothing about the remote.
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

      if ((errors.length === 0 || onlyTimeouts) && ns && input.repoId) {
        const datastorePath = provider.resolveDatastorePath(input.repoDir);
        if (provider.registerNamespace) {
          try {
            await provider.registerNamespace(datastorePath, ns, input.repoId);
            // materialise the manifest into the local cache so push's orphan
            // detection sees a local counterpart and does not delete the remote
            // copy
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
 * symlinks resolve through Deno.realPath (macOS /tmp is /private/tmp); a path
 * that cannot be resolved is compared as given
 */
async function isSamePath(a: string, b: string): Promise<boolean> {
  return await realOrResolved(a) === await realOrResolved(b);
}

async function realOrResolved(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return resolve(path);
  }
}

async function inaccessibleSourceError(
  path: string,
): Promise<SwampError | undefined> {
  let reason: string | undefined;
  try {
    if (!(await Deno.stat(path)).isDirectory) reason = "not a directory";
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  // setup creates every datastore subdir on its first move, so a root holding
  // none is not a datastore: typically an unmounted mount point whose empty
  // directory would migrate as zero files
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

/**
 * a fresh start: the repo's own .swamp/<namespace> is absent or holds no
 * datastore subdir, so setup has nothing to move; undefined for anything else,
 * external roots included. Refuses while un-namespaced records remain in .swamp
 */
async function freshNamespaceStart(
  deps: DatastoreSetupDeps,
  repoDir: string,
  root: string,
): Promise<{ namespace: string } | { error: SwampError } | undefined> {
  const { namespace } = await deps.currentDatastore(repoDir);
  if (!namespace || !await isSamePath(root, swampPath(repoDir, namespace))) {
    return undefined;
  }
  try {
    const info = await Deno.stat(root);
    if (!info.isDirectory || await holdsDatastoreSubdir(root)) {
      return undefined;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) return undefined;
  }

  const repoSwampDir = swampPath(repoDir);
  const subdirs = deps.getDatastoreDirectories({ type: "filesystem" })
    .filter((subdir) =>
      !(REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(subdir)
    );
  // instance-local config never moves with a datastore, so it is not a record
  // left behind
  const skips = [
    ...inRepoConfigMigrationSkips(await deps.resolveInRepoConfigRole(repoDir)),
    ...CATALOG_FILES,
  ];
  if (await deps.hasDatastoreRecords(repoSwampDir, subdirs, skips)) {
    return {
      error: {
        code: "validation_failed",
        message: `${repoSwampDir} holds records outside namespace ` +
          `${namespace}, and setup would leave them behind. Move them into ` +
          `the namespace with 'swamp datastore namespace migrate --confirm', ` +
          `then re-run setup. Nothing was changed.`,
      },
    };
  }
  return { namespace };
}

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
 * an external root that is missing or not a directory is an error, never a
 * fallback to .swamp/
 */
async function resolveMigrationSource(
  ctx: LibSwampContext,
  deps: DatastoreSetupDeps,
  input: DatastoreSetupFilesystemInput,
): Promise<
  | { sourceDir: string; fromOutgoingCache: boolean; freshNamespace?: string }
  | { error: SwampError; currentPath: string }
> {
  if (input.outgoingDatastorePath) {
    const path = input.outgoingDatastorePath;
    const fresh = await freshNamespaceStart(deps, input.repoDir, path);
    if (fresh && "error" in fresh) {
      return { error: fresh.error, currentPath: path };
    }
    if (fresh) {
      return {
        sourceDir: path,
        fromOutgoingCache: false,
        freshNamespace: fresh.namespace,
      };
    }
    const error = await inaccessibleSourceError(path);
    if (error) return { error, currentPath: path };
    return { sourceDir: path, fromOutgoingCache: false };
  }

  // switching from a remote datastore, content lives in the local cache, not
  // under .swamp/: use the cache path when provided and present on disk
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
 * an external filesystem datastore's config is the managed tier when
 * .swamp.yaml says so; an inspection that fails counts as instance-local, so
 * nothing moves
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
 * copying into the migrated subdir that holds destPath would recurse into its
 * own output, and cleanup would then delete the destination
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
 * its key and secrets stay on this machine, so other machines sharing the
 * datastore cannot read the values; advisory: a failed lookup is logged and
 * skipped rather than failing setup
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
 * hydrateSentinel gives a lazily hydrated tier one chance to fetch the sentinel
 * before it counts as empty; advisory: setup has already committed .swamp.yaml,
 * so a failed inspection is logged and skipped
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
        `no behavior, workflow or vault definitions, so this repo will not ` +
        `find any. Run 'swamp datastore config migrate' to copy this repo's ` +
        `models/, workflows/ and vaults/ into the tier. Setup does not move ` +
        `definitions that were only in the previous datastore's config ` +
        `tier; copy those in yourself.`,
      configTierPath: tier.tierPath,
    },
  };
}

/**
 * a tier outside the cache (an excluded config) is never fetched, and a failed
 * or timed-out fetch counts as absent
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

/** supplied by the caller because resolving a datastore is a CLI concern */
export type ResolveConfigTierPath = (
  repoDir: string,
  marker: RepoMarkerData,
) => Promise<string | undefined>;

/** supplied by the caller because reading env and vaults is a CLI concern */
export type ResolveConfigExpressions = (
  repoDir: string,
  config: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * required so every caller decides, through the same datastore resolution the
 * CLI uses at startup, whether the repo's .swamp/config is the config tier and
 * what the expressions in a setup's config resolve to
 */
export function createDatastoreSetupDeps(
  _repoDir: string,
  resolveConfigTierPath: ResolveConfigTierPath,
  resolveConfigExpressions: ResolveConfigExpressions,
  options: {
    /** Recorded as `writtenBy` in a v3 datastore's format marker. */
    readonly swampVersion?: string;
  } = {},
): DatastoreSetupDeps {
  return {
    requireUpgradedRepo,
    resolveConfigExpressions,
    assertV3CacheContained: assertV3CacheSubdirsContained,
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
        // run logs stay with the checkout: their records point at them in
        // .swamp whatever the datastore
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
    assertV3BucketHost: (provider, type) => {
      assertV3BucketHost(provider, type);
    },
    assertV3ExtensionVersion: async (type, repoDir) => {
      const marker = await new RepoMarkerRepository().read(
        RepoPath.create(repoDir),
      );
      const modelsDir = resolveModelsDir(marker);
      await assertV3BucketExtensionVersions(
        repoDir,
        type,
        marker?.datastore?.managedConfig === true ? undefined : join(
          isAbsolute(modelsDir) ? modelsDir : join(repoDir, modelsDir),
          "upstream_extensions.json",
        ),
      );
    },
    inspectV3BucketTarget: (provider, type, repoDir, namespace) =>
      inspectV3BucketTarget(provider, type, repoDir, namespace),
    createV3BucketDatastore: (provider, type) =>
      initializeV3BucketDatastore(
        provider,
        type,
        options.swampVersion ?? "unknown",
      ),
    assertDatastoreFormat: (repoDir, config, provider) =>
      ensureSupportedDatastoreFormat(repoDir, config, {
        // a lost marker's advice names setup, not the repo's datastore
        setupTarget: true,
        ...(provider
          ? { resolveProvider: () => Promise.resolve(provider) }
          : {}),
      }),
  };
}

/**
 * a nested symlink is compared as a file and never descended into, matching how
 * migration copies it
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
 * a symlink is never descended into: with a kept path inside it the link stays,
 * so cleanup never deletes its target's files; removal failures are non-fatal
 * since the source may be gone
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
    return;
  }
  if (keepFile) await removeIfEmpty(path);
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    for await (const _ of Deno.readDir(path)) return;
    await Deno.remove(path);
  } catch {
    // Non-fatal: already gone, or not empty
  }
}

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
  // a setup that stopped after writing the marker leaves a fresh skeleton; a
  // re-run completes it, and writes the marker if a crash lost it
  if (await isFreshV3Skeleton(path)) return { kind: "empty" };
  for await (const entry of Deno.readDir(path)) {
    return {
      kind: "refused",
      reason: `${path} is not empty (it holds ${entry.name})`,
    };
  }
  return { kind: "empty" };
}

async function currentDatastore(
  repoDir: string,
): Promise<{ engine: DatastoreEngine; namespace?: string; repoId?: string }> {
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repoDir),
  );
  const namespace = marker?.datastore?.namespace;
  return {
    engine: datastoreBlockEngine(repoDir, marker?.datastore),
    ...(namespace ? { namespace } : {}),
    ...(marker?.repoId ? { repoId: marker.repoId } : {}),
  };
}
