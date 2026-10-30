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

import { Command } from "@cliffy/command";
import {
  type CatalogCompletenessSummary,
  type CatalogShortfall,
  doctorDatastores,
  type DoctorDatastoresData,
  type DoctorDatastoresDeps,
  repairCatalogDuplicateLatest,
  type RepairCatalogDuplicateLatestDeps,
  repairCatalogIndex,
  type RepairCatalogIndexDeps,
  repairDatastoreContamination,
  repairDatastoreFormatMarker,
  type RepairDatastoresDeps,
  repairPreV3Records,
  repairUnmigratedData,
  type RepairUnmigratedDataDeps,
  repairUnreadableVersions,
  type RepairUnreadableVersionsDeps,
} from "../../libswamp/datastores/doctor_datastores.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createLibSwampContext,
  type LibSwampContext,
} from "../../libswamp/context.ts";
import {
  createCatalogDuplicateLatestRepairRenderer,
  createCatalogIndexRepairRenderer,
  createDatastoreFormatMarkerRepairRenderer,
  createDoctorDatastoresRenderer,
  createPreV3RecordsRepairRenderer,
  createRepairDatastoresRenderer,
  createUnmigratedDataRepairRenderer,
  createUnreadableVersionsRepairRenderer,
  type DatastoreFormatMarkerRepairStatus,
  DatastoreRepairJsonReport,
  type PreV3RecordsRepairStatus,
} from "../../presentation/renderers/doctor_datastores.ts";
import {
  type CommandContext,
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  acquireModelLocks,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
} from "../repo_context.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import {
  retentionScanSourcesFor,
  scanRetention,
} from "../../libswamp/datastores/retention_check.ts";
import type { RetentionCheckSummary } from "../../libswamp/datastores/retention_check.ts";
import { RetentionPolicy } from "../../domain/retention/retention_policy.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { DoctorDatastoresResponse } from "../../serve/protocol.ts";
import {
  type CustomDatastoreConfig,
  type DatastoreConfig,
  DEFAULT_DATASTORE_SUBDIRS,
  getDatastoreDirectories,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { namespaceCollidesWithLayout } from "../../domain/data/namespace.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { UserError } from "../../domain/errors.ts";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  DATASTORE_FORMAT_MARKER_INVALID_CODE,
  DATASTORE_FORMAT_MISMATCH_CODE,
  type DatastoreEngine,
} from "../../domain/datastore/datastore_format.ts";
import { lostDatastoreFormatMarker } from "../../infrastructure/persistence/datastore_format_guard.ts";
import {
  restoreV3FormatMarker,
  v3CheckoutFilterRefusal,
} from "../../infrastructure/datastore_v3/v3_datastore.ts";
import {
  inspectV3Content,
  inspectV3KeptLineages,
  inspectV3ReplicaRestorable,
} from "../../infrastructure/datastore_v3/v3_content_inspection.ts";
import {
  movePreV3CheckoutRecords,
  PRE_V3_RECORDS_DIR,
  preV3CheckoutRecordDirs,
  V3CheckoutHoldsRecordsError,
} from "../../infrastructure/datastore_v3/v3_checkout_join.ts";
import { VERSION } from "./version.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { resolveDatastoreConfig } from "../resolve_datastore.ts";
import { removeStaleOutputSummaries } from "../../infrastructure/persistence/output_summary_index.ts";
import { RUNS_INDEX_FILENAME } from "../../infrastructure/persistence/workflow_run_index.ts";
import {
  createCatalogStore,
  createUnifiedDataRepository,
  namespaceFromResolver,
  removeCatalogDb,
} from "../../infrastructure/persistence/repository_factory.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import type { Namespace } from "../../domain/data/namespace.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { UnreadableDataVersion } from "../../domain/data/unreadable_data_version.ts";
import { scanUnreadableVersions } from "../../infrastructure/persistence/unreadable_data_versions.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { join } from "@std/path";
import {
  compareFiles,
  dirHasFiles,
  removeEmptyDirs,
} from "../../infrastructure/persistence/directory_merge.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * `doctor datastores --repair` after the format guard refused the repo's
 * datastore with `refusal` (swamp-club#3617): when the repo's config says
 * format 3 and its filesystem datastore is a v3 datastore whose marker a
 * crash lost, previews the restore, or with `confirm` restores the marker.
 * Resolves with the repair's status, or undefined when this is not such a
 * datastore, for the caller to rethrow the refusal unchanged. Nothing in
 * the datastore is opened before `confirm`.
 */
export async function repairLostV3FormatMarker(
  repoDir: string,
  refusal: unknown,
  outputMode: OutputMode,
  confirm: boolean,
): Promise<DatastoreFormatMarkerRepairStatus | undefined> {
  if (
    !(refusal instanceof UserError) ||
    (refusal.code !== DATASTORE_FORMAT_MISMATCH_CODE &&
      refusal.code !== DATASTORE_FORMAT_MARKER_INVALID_CODE)
  ) {
    return undefined;
  }
  const repoPath = RepoPath.create(repoDir);
  const config = await resolveDatastoreConfig(
    await new RepoMarkerRepository().read(repoPath),
    undefined,
    repoPath.value,
  );
  if (isCustomDatastoreConfig(config) || config.format !== 3) return undefined;
  const datastorePath = config.path;
  if (await lostDatastoreFormatMarker(datastorePath) === undefined) {
    return undefined;
  }
  const renderer = createDatastoreFormatMarkerRepairRenderer(outputMode);
  await consumeStream(
    repairDatastoreFormatMarker(createLibSwampContext(), {
      datastorePath,
      markerPath: join(datastorePath, DATASTORE_FORMAT_MARKER_FILE),
      inspect: () => lostDatastoreFormatMarker(datastorePath),
      restore: () => restoreV3FormatMarker(datastorePath, VERSION),
    }, { confirm }),
    renderer.handlers(),
  );
  return renderer.overallStatus;
}

/**
 * Moves aside the records of a checkout the first v3 open refused because
 * its `.swamp/` holds them (swamp-club#3690), when `refusal` is that
 * refusal; previews without `confirm`. Returns the renderer's status, or
 * undefined when `refusal` is another error.
 */
export async function repairPreV3CheckoutRecords(
  repoDir: string,
  refusal: unknown,
  outputMode: OutputMode,
  confirm: boolean,
): Promise<PreV3RecordsRepairStatus | undefined> {
  if (!(refusal instanceof V3CheckoutHoldsRecordsError)) return undefined;
  const repoPath = RepoPath.create(repoDir);
  const { namespace } = await resolveDatastoreConfig(
    await new RepoMarkerRepository().read(repoPath),
    undefined,
    repoPath.value,
  );
  const renderer = createPreV3RecordsRepairRenderer(outputMode);
  await consumeStream(
    repairPreV3Records(createLibSwampContext(), {
      swampDir: swampPath(repoPath.value),
      preV3RecordsDir: swampPath(repoPath.value, PRE_V3_RECORDS_DIR),
      inspect: () => preV3CheckoutRecordDirs(repoPath.value, namespace),
      moveAside: async () => {
        const moved = await movePreV3CheckoutRecords(repoPath.value, namespace);
        // The v2 catalog indexed them, as v3 setup removes it.
        if (moved.moved.length > 0) await removeCatalogDb(repoPath.value);
        return moved;
      },
    }, { confirm }),
    renderer.handlers(),
  );
  return renderer.overallStatus;
}

async function resolveProvider(
  config: CustomDatastoreConfig,
): Promise<DatastoreProvider> {
  await datastoreTypeRegistry.ensureTypeLoaded(config.type);
  const typeInfo = datastoreTypeRegistry.get(config.type);
  if (!typeInfo?.createProvider) {
    throw new Error(
      `No provider available for datastore type "${config.type}"`,
    );
  }
  return typeInfo.createProvider(config.config);
}

/**
 * Scans the repository's storage for items older than each kind's retention
 * (`--retention`, swamp-club#3473), through the read-only repository context:
 * no lock, no sync. Watermarks are read where the datastore keeps them
 * locally (a filesystem datastore).
 */
async function checkRetention(
  repoDir: string,
  outputMode: OutputMode,
): Promise<RetentionCheckSummary> {
  const opened = await requireInitializedRepoReadOnly({ repoDir, outputMode });
  const { datastoreConfig } = await resolveDatastoreForRepo(opened.repoDir);
  return await scanRetention(
    retentionScanSourcesFor({
      repoDir: opened.repoDir,
      datastoreConfig,
      datastoreResolver: opened.datastoreResolver,
      dataRepo: opened.repoContext.unifiedDataRepo,
      watermarks: opened.repoContext.retentionWatermarks,
    }),
    RetentionPolicy.fromConfig(opened.marker?.garbageCollection),
    new Date(),
  );
}

async function createDoctorDatastoresDeps(
  repoDir: string,
  outputMode: OutputMode,
  engine: DatastoreEngine,
  v2Filesystem: boolean,
): Promise<DoctorDatastoresDeps> {
  await datastoreTypeRegistry.ensureLoaded();
  return {
    getDatastoreConfig: async () => {
      const markerRepo = new RepoMarkerRepository();
      const marker = await markerRepo.read(RepoPath.create(repoDir));
      return await resolveDatastoreConfig(marker, undefined, repoDir);
    },
    checkHealth: async (config) => {
      if (isCustomDatastoreConfig(config)) {
        await datastoreTypeRegistry.ensureTypeLoaded(config.type);
        const typeInfo = datastoreTypeRegistry.get(config.type);
        if (typeInfo?.createProvider) {
          const provider = typeInfo.createProvider(config.config);
          const verifier = provider.createVerifier();
          return await verifier.verify();
        }
        return {
          healthy: false,
          message: "No provider available for datastore type",
          latencyMs: 0,
        };
      } else {
        const verifier = new FilesystemDatastoreVerifier(config.path);
        return await verifier.verify();
      }
    },
    getVaultConfigs: async () => {
      const vaultRepo = new YamlVaultConfigRepository(repoDir);
      try {
        const vaultConfigs = await vaultRepo.findAll();
        return vaultConfigs.map((vc) => ({ name: vc.name, type: vc.type }));
      } catch {
        return [];
      }
    },
    checkUnmigratedData: async (config) => {
      if (!config.namespace) {
        return { unmigrated: false, directories: [] };
      }
      const basePath = isCustomDatastoreConfig(config) && config.cachePath
        ? config.cachePath
        : isCustomDatastoreConfig(config)
        ? config.datastorePath
        : config.path;
      const found: string[] = [];
      for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
        try {
          const stat = await Deno.stat(join(basePath, subdir));
          if (stat.isDirectory && await dirHasFiles(join(basePath, subdir))) {
            found.push(subdir);
          }
        } catch {
          // Directory doesn't exist — expected when migrated
        }
      }
      return { unmigrated: found.length > 0, directories: found };
    },
    checkNamespaceContamination: async (config) => {
      // A v3 datastore has no v2 namespace prefixes to contaminate
      // (swamp-club#3534).
      if (
        !config.namespace || !isCustomDatastoreConfig(config) ||
        config.format === 3
      ) {
        return null;
      }
      const provider = await resolveProvider(config);
      const cachePath = provider.resolveCachePath?.(repoDir) ??
        config.cachePath ?? config.datastorePath;
      const syncService = provider.createSyncService?.(repoDir, cachePath);
      if (!syncService?.repairNamespaceContamination) return null;

      return await syncService.repairNamespaceContamination({
        namespace: config.namespace,
        dryRun: true,
      });
    },
    checkCatalogCompleteness: () => checkCatalogCompleteness(repoDir),
    // Only where every file is local: lazy hydration leaves files missing
    // on purpose, and a v3 checkout has its own content check
    // (swamp-club#3955).
    ...(v2Filesystem
      ? { checkUnreadableVersions: () => scanRepoUnreadableVersions(repoDir) }
      : {}),
    checkRetention: () => checkRetention(repoDir, outputMode),
    // Checkout-local state and chunk stats only (swamp-club#3617).
    ...(engine === "v3"
      ? {
        checkV3Content: (config: DatastoreConfig) =>
          inspectV3Content({ repoDir, datastoreConfig: config }),
        // The datastore's lineage records only (swamp-club#3801).
        checkV3KeptLineages: (config: DatastoreConfig) =>
          inspectV3KeptLineages({ repoDir, datastoreConfig: config }),
        // The checkout's own copy only (swamp-club#3935).
        checkV3ReplicaRestorable: (config: DatastoreConfig) =>
          inspectV3ReplicaRestorable({ repoDir, datastoreConfig: config }),
        checkV3Filter: (config: DatastoreConfig) =>
          Promise.resolve(
            v3CheckoutFilterRefusal(
              repoDir,
              config.directories,
              config.exclude,
            ),
          ),
      }
      : {}),
  };
}

/**
 * Compares the local catalog index against the on-disk data walk, per model
 * type, counting only latest-version records on both sides.
 *
 * Reads the catalog directly rather than issuing a data query: a query would
 * trigger the catalog backfill, which repairs the exact condition being
 * measured — the diagnostic would then always report health. Exported so that
 * property can be tested against a real damaged catalog rather than a fake.
 *
 * Only shortfalls are reported. A type with more indexed rows than the walk
 * can see is not a shortfall — that is what foreign-namespace rows look like.
 */
export async function compareCatalogToDisk(
  catalogStore: CatalogStore,
  dataRepo: UnifiedDataRepository,
  namespace: Namespace,
): Promise<CatalogCompletenessSummary> {
  const diskByType = new Map<string, number>();
  for (const record of await dataRepo.findAllGlobal()) {
    const type = record.modelType.normalized;
    diskByType.set(type, (diskByType.get(type) ?? 0) + 1);
  }
  const catalogByType = catalogStore.latestRowCountsByType(namespace);

  const shortfalls: CatalogShortfall[] = [];
  let diskRecords = 0;
  let catalogRecords = 0;
  for (const [typeNormalized, onDisk] of diskByType) {
    const indexed = catalogByType.get(typeNormalized) ?? 0;
    diskRecords += onDisk;
    catalogRecords += indexed;
    if (indexed < onDisk) {
      shortfalls.push({
        typeNormalized,
        diskRecords: onDisk,
        catalogRecords: indexed,
      });
    }
  }

  return { diskRecords, catalogRecords, shortfalls };
}

/**
 * The data dir the completeness check walks: the one every command reads,
 * as the repository factory resolves it. The local `.swamp/data` holds no
 * records when the datastore lives elsewhere (swamp-club#3238).
 */
export function catalogCompletenessDataDir(
  datastoreResolver: DatastorePathResolver,
): string {
  return datastoreResolver.resolvePath(SWAMP_SUBDIRS.data);
}

async function checkCatalogCompleteness(
  repoDir: string,
): Promise<CatalogCompletenessSummary | null> {
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(RepoPath.create(repoDir));
  const config = await resolveDatastoreConfig(marker, undefined, repoDir);
  const datastoreResolver = new DefaultDatastorePathResolver(repoDir, config);
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);

  try {
    const namespace = namespaceFromResolver(datastoreResolver);
    const dataRepo = createUnifiedDataRepository(
      repoDir,
      catalogStore,
      catalogCompletenessDataDir(datastoreResolver),
      undefined,
      namespace,
    );
    return await compareCatalogToDisk(catalogStore, dataRepo, namespace);
  } finally {
    // Release the SQLite handle before any repair removes the file — Windows
    // refuses to delete a database that still has an open connection.
    catalogStore.close();
  }
}

/**
 * Every published data version of the repo's datastore that cannot be read
 * (swamp-club#3955), through its own catalog handle and data repository:
 * read-only, no lock, no data query.
 */
async function scanRepoUnreadableVersions(
  repoDir: string,
): Promise<UnreadableDataVersion[]> {
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repoDir),
  );
  const config = await resolveDatastoreConfig(marker, undefined, repoDir);
  const datastoreResolver = new DefaultDatastorePathResolver(repoDir, config);
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);
  try {
    const namespace = namespaceFromResolver(datastoreResolver);
    const dataRepo = createUnifiedDataRepository(
      repoDir,
      catalogStore,
      catalogCompletenessDataDir(datastoreResolver),
      undefined,
      namespace,
    );
    return await scanUnreadableVersions(dataRepo, catalogStore, namespace);
  } finally {
    // Released before a later repair stage removes the catalog file, which
    // Windows refuses while a connection is open.
    catalogStore.close();
  }
}

/**
 * Unreadable-version repair deps (swamp-club#3955). The scan is the check's;
 * the repair opens the repository to write, takes the affected models'
 * locks as `swamp data delete` does, and runs in a root unit, which pushes
 * and releases the locks when it ends, whether or not the repair failed.
 */
function createUnreadableVersionsRepairDeps(
  repoDir: string,
  cliCtx: CommandContext,
): RepairUnreadableVersionsDeps {
  return {
    scan: () => scanRepoUnreadableVersions(repoDir),
    underModelLocks: async (models, fn) => {
      const {
        repoDir: openedRepoDir,
        repoContext,
        datastoreConfig,
        syncService,
      } = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: cliCtx.outputMode,
      });
      try {
        const lockResult = await acquireModelLocks(
          datastoreConfig,
          [...models],
          openedRepoDir,
          syncService,
          repoContext.catalogStore,
        );
        if (lockResult.synced) repoContext.catalogStore.invalidate();
        return await runCommandInRootUnit(
          repoContext,
          {
            push: lockResult.push,
            release: lockResult.release,
            onCleanupError: (releaseError) => {
              cliCtx.logger.warn(
                "Failed to release locks during cleanup: {error}",
                {
                  error: releaseError instanceof Error
                    ? releaseError.message
                    : String(releaseError),
                },
              );
            },
          },
          () => {
            const dataRepo = repoContext.unifiedDataRepo;
            return fn({
              scan: () =>
                scanUnreadableVersions(
                  dataRepo,
                  repoContext.catalogStore,
                  dataRepo.namespace,
                ),
              rollBack: (record, versions) =>
                dataRepo.rollBackToReadable(
                  ModelType.create(record.modelType),
                  record.modelId,
                  record.dataName,
                  versions,
                ),
            });
          },
        );
      } finally {
        // Released before the catalog repair below may remove the file.
        repoContext.catalogStore.close();
      }
    },
  };
}

/**
 * Catalog repair deps.
 *
 * Deliberately free of the namespace and custom-datastore requirements the
 * other repairs carry: the catalog is a local index, and a plain local repo is
 * exactly where an incomplete one goes unnoticed.
 */
function createCatalogRepairDeps(repoDir: string): RepairCatalogIndexDeps {
  return {
    checkCompleteness: () => checkCatalogCompleteness(repoDir),
    invalidateCatalog: () => removeCatalogDb(repoDir),
  };
}

function createDuplicateLatestRepairDeps(
  repoDir: string,
): RepairCatalogDuplicateLatestDeps {
  const store = createCatalogStore(repoDir);
  return {
    countDuplicateLatest: () => store.countDuplicateLatest(),
    enforceUniqueLatest: () => store.enforceUniqueLatest(computeLatestFlags),
  };
}

async function createRepairDeps(
  repoDir: string,
): Promise<RepairDatastoresDeps> {
  await datastoreTypeRegistry.ensureLoaded();

  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(RepoPath.create(repoDir));
  const config = await resolveDatastoreConfig(marker, undefined, repoDir);

  if (!isCustomDatastoreConfig(config) || !config.namespace) {
    throw new UserError(
      "Repair is only available for custom datastores with a namespace configured.",
    );
  }
  if (config.format === 3) {
    throw new UserError(
      "Repair is only available for format 2 datastores: a format 3 (v3) " +
        "datastore has no v2 namespace prefixes to repair.",
    );
  }

  const provider = await resolveProvider(config);
  const cachePath = provider.resolveCachePath?.(repoDir) ??
    config.cachePath ?? config.datastorePath;
  const syncService = provider.createSyncService?.(repoDir, cachePath);

  if (!syncService?.repairNamespaceContamination) {
    throw new UserError(
      `Datastore type "${config.type}" does not support namespace contamination repair.`,
    );
  }

  const namespace = config.namespace;

  return {
    getDatastoreConfig: () => Promise.resolve(config),
    detectContamination: () =>
      syncService.repairNamespaceContamination!({
        namespace,
        dryRun: true,
      }),
    deleteContamination: () =>
      syncService.repairNamespaceContamination!({
        namespace,
        dryRun: false,
      }),
    wipeLocalCache: async () => {
      for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
        const dir = join(cachePath, namespace, subdir);
        try {
          await Deno.remove(dir, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
    },
    pullScoped: async () => {
      const count = await syncService.pullChanged({ namespace });
      return count ?? 0;
    },
    invalidateWorkflowRunIndexes: async () => {
      let invalidated = 0;
      const dirs = [
        swampPath(repoDir, "workflow-runs"),
        join(cachePath, namespace, "workflow-runs"),
      ];
      for (const workflowRunsDir of dirs) {
        try {
          for await (const entry of Deno.readDir(workflowRunsDir)) {
            if (entry.isDirectory) {
              const indexPath = join(
                workflowRunsDir,
                entry.name,
                RUNS_INDEX_FILENAME,
              );
              try {
                await Deno.remove(indexPath);
                invalidated++;
              } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
              }
            }
          }
          const rootIndex = join(workflowRunsDir, RUNS_INDEX_FILENAME);
          try {
            await Deno.remove(rootIndex);
            invalidated++;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      // Output summaries are the same kind of derived file, rebuilt on read.
      await removeStaleOutputSummaries(repoDir);
      return invalidated;
    },
    invalidateCatalog: () => removeCatalogDb(repoDir),
  };
}

async function listFilesRecursive(
  dir: string,
  prefix = "",
): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const relPath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory && !entry.isSymlink) {
        // Loop, not push(...): one directory can hold more files than fit
        // in a spread call (swamp-club#2565).
        for (
          const file of await listFilesRecursive(join(dir, entry.name), relPath)
        ) {
          files.push(file);
        }
      } else {
        files.push(relPath);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files;
}

async function createUnmigratedRepairDeps(
  repoDir: string,
): Promise<RepairUnmigratedDataDeps> {
  const markerRepo = new RepoMarkerRepository();
  const marker = await markerRepo.read(RepoPath.create(repoDir));
  const config = await resolveDatastoreConfig(marker, undefined, repoDir);

  if (!config.namespace) {
    throw new UserError(
      "Unmigrated data repair is only available when a namespace is configured.",
    );
  }

  const basePath = isCustomDatastoreConfig(config) && config.cachePath
    ? config.cachePath
    : isCustomDatastoreConfig(config)
    ? config.datastorePath
    : config.path;

  return {
    getBasePath: () => basePath,
    getNamespace: () => config.namespace!,
    getDatastoreDirectories: () => getDatastoreDirectories(config),
    listFiles: (dir: string) => listFilesRecursive(dir),
    compareFiles: (a: string, b: string) => compareFiles(a, b),
    removeFile: (path: string) => Deno.remove(path),
    removeEmptyDirs: (dir: string) => removeEmptyDirs(dir).then(() => {}),
    dirExists: async (path: string) => {
      try {
        const stat = await Deno.stat(path);
        return stat.isDirectory;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Runs the v2 `doctor datastores --repair` stages in order, each reporting
 * through its renderer; under --json they record into `report`, which the
 * caller prints. Resolves true when any stage failed or was skipped for a
 * reason the user must act on, so the command exits 1.
 */
async function runDatastoreRepairs(
  repoDir: string,
  cliCtx: CommandContext,
  libCtx: LibSwampContext,
  report: DatastoreRepairJsonReport,
  confirm: boolean,
  v2Filesystem: boolean,
): Promise<boolean> {
  let failed = false;

  let unmigratedDeps: RepairUnmigratedDataDeps | null = null;
  try {
    unmigratedDeps = await createUnmigratedRepairDeps(repoDir);
  } catch (error) {
    if (error instanceof UserError) {
      cliCtx.logger.debug`Skipping unmigrated data repair: ${error.message}`;
    } else {
      throw error;
    }
  }

  // A namespace named after a layout directory cannot have this repair run
  // against it; skip it here so the repairs below still run.
  if (
    unmigratedDeps &&
    namespaceCollidesWithLayout(
      unmigratedDeps.getNamespace(),
      unmigratedDeps.getDatastoreDirectories(),
    )
  ) {
    cliCtx.logger
      .warn`Skipping unmigrated data repair: namespace ${unmigratedDeps.getNamespace()} has the same name as a datastore layout directory. Run 'swamp doctor datastores' for how to move it.`;
    failed = true;
    unmigratedDeps = null;
  }

  if (unmigratedDeps) {
    const unmigratedRenderer = createUnmigratedDataRepairRenderer(
      cliCtx.outputMode,
      report,
    );

    await consumeStream(
      repairUnmigratedData(libCtx, unmigratedDeps, { confirm }),
      unmigratedRenderer.handlers(),
    );

    if (unmigratedRenderer.overallStatus === "fail") {
      failed = true;
    }
  }

  // Unreadable versions are rolled back before the catalog repair, so a
  // rebuild it triggers indexes the repaired disk (swamp-club#3955). Only
  // where every file is local, as the check.
  if (v2Filesystem) {
    const unreadableRenderer = createUnreadableVersionsRepairRenderer(
      cliCtx.outputMode,
      report,
    );
    await consumeStream(
      repairUnreadableVersions(
        libCtx,
        createUnreadableVersionsRepairDeps(repoDir, cliCtx),
        { confirm },
      ),
      unreadableRenderer.handlers(),
    );
    if (unreadableRenderer.overallStatus === "fail") {
      failed = true;
    }
  }

  // Catalog repair runs before contamination repair: contamination repair
  // ends by invalidating the catalog itself, so running it first would leave
  // the completeness check comparing against a catalog that no longer exists.
  const catalogRenderer = createCatalogIndexRepairRenderer(
    cliCtx.outputMode,
    report,
  );
  await consumeStream(
    repairCatalogIndex(libCtx, createCatalogRepairDeps(repoDir), { confirm }),
    catalogRenderer.handlers(),
  );
  if (catalogRenderer.overallStatus === "fail") {
    failed = true;
  }

  const dupLatestRenderer = createCatalogDuplicateLatestRepairRenderer(
    cliCtx.outputMode,
    report,
  );
  await consumeStream(
    repairCatalogDuplicateLatest(
      libCtx,
      createDuplicateLatestRepairDeps(repoDir),
      { confirm },
    ),
    dupLatestRenderer.handlers(),
  );
  if (dupLatestRenderer.overallStatus === "fail") {
    failed = true;
  }

  let contaminationDeps: RepairDatastoresDeps | null = null;
  try {
    contaminationDeps = await createRepairDeps(repoDir);
  } catch (error) {
    if (error instanceof UserError) {
      cliCtx.logger
        .debug`Skipping namespace contamination repair: ${error.message}`;
    } else {
      throw error;
    }
  }

  if (!contaminationDeps) return failed;

  const renderer = createRepairDatastoresRenderer(cliCtx.outputMode, report);
  await consumeStream(
    repairDatastoreContamination(libCtx, contaminationDeps, { confirm }),
    renderer.handlers(),
  );
  return failed || renderer.overallStatus === "fail";
}

export const doctorDatastoresCommand = withRemoteOptions(
  new Command()
    .description(
      "Check that the configured datastore is healthy and flag any " +
        "vault compatibility issues.",
    )
    .example("Check this repo's datastore", "swamp doctor datastores")
    .example("Machine-readable output for CI", "swamp doctor datastores --json")
    .example(
      "Check that nothing is stored past its retention",
      "swamp doctor datastores --retention",
    )
    .example(
      "Preview datastore repair",
      "swamp doctor datastores --repair",
    )
    .example(
      "Execute datastore repair",
      "swamp doctor datastores --repair -y",
    )
    .option(
      "--repo-dir <dir:string>",
      "Repository directory (env: SWAMP_REPO_DIR)",
    )
    .option(
      "--repair",
      "Preview and repair datastore issues: unreadable data versions, catalog index completeness, root-level unmigrated data, and foreign namespace contamination (add -y to execute).",
    )
    .option(
      "-y, --yes",
      "Execute the repair (without this, --repair shows a preview).",
    )
    .option(
      "--retention",
      "Also scan storage for workflow runs, snapshots, outputs, data versions and audit logs older than the garbageCollection retention in .swamp.yaml, and show each kind's last retention pass.",
    ),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, [
    "doctor",
    "datastores",
  ]);
  cliCtx.logger.debug("Executing doctor datastores command");

  // Refused before the remote branch, so a serve sees the same flags as a
  // local run.
  if (options.retention && options.repair) {
    throw new UserError(
      "--retention is a check and cannot be combined with --repair.",
    );
  }

  const server = resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(
      server,
      options,
    );
    const response = await requestServerResponse<DoctorDatastoresResponse>(
      { server, token },
      {
        type: "doctor.datastores",
        payload: options.retention ? { retention: true } : {},
      },
    );
    const renderer = createDoctorDatastoresRenderer(cliCtx.outputMode);
    await consumeStream(
      (async function* () {
        yield {
          kind: "completed" as const,
          data: response.data as unknown as DoctorDatastoresData,
        };
      })(),
      renderer.handlers(),
    );
    // A serve older than --retention drops the option and answers without
    // the check, which must not read as a pass.
    if (
      options.retention &&
      !(response.data as Partial<DoctorDatastoresData>).retentionFinding
    ) {
      cliCtx.logger
        .warn`The server did not run the retention check; it may predate --retention. Upgrade the server or run the check locally.`;
    }
    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
    return;
  }

  if (options.yes && !options.repair) {
    throw new UserError("The --yes flag requires --repair.");
  }
  const repoDir = resolveRepoDir(options.repoDir);
  let engine: DatastoreEngine;
  let datastoreConfig: DatastoreConfig;
  try {
    ({ engine, datastoreConfig } = await resolveDatastoreForRepo(repoDir));
  } catch (error) {
    // A v3 datastore whose marker a crash lost is refused by the format
    // guard; --repair restores the marker (swamp-club#3617). A checkout
    // whose records stop it joining a v3 datastore has them moved aside
    // (swamp-club#3690). Any other refusal is rethrown unchanged.
    const status = options.repair
      ? await repairLostV3FormatMarker(
        repoDir,
        error,
        cliCtx.outputMode,
        Boolean(options.yes),
      ) ??
        await repairPreV3CheckoutRecords(
          repoDir,
          error,
          cliCtx.outputMode,
          Boolean(options.yes),
        )
      : undefined;
    // A restore that fails throws from the renderer, as a UserError.
    if (status === undefined) throw error;
    return;
  }
  const libCtx = createLibSwampContext();
  // A format 2 filesystem datastore, whose data files are all local
  // (swamp-club#3955).
  const v2Filesystem = engine === "v2" &&
    !isCustomDatastoreConfig(datastoreConfig);

  // The repairs are v2's: they rewrite datastore directories and the v2
  // catalog, which a v3 datastore does not have, and none takes the v3
  // writer lock (swamp-club#3279).
  if (options.repair && engine === "v3") {
    throw new UserError(
      "`swamp doctor datastores --repair` is not available for v3 " +
        "datastores yet. A v3 checkout rebuilds its records and catalog from " +
        "the commit log; run `swamp doctor datastores` to check it. Nothing " +
        "was changed.",
    );
  }

  if (options.repair) {
    // Each stage records its result here, and under --json the report is
    // printed once, so the output is one JSON document (swamp-club#4011). It
    // prints in the finally so a stage that throws still reports the stages
    // that finished; Deno.exit skips pending finally blocks, so the exit
    // comes after it.
    const report = new DatastoreRepairJsonReport();
    let failed: boolean;
    try {
      failed = await runDatastoreRepairs(
        repoDir,
        cliCtx,
        libCtx,
        report,
        Boolean(options.yes),
        v2Filesystem,
      );
    } finally {
      if (cliCtx.outputMode === "json") report.print();
    }
    cliCtx.logger.debug("doctor datastores repair completed");
    if (failed) Deno.exit(1);
    return;
  }

  const deps = await createDoctorDatastoresDeps(
    repoDir,
    cliCtx.outputMode,
    engine,
    v2Filesystem,
  );
  const renderer = createDoctorDatastoresRenderer(cliCtx.outputMode);

  await consumeStream(
    doctorDatastores(libCtx, deps, { retention: Boolean(options.retention) }),
    renderer.handlers(),
  );

  cliCtx.logger.debug("doctor datastores command completed");

  if (renderer.overallStatus === "fail") {
    Deno.exit(1);
  }
});
