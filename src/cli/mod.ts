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
import { setColorEnabled } from "@std/fmt/colors";
import { isAbsolute, join, resolve } from "@std/path";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import { readUpstreamExtensions } from "../infrastructure/persistence/upstream_extensions.ts";
import { enumeratePulledExtensionDirs } from "../libswamp/mod.ts";
import { getLogger, parseLogLevel } from "@logtape/logtape";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { VERSION, versionCommand } from "./commands/version.ts";
import { modelCommand } from "./commands/model_create.ts";
import { repoCommand, repoInitCommand } from "./commands/repo_init.ts";
import { workflowCommand } from "./commands/workflow.ts";
import { completionCommand } from "./commands/completion.ts";
import { vaultCommand } from "./commands/vault.ts";
import { dataCommand } from "./commands/data.ts";
import { issueCommand } from "./commands/issue.ts";
import { telemetryCommand } from "./commands/telemetry_stats.ts";
import { auditCommand } from "./commands/audit.ts";
import { updateCommand } from "./commands/update.ts";
import { sourceCommand } from "./commands/source.ts";
import { authCommand } from "./commands/auth.ts";
import { extensionCommand } from "./commands/extension.ts";
import { summariseCommand } from "./commands/summarise.ts";
import { datastoreCommand } from "./commands/datastore.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { reportCommand } from "./commands/report.ts";
import { serveCommand } from "./commands/serve.ts";
import { openCommand } from "./commands/open.ts";
import { createHelpCommand } from "./commands/help.ts";
import { unknownCommandErrorHandler } from "./unknown_command_handler.ts";
import {
  getRepoDirFromArgs,
  type GlobalOptions,
  isStdinTty,
} from "./context.ts";
import {
  ModelNameType,
  ModelTypeType,
  WorkflowNameType,
} from "./completion_types.ts";
import { UserModelLoader } from "../domain/models/user_model_loader.ts";
import { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import { UserVaultLoader } from "../domain/vaults/user_vault_loader.ts";
import { UserDriverLoader } from "../domain/drivers/user_driver_loader.ts";
import { UserDatastoreLoader } from "../domain/datastore/user_datastore_loader.ts";
import { UserReportLoader } from "../domain/reports/user_report_loader.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { driverTypeRegistry } from "../domain/drivers/driver_type_registry.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";

// Import driver types barrel to trigger built-in driver registration
import "../domain/drivers/driver_types.ts";
// Import datastore types barrel to trigger built-in datastore registration
import "../domain/datastore/datastore_types.ts";
// Import builtin reports to trigger registration
import "../domain/reports/builtin/mod.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { ExtensionAutoResolver } from "../domain/extensions/extension_auto_resolver.ts";
import { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../domain/auth/auth_credentials.ts";
import { setAutoResolver } from "./auto_resolver_context.ts";
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
} from "./auto_resolver_adapters.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import { JsonTelemetryRepository } from "../infrastructure/persistence/json_telemetry_repository.ts";
import { HttpTelemetrySender } from "../infrastructure/telemetry/http_telemetry_sender.ts";
import {
  extractCommandInfo,
  isTelemetryDisabled,
} from "./telemetry_integration.ts";
import { UserIdentityRepository } from "../infrastructure/persistence/user_identity_repository.ts";
import { AuthRepository } from "../infrastructure/persistence/auth_repository.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import { resolveDatastoreConfig } from "./resolve_datastore.ts";
import { isDevBuild } from "../domain/update/update_service.ts";
import { UpdateNotificationService } from "../domain/update/update_notification_service.ts";
import { UpdateCheckCacheFileRepository } from "../infrastructure/update/update_check_cache_file_repository.ts";
import { HttpUpdateChecker } from "../infrastructure/update/http_update_checker.ts";
import { Platform } from "../domain/update/platform.ts";
import { renderUpdateNotification } from "../presentation/renderers/update_notification.ts";
import { getOutputModeFromArgs } from "./context.ts";
import { flushDatastoreSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { withSpan } from "../infrastructure/tracing/mod.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";
import type { ResolvedSourceDirs } from "../domain/repo/swamp_sources.ts";

// Import models barrel to trigger self-registration
import "../domain/models/models.ts";

// Import and re-export — the canonical definitions live in
// separate files to avoid circular imports through mod.ts.
import { resolveModelsDir } from "./resolve_models_dir.ts";
export { resolveModelsDir };
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";
export { resolveWorkflowsDir };
import { resolveVaultsDir } from "./resolve_vaults_dir.ts";
export { resolveVaultsDir };
import { resolveDriversDir } from "./resolve_drivers_dir.ts";
export { resolveDriversDir };
import { resolveDatastoresDir } from "./resolve_datastores_dir.ts";
export { resolveDatastoresDir };
import { resolveReportsDir } from "./resolve_reports_dir.ts";
export { resolveReportsDir };

const logger = getLogger(["swamp", "cli"]);

/**
 * Resolves the log level.
 * Priority: SWAMP_LOG_LEVEL env var > .swamp.yaml config > undefined (caller uses default)
 *
 * @internal Exported for testing
 */
export function resolveLogLevel(
  marker: RepoMarkerData | null,
): string | undefined {
  const envVal = Deno.env.get("SWAMP_LOG_LEVEL");
  if (envVal) return envVal;
  if (marker?.logLevel) return marker.logLevel;
  return undefined;
}

/**
 * Checks whether telemetry is disabled via .swamp.yaml config.
 *
 * @internal Exported for testing
 */
export function isTelemetryDisabledByConfig(
  marker: RepoMarkerData | null,
): boolean {
  return marker?.telemetryDisabled === true;
}

/**
 * Checks whether telemetry is disabled via SWAMP_NO_TELEMETRY environment variable.
 * Any value other than "0", "false", or empty string disables telemetry.
 *
 * @internal Exported for testing
 */
export function isTelemetryDisabledByEnv(): boolean {
  const val = Deno.env.get("SWAMP_NO_TELEMETRY");
  if (val === undefined) return false;
  return val !== "0" && val !== "false" && val !== "";
}

/**
 * Checks whether update checks are disabled via SWAMP_NO_UPDATE_CHECK environment variable.
 * Any value other than "0", "false", or empty string disables update checks.
 *
 * @internal Exported for testing
 */
export function isUpdateCheckDisabledByEnv(): boolean {
  const val = Deno.env.get("SWAMP_NO_UPDATE_CHECK");
  if (val === undefined) return false;
  return val !== "0" && val !== "false" && val !== "";
}

/**
 * Commands that are never run inside a swamp repo and therefore
 * never need extension loader setup.
 */
const NON_REPO_COMMANDS = new Set([
  "", // no command = show help
  "help",
  "version",
  "completions",
  "init",
  "update",
  "auth",
  "telemetry",
  "issue",
]);

/**
 * Checks whether a command may need the extension loader infrastructure.
 * Returns false for commands that never operate inside a swamp repo.
 *
 * Note: this does NOT control when extensions are actually loaded — that
 * is determined lazily by each command calling registry.ensureLoaded().
 * This only controls whether the loader functions are *configured* on the
 * registries.
 *
 * @internal Exported for testing
 */
/**
 * Configures the extension loaders on all registries for a given repository.
 * Exported so that commands that can switch repositories at runtime (like
 * `swamp serve open` with its filesystem picker) can re-configure the loaders
 * when the user picks a different repo.
 */
export async function configureExtensionLoaders(
  repoDir: string,
  marker: RepoMarkerData | null,
  resolvedSources: ResolvedSourceDirs[],
  deferredWarnings: DeferredWarning[],
): Promise<void> {
  const denoRuntime = new EmbeddedDenoRuntime();
  const sourceModelsDirs = collectDirsForKind(resolvedSources, "models");
  const sourceVaultsDirs = collectDirsForKind(resolvedSources, "vaults");
  const sourceDriversDirs = collectDirsForKind(resolvedSources, "drivers");
  const sourceDatastoresDirs = collectDirsForKind(
    resolvedSources,
    "datastores",
  );
  const sourceReportsDirs = collectDirsForKind(resolvedSources, "reports");

  let resolverPromise: Promise<DatastorePathResolver | undefined> | undefined;
  const lazyResolver = (): Promise<DatastorePathResolver | undefined> => {
    resolverPromise ??= resolveDatastoreConfig(marker, undefined, repoDir)
      .then((config) =>
        new DefaultDatastorePathResolver(
          repoDir,
          config,
        ) as DatastorePathResolver
      )
      .catch(() => undefined);
    return resolverPromise;
  };

  const catalogDbPath = swampPath(repoDir, "_extension_catalog.db");
  const catalog = new ExtensionCatalogStore(catalogDbPath);

  modelRegistry.setLoader(() =>
    loadUserModels(
      repoDir,
      marker,
      denoRuntime,
      sourceModelsDirs,
      lazyResolver,
      catalog,
    )
  );
  vaultTypeRegistry.setLoader(() =>
    loadUserVaults(
      repoDir,
      marker,
      denoRuntime,
      sourceVaultsDirs,
      lazyResolver,
      catalog,
    )
  );
  driverTypeRegistry.setLoader(() =>
    loadUserDrivers(
      repoDir,
      marker,
      denoRuntime,
      sourceDriversDirs,
      lazyResolver,
      catalog,
    )
  );
  datastoreTypeRegistry.setLoader(() =>
    loadUserDatastores(
      repoDir,
      marker,
      denoRuntime,
      sourceDatastoresDirs,
      catalog,
    )
  );
  reportRegistry.setLoader(() =>
    loadUserReports(
      repoDir,
      marker,
      denoRuntime,
      sourceReportsDirs,
      lazyResolver,
      catalog,
    )
  );

  await checkForMissingPulledExtensions(repoDir, marker, deferredWarnings);
}

/**
 * Configures the global extension auto-resolver for a given repository.
 * Exported so commands that switch repositories at runtime can reconfigure.
 */
export function configureExtensionAutoResolver(
  repoDir: string,
  marker: RepoMarkerData | null,
  authCollectives: string[] | undefined,
  outputMode: "log" | "json",
): void {
  const trustedCollectives = resolveTrustedCollectives(marker, authCollectives);
  if (trustedCollectives.length === 0 || !marker) {
    setAutoResolver(null);
    return;
  }
  const serverUrl = Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
  const extensionClient = new ExtensionApiClient(serverUrl);
  const modelsDir = resolveModelsDir(marker);
  const denoRuntime = new EmbeddedDenoRuntime();
  setAutoResolver(
    new ExtensionAutoResolver({
      allowedCollectives: trustedCollectives,
      extensionLookup: extensionClient,
      extensionInstaller: createAutoResolveInstallerAdapter({
        getExtension: (name) => extensionClient.getExtension(name),
        downloadArchive: (name, version) =>
          extensionClient.downloadArchive(name, version),
        getChecksum: (name, version) =>
          extensionClient.getChecksum(name, version),
        lockfilePath: join(
          resolve(repoDir, modelsDir),
          "upstream_extensions.json",
        ),
        repoDir,
        denoRuntime,
        catalog: new ExtensionCatalogStore(
          swampPath(repoDir, "_extension_catalog.db"),
        ),
      }),
      output: createAutoResolveOutputAdapter(outputMode),
    }),
  );
}

export function commandNeedsLoaderSetup(args: string[]): boolean {
  const commandInfo = extractCommandInfo(args);
  return !NON_REPO_COMMANDS.has(commandInfo.command);
}

/** A deferred warning message to emit after logging is initialized. */
export interface DeferredWarning {
  kind: "model" | "vault" | "driver" | "datastore" | "report" | "extensions";
  file: string;
  error: string;
}

/**
 * Load user models from configured directory.
 * Uses the bundle catalog for lazy per-bundle loading when available.
 */
async function loadUserModels(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  catalog?: ExtensionCatalogStore,
): Promise<void> {
  try {
    const modelsDir = resolveModelsDir(marker);
    // Handle both absolute and relative paths (cross-platform)
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(repoDir, modelsDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new UserModelLoader(denoRuntime, repoDir, resolver);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "models",
    );

    // Use bundle catalog for lazy per-bundle loading.
    // The catalog stays open for the process lifetime so the type loader
    // can query it when ensureTypeLoaded() is called later.
    const effectiveCatalog = catalog ??
      new ExtensionCatalogStore(swampPath(repoDir, "_extension_catalog.db"));

    // Set type loader on the registry for on-demand loading
    modelRegistry.setTypeLoader(async (type) => {
      await loader.loadSingleType(type, effectiveCatalog);
    });

    // Build the index: reads catalog + mtime scan for freshness.
    // If catalog is populated, only rebundles changed files.
    // If not populated (first run), does a full import to bootstrap.
    // Always scans for staleness so users never see stale data.
    // Load order: local > sources > pulled (sources override pulled).
    // pulledDirs is one entry per installed extension — the loader walks
    // each extension's subtree independently so file-name collisions across
    // sibling extensions can't bleed into each other.
    const result = await loader.buildIndex(
      absoluteModelsDir,
      effectiveCatalog,
      {
        additionalDirs: [...sourceDirs, ...pulledDirs],
      },
    );

    for (const failure of result.failed) {
      if (failure.error.startsWith("Cannot extend unregistered model type")) {
        logger
          .warn`User extension ${failure.file} targets unregistered base type — will retry once the base is loaded: ${failure.error}`;
      } else {
        logger
          .warn`Failed to load user model ${failure.file}: ${failure.error}`;
      }
    }
  } catch {
    // Not in a swamp repo or models dir doesn't exist — not an error
  }
}

/**
 * Load user vault implementations from configured directory.
 * Uses the bundle catalog for lazy per-bundle loading when available.
 */
async function loadUserVaults(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  catalog?: ExtensionCatalogStore,
): Promise<void> {
  try {
    const vaultsDir = resolveVaultsDir(marker);
    const absoluteVaultsDir = isAbsolute(vaultsDir)
      ? vaultsDir
      : resolve(repoDir, vaultsDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new UserVaultLoader(denoRuntime, repoDir, resolver);
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "vaults",
    );

    if (catalog) {
      vaultTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type, catalog);
      });

      const result = await loader.buildIndex(absoluteVaultsDir, catalog, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user vault ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.loadVaults(absoluteVaultsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user vault ${failure.file}: ${failure.error}`;
      }
    }
  } catch {
    // Not in a swamp repo or vaults dir doesn't exist — not an error
  }
}

async function loadUserDrivers(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  catalog?: ExtensionCatalogStore,
): Promise<void> {
  try {
    const driversDir = resolveDriversDir(marker);
    const absoluteDriversDir = isAbsolute(driversDir)
      ? driversDir
      : resolve(repoDir, driversDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new UserDriverLoader(denoRuntime, repoDir, resolver);
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "drivers",
    );

    if (catalog) {
      driverTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type, catalog);
      });

      const result = await loader.buildIndex(absoluteDriversDir, catalog, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user driver ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.loadDrivers(absoluteDriversDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user driver ${failure.file}: ${failure.error}`;
      }
    }
  } catch {
    // Not in a swamp repo or drivers dir doesn't exist — not an error
  }
}

async function loadUserDatastores(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  catalog?: ExtensionCatalogStore,
): Promise<void> {
  try {
    const datastoresDir = resolveDatastoresDir(marker);
    const absoluteDatastoresDir = isAbsolute(datastoresDir)
      ? datastoresDir
      : resolve(repoDir, datastoresDir);

    const loader = new UserDatastoreLoader(denoRuntime, repoDir);
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "datastores",
    );

    if (catalog) {
      datastoreTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type, catalog);
      });

      const result = await loader.buildIndex(
        absoluteDatastoresDir,
        catalog,
        {
          additionalDirs: [...sourceDirs, ...pulledDirs],
        },
      );

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user datastore ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.loadDatastores(absoluteDatastoresDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user datastore ${failure.file}: ${failure.error}`;
      }
    }
  } catch {
    // Not in a swamp repo or datastores dir doesn't exist — not an error
  }
}

async function loadUserReports(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  catalog?: ExtensionCatalogStore,
): Promise<void> {
  try {
    const reportsDir = resolveReportsDir(marker);
    const absoluteReportsDir = isAbsolute(reportsDir)
      ? reportsDir
      : resolve(repoDir, reportsDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new UserReportLoader(denoRuntime, repoDir, resolver);
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "reports",
    );

    if (catalog) {
      reportRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type, catalog);
      });

      const result = await loader.buildIndex(absoluteReportsDir, catalog, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user report ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.loadReports(absoluteReportsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user report ${failure.file}: ${failure.error}`;
      }
    }
  } catch {
    // Not in a swamp repo or reports dir doesn't exist — not an error
  }
}

/**
 * Check if upstream_extensions.json has entries whose source files are
 * missing from disk. This catches cases where pulled extensions weren't
 * restored (e.g. after git clone without running `swamp extension install`).
 */
async function checkForMissingPulledExtensions(
  repoDir: string,
  marker: RepoMarkerData | null,
  deferredWarnings: DeferredWarning[],
): Promise<void> {
  try {
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(repoDir, modelsDir);
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");

    const upstream = await readUpstreamExtensions(lockfilePath);
    const extensionNames = Object.keys(upstream);
    if (extensionNames.length === 0) return;

    // Check for any missing source files (skip bundle files — they're cached)
    const missingExtensions: string[] = [];
    for (const [name, entry] of Object.entries(upstream)) {
      if (!entry.files) continue;
      const sourceFiles = entry.files.filter((f) =>
        !f.endsWith(".js") && !f.endsWith(".md") && !f.endsWith(".txt")
      );
      for (const file of sourceFiles) {
        const absolutePath = join(repoDir, file);
        try {
          await Deno.stat(absolutePath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            missingExtensions.push(name);
            break; // One missing file is enough to flag this extension
          }
        }
      }
    }

    if (missingExtensions.length > 0) {
      deferredWarnings.push({
        kind: "extensions",
        file: lockfilePath,
        error:
          `${missingExtensions.length} pulled extension(s) have missing source files: ${
            missingExtensions.join(", ")
          }. Run 'swamp extension install' to restore them.`,
      });
    }
  } catch {
    // Non-fatal — don't block startup for lockfile read errors
  }
}

/** Default telemetry endpoint */
const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.swamp-club.com";

/** Telemetry endpoint used when auth serverUrl is a localhost address */
const LOCALHOST_TELEMETRY_ENDPOINT = "http://localhost:8080";

/**
 * Checks whether the given URL points to a localhost address.
 *
 * @internal Exported for testing
 */
export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Resolves the telemetry endpoint.
 * Priority: .swamp.yaml telemetryEndpoint > localhost auto-detect from auth serverUrl > default
 *
 * @internal Exported for testing
 */
export function resolveTelemetryEndpoint(
  markerEndpoint: string | undefined,
  authServerUrl: string | null,
): string {
  if (markerEndpoint) return markerEndpoint;
  if (authServerUrl && isLocalhostUrl(authServerUrl)) {
    return LOCALHOST_TELEMETRY_ENDPOINT;
  }
  return DEFAULT_TELEMETRY_ENDPOINT;
}

import { resolveTrustedCollectives } from "../libswamp/mod.ts";

interface TelemetryContext {
  service: TelemetryService;
  userId: string | null;
  repoId: string;
  telemetryEndpoint: string;
  keepFlushed: boolean;
  authToken: string | null;
}

/**
 * Initialize telemetry service if in a swamp repository.
 * Lazy-migrates repoId if missing from marker file.
 */
async function initTelemetryService(
  repoDir: string,
): Promise<TelemetryContext | null> {
  try {
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);

    const marker = await markerRepo.read(repoPath);
    if (!marker) {
      return null; // Not in a swamp repo
    }

    if (isTelemetryDisabledByConfig(marker)) {
      return null;
    }

    // Lazy-migrate repoId if missing
    let repoId = marker.repoId;
    if (!repoId) {
      repoId = crypto.randomUUID();
      marker.repoId = repoId;
      await markerRepo.write(repoPath, marker);
    }

    // Resolve user-level identity (lazy-creates ~/.config/swamp/identity.json)
    const identityRepo = new UserIdentityRepository();
    const userId = await identityRepo.getUserId();

    // Try loading auth credentials for authenticated telemetry
    // (loaded before telemetry endpoint resolution for localhost auto-detect)
    let authToken: string | null = null;
    let authServerUrl: string | null = null;
    try {
      const authRepo = new AuthRepository();
      const creds = await authRepo.load();
      if (creds?.apiKey) {
        authToken = creds.apiKey;
      }
      if (creds?.serverUrl) {
        authServerUrl = creds.serverUrl;
      }
    } catch {
      // Auth file unreadable — continue without auth
    }

    const repository = new JsonTelemetryRepository(repoDir);
    const service = new TelemetryService(repository, VERSION);
    const telemetryEndpoint = resolveTelemetryEndpoint(
      marker.telemetryEndpoint,
      authServerUrl,
    );

    const keepFlushed = marker.telemetryKeepFlushed ?? false;

    return {
      service,
      userId,
      repoId,
      telemetryEndpoint,
      keepFlushed,
      authToken,
    };
  } catch {
    // Not in a swamp repo or other error
    return null;
  }
}

export async function runCli(args: string[]): Promise<void> {
  // Capture start time for telemetry
  const startTime = new Date();

  // Pre-parse --repo-dir so startup functions use the correct repository
  const repoDir = getRepoDirFromArgs(args);

  // Pre-parse check for telemetry disable flag
  const telemetryDisabled = isTelemetryDisabled(args) ||
    isTelemetryDisabledByEnv();

  // Extract command info for telemetry (before parsing)
  const commandInfo = extractCommandInfo(args);

  // Initialize telemetry service (only if in a swamp repo)
  let telemetryCtx: TelemetryContext | null = null;
  if (!telemetryDisabled) {
    telemetryCtx = await initTelemetryService(repoDir);
  }

  // Read marker once for log level, extension loading, and auto-resolver
  let marker: RepoMarkerData | null = null;
  try {
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    marker = await markerRepo.read(repoPath);
  } catch {
    // Not in a swamp repo - marker stays null
  }

  // Read extension sources (additional extension directories from
  // .swamp-sources.yaml). Resolved once and shared across all loaders.
  let resolvedSources: ResolvedSourceDirs[] = [];
  const sourcesConfig = await readSwampSources(repoDir);
  if (sourcesConfig) {
    const expanded = await expandSourcePaths(sourcesConfig, repoDir);
    resolvedSources = await resolveSourceExtensionDirs(expanded);
  }

  // Configure lazy extension loaders on each registry.
  // Extensions are NOT loaded here — they load on first access when a
  // command calls registry.ensureLoaded() via its dep factory.
  // Warnings are logged directly by the loaders (logging is initialized
  // by the time ensureLoaded() runs inside command .action() handlers).
  const deferredWarnings: DeferredWarning[] = [];
  if (commandNeedsLoaderSetup(args)) {
    await configureExtensionLoaders(
      repoDir,
      marker,
      resolvedSources,
      deferredWarnings,
    );
  }

  // Load cached auth collectives for membership-based trust
  let authCollectives: string[] | undefined;
  try {
    const authRepo = new AuthRepository();
    const creds = await authRepo.load();
    authCollectives = creds?.collectives;
  } catch {
    // Auth file unreadable — continue without membership collectives
  }

  // Create auto-resolver for trusted collectives (merging membership collectives)
  configureExtensionAutoResolver(
    repoDir,
    marker,
    authCollectives,
    getOutputModeFromArgs(args),
  );

  const cli = new Command()
    .name("swamp")
    .version(VERSION)
    .description("AI Native Automation CLI")
    .globalType("model_name", new ModelNameType())
    .globalType("model_type", new ModelTypeType())
    .globalType("workflow_name", new WorkflowNameType())
    .globalOption("--json", "Output in JSON format (non-interactive)")
    .globalOption("--log", "Force flat log output (no interactive tree)")
    .globalOption(
      "--log-level <level:string>",
      "Set log level (trace, debug, info, warning, error, fatal)",
    )
    .globalOption("-q, --quiet", "Suppress non-essential output")
    .globalOption("-v, --verbose", "Show detailed output")
    .globalOption("--no-telemetry", "Disable telemetry for this invocation")
    .globalOption(
      "--show-properties",
      "Show structured properties in log output",
    )
    .globalOption("--no-color", "Disable colored output")
    .globalAction(async function (options: GlobalOptions) {
      const noColor = options.color === false ||
        Deno.env.get("NO_COLOR") !== undefined;
      if (noColor) {
        Deno.env.set("NO_COLOR", "1");
        setColorEnabled(false);
      }
      const prettyOutput = !noColor && isStdinTty();

      // Derive log level: --quiet → error, --log-level → parsed,
      // SWAMP_LOG_LEVEL env var / .swamp.yaml logLevel → parsed, default → info
      let logLevel: "trace" | "debug" | "info" | "warning" | "error" | "fatal" =
        "info";
      if (options.quiet) {
        logLevel = "error";
      } else if (options.logLevel) {
        logLevel = parseLogLevel(options.logLevel);
      } else {
        const resolved = resolveLogLevel(marker);
        if (resolved) logLevel = parseLogLevel(resolved);
      }

      await initializeLogging({
        prettyOutput,
        showProperties: options.showProperties ?? false,
        logLevel,
        jsonMode: options.json ?? false,
        noColor,
      });

      // Emit deferred warnings now that logging is initialized
      for (const warning of deferredWarnings) {
        if (warning.kind === "extensions") {
          logger.warn`${warning.error}`;
        } else {
          logger
            .warn`Failed to load user ${warning.kind} ${warning.file}: ${warning.error}`;
        }
      }
    })
    .error(unknownCommandErrorHandler)
    .action(function () {
      this.showHelp();
    })
    .command("version", versionCommand)
    .command("model", modelCommand)
    .command("init", repoInitCommand)
    .command("repo", repoCommand)
    .command("workflow", workflowCommand)
    .command("vault", vaultCommand)
    .command("data", dataCommand)
    .command("telemetry", telemetryCommand)
    .command("audit", auditCommand.hidden())
    .command("update", updateCommand)
    .command("source", sourceCommand)
    .command("completions", completionCommand)
    .command("issue", issueCommand)
    .command("auth", authCommand)
    .command("extension", extensionCommand)
    .command("summarise", summariseCommand)
    .command("datastore", datastoreCommand)
    .command("doctor", doctorCommand)
    .command("report", reportCommand)
    .command("serve", serveCommand)
    .command("open", openCommand);

  // Register help command last — needs reference to the fully-built CLI tree
  cli.command("help", createHelpCommand(cli));

  try {
    await withSpan("swamp.cli", {
      "swamp.command": commandInfo.command,
      "swamp.subcommand": commandInfo.subcommand ?? "",
      "swamp.version": VERSION,
      "swamp.args": commandInfo.args.join(" "),
      "swamp.option_keys": commandInfo.optionKeys.join(" "),
      "swamp.global_options": commandInfo.globalOptions.join(" "),
    }, async () => {
      await cli.parse(args);
    });

    // Flush datastore sync (push to S3 + release lock)
    await flushDatastoreSync();

    // Record successful invocation
    if (telemetryCtx) {
      await telemetryCtx.service.recordSuccess(commandInfo, startTime);

      // Flush telemetry to remote endpoint with a 2-second cancellation
      // timeout. If the endpoint is slow or unreachable, data stays local
      // and will be flushed on the next invocation.
      const sender = new HttpTelemetrySender(telemetryCtx.telemetryEndpoint);
      await telemetryCtx.service.flushTelemetry({
        sender,
        distinctId: telemetryCtx.userId ?? telemetryCtx.repoId,
        repoId: telemetryCtx.repoId,
        authToken: telemetryCtx.authToken ?? undefined,
        keepFlushed: telemetryCtx.keepFlushed,
        signal: AbortSignal.timeout(2000),
      });

      // Trigger cleanup asynchronously (fire-and-forget)
      telemetryCtx.service.cleanupOldTelemetry();
    }

    // Proactive update notification (after telemetry, before exit)
    if (!isUpdateCheckDisabledByEnv() && !isDevBuild(VERSION)) {
      const outputMode = getOutputModeFromArgs(args);
      const commandName = commandInfo.command;

      if (outputMode === "log" && commandName !== "update") {
        try {
          const cacheRepo = new UpdateCheckCacheFileRepository();
          const checker = new HttpUpdateChecker();
          const service = new UpdateNotificationService(
            VERSION,
            cacheRepo,
            checker,
          );

          const notification = await service.getNotification();
          if (notification) {
            renderUpdateNotification(notification);
          }

          const platform = Platform.detect();
          service.backgroundCheck(platform);
        } catch {
          // Silently ignore — never break the CLI for update checks
        }
      }
    }
  } catch (error) {
    // Release datastore lock even on failure (don't leave locks stuck).
    // flushDatastoreSync() can now throw (SyncTimeoutError propagates on
    // the push path — see swamp#1216), so we swallow errors here: the
    // original command error must take precedence, and telemetry
    // recording below must still run. Per-entry cleanup on
    // flushDatastoreSync failure is handled inside the coordinator.
    try {
      await flushDatastoreSync();
    } catch {
      // Best effort — don't shadow the original error.
    }

    // Record error invocation and flush before re-throwing
    if (telemetryCtx && error instanceof Error) {
      await telemetryCtx.service.recordError(commandInfo, startTime, error);

      const sender = new HttpTelemetrySender(telemetryCtx.telemetryEndpoint);
      await telemetryCtx.service.flushTelemetry({
        sender,
        distinctId: telemetryCtx.userId ?? telemetryCtx.repoId,
        repoId: telemetryCtx.repoId,
        authToken: telemetryCtx.authToken ?? undefined,
        keepFlushed: telemetryCtx.keepFlushed,
        signal: AbortSignal.timeout(2000),
      });
    }
    throw error;
  }
}
