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
import { setColorEnabled } from "@std/fmt/colors";
import { isAbsolute, join, resolve } from "@std/path";
import {
  globalTelemetryDir,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import { migrateHomeRepoTelemetry } from "../infrastructure/persistence/telemetry_spool_migration.ts";
import { UserError } from "../domain/errors.ts";
import { enumeratePulledExtensionDirs } from "../libswamp/mod.ts";
import { getLogger, parseLogLevel } from "@logtape/logtape";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { VERSION, versionCommand } from "./commands/version.ts";
import { modelCommand } from "./commands/model_create.ts";
import { runCommand } from "./commands/run.ts";
import { repoCommand, repoInitCommand } from "./commands/repo_init.ts";
import { workflowCommand } from "./commands/workflow.ts";
import { completionCommand } from "./commands/completion.ts";
import { vaultCommand } from "./commands/vault.ts";
import { dataCommand } from "./commands/data.ts";
import { issueCommand } from "./commands/issue.ts";
import { telemetryCommand } from "./commands/telemetry_stats.ts";
import { auditCommand } from "./commands/audit.ts";
import { updateCommand } from "./commands/update.ts";
import { configCommand } from "./commands/config.ts";
import { sourceCommand } from "./commands/source.ts";
import { accessCommand } from "./commands/access.ts";
import { authCommand } from "./commands/auth.ts";
import { extensionCommand } from "./commands/extension.ts";
import { summariseCommand } from "./commands/summarise.ts";
import { datastoreCommand } from "./commands/datastore.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { reportCommand } from "./commands/report.ts";
import { serveCommand } from "./commands/serve.ts";
import { agentCommand } from "./commands/agent_setup.ts";
import { workerCommand } from "./commands/worker.ts";
import { questCommand } from "./commands/quest.ts";
import { createHelpCommand } from "./commands/help.ts";
import { unknownCommandErrorHandler } from "./unknown_command_handler.ts";
import { groupCommandAction } from "./group_action.ts";
import {
  getExtensionsDirFromArgs,
  getRepoDirFromArgs,
  type GlobalOptions,
  isStdinTty,
} from "./context.ts";
import {
  ModelNameType,
  ModelTypeType,
  WorkflowNameType,
} from "./completion_types.ts";
import { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import { readLocalManifestIdentity } from "../infrastructure/persistence/local_manifest_reader.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import { ExtensionLoader } from "../domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../domain/extensions/report_kind_adapter.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { setConsoleGuardJsonMode } from "../domain/models/console_guard.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";

// Import datastore types barrel to trigger built-in datastore registration
import "../domain/datastore/datastore_types.ts";
// Import builtin reports to trigger registration
import "../domain/reports/builtin/mod.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import { homeDirectoryIsSet } from "../infrastructure/persistence/paths.ts";
import { ReconcileFromDiskService } from "../libswamp/mod.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import {
  detectLocalBundledSkills,
  detectSupersededSkills,
} from "../domain/repo/repo_service.ts";
import { resolvePrimaryTool } from "../domain/repo/primary_tool.ts";
import { SKILL_DIRS } from "../domain/repo/skill_dirs.ts";
import { ExtensionAutoResolver } from "../domain/extensions/extension_auto_resolver.ts";
import { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../infrastructure/http/client_identity.ts";
import { loadIdentity, USER_AGENT } from "./load_identity.ts";
import {
  isAuthenticated,
  setAuthenticated,
  setAuthScopes,
  setCollectiveToken,
} from "./auth_context.ts";
import {
  apiKeyFingerprint,
  DEFAULT_SWAMP_CLUB_URL,
} from "../domain/auth/auth_credentials.ts";
import { setAutoResolver } from "./auto_resolver_context.ts";
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
} from "./auto_resolver_adapters.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import { JsonTelemetryRepository } from "../infrastructure/persistence/json_telemetry_repository.ts";
import { HttpTelemetrySender } from "../infrastructure/telemetry/http_telemetry_sender.ts";
import {
  buildInvocationContext,
  clearActiveTelemetryService,
  extractCommandInfo,
  isExternalDatastoreConfigured,
  isTelemetryDisabled,
  projectEnvSnapshot,
  setActiveTelemetryService,
} from "./telemetry_integration.ts";
import type { CommandInvocationData } from "../domain/telemetry/command_invocation.ts";
import { UserIdentityRepository } from "../infrastructure/persistence/user_identity_repository.ts";
import { TelemetryPreferencesFileRepository } from "../infrastructure/persistence/telemetry_preferences_file_repository.ts";
import { AuthRepository } from "../infrastructure/persistence/auth_repository.ts";
import {
  getCollectives,
  SwampClubClient,
} from "../infrastructure/http/swamp_club_client.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import { resolveDatastoreConfig } from "./resolve_datastore.ts";
import { isDevBuild } from "../domain/update/update_service.ts";
import { UpdateNotificationService } from "../domain/update/update_notification_service.ts";
import { UpdateCheckCacheFileRepository } from "../infrastructure/update/update_check_cache_file_repository.ts";
import { HttpUpdateChecker } from "../infrastructure/update/http_update_checker.ts";
import { Platform } from "../domain/update/platform.ts";
import { renderUpdateNotification } from "../presentation/renderers/update_notification.ts";
import {
  renderAuthNudge,
  renderFirstRunNudge,
} from "../presentation/renderers/auth_nudge.ts";
import {
  isFirstRunNudge,
  shouldShowAuthNudge,
} from "../domain/auth/auth_nudge.ts";
import { AuthNudgeRepository } from "../infrastructure/persistence/auth_nudge_repository.ts";
import { UpdatePreferencesFileRepository } from "../infrastructure/update/update_preferences_file_repository.ts";
import { AutoupdateLogFileRepository } from "../infrastructure/update/autoupdate_log_file_repository.ts";
import {
  autoupdateLogPath,
  detectInstalledLaunchdMode,
} from "../infrastructure/update/launchd_scheduler.ts";
import { detectInstalledLinuxMode } from "../infrastructure/update/scheduler_factory.ts";
import { cronLogPath } from "../infrastructure/update/cron_scheduler.ts";
import { getOutputModeFromArgs, isQuietFromArgs } from "./context.ts";
import { flushDatastoreSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import { getTracer, withSpan } from "../infrastructure/tracing/mod.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";
import { resolveGitMainWorktreeRoot } from "../infrastructure/persistence/git_worktree.ts";
import type {
  ExtensionKind,
  ResolvedSourceDirs,
} from "../domain/repo/swamp_sources.ts";
import { discoverManifestCrossKindDirs } from "../domain/extensions/manifest_cross_kind_discovery.ts";

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
  "config",
  "auth",
  "telemetry",
  "issue",
  "quest",
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
  quiet = false,
  extensionsDir?: string,
): Promise<void> {
  const effectiveExtDir = extensionsDir ?? repoDir;

  // Every extension — including already-pulled repo bundles — is loaded
  // through an embedded runtime that lives under the user's home directory
  // (~/.swamp). When neither HOME nor USERPROFILE is set (common for
  // service managers like systemd that start swamp serve without HOME), that
  // resolution throws deep inside each loader and surfaces as five
  // misleading "Failed to load user X extensions" warnings, followed by
  // "Unknown model type" at run time. Detect the condition once, up front,
  // and emit a single actionable warning instead.
  if (!homeDirectoryIsSet()) {
    deferredWarnings.push({
      kind: "extensions",
      file: "",
      error:
        "Extension loading is unavailable: no swamp data directory found " +
        "(none of SWAMP_HOME, HOME, or USERPROFILE is set). swamp loads all " +
        "extensions — including already-pulled repo extensions — through an " +
        "embedded runtime under the swamp data directory. If you run swamp " +
        "under a service manager such as systemd, set SWAMP_HOME to an " +
        "isolated directory, e.g. `Environment=SWAMP_HOME=/opt/swamp`, or " +
        "set HOME. Until then, pulled and user extensions are unavailable " +
        'and workflows that reference them fail with "Unknown model type".',
    });
  }

  const denoRuntime = new EmbeddedDenoRuntime();
  const sourceModelsDirs = collectDirsForKind(resolvedSources, "models");
  const sourceVaultsDirs = collectDirsForKind(resolvedSources, "vaults");
  const sourceDatastoresDirs = collectDirsForKind(
    resolvedSources,
    "datastores",
  );
  const sourceReportsDirs = collectDirsForKind(resolvedSources, "reports");

  const resolveAbsoluteKindDir = (
    resolveDir: (m: RepoMarkerData | null) => string,
  ): string => {
    const dir = resolveDir(marker);
    return isAbsolute(dir) ? dir : resolve(effectiveExtDir, dir);
  };

  const kindDirs = new Map<ExtensionKind, string[]>([
    ["models", [resolveAbsoluteKindDir(resolveModelsDir), ...sourceModelsDirs]],
    ["vaults", [resolveAbsoluteKindDir(resolveVaultsDir), ...sourceVaultsDirs]],
    [
      "datastores",
      [resolveAbsoluteKindDir(resolveDatastoresDir), ...sourceDatastoresDirs],
    ],
    [
      "reports",
      [resolveAbsoluteKindDir(resolveReportsDir), ...sourceReportsDirs],
    ],
  ]);
  const manifestCrossKindDirs = await discoverManifestCrossKindDirs(kindDirs);

  const mergeManifestDirs = (
    sourceDirs: string[],
    kind: ExtensionKind,
  ): string[] => {
    const extra = manifestCrossKindDirs.get(kind);
    return extra ? [...sourceDirs, ...extra] : sourceDirs;
  };

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

  // W1b: wrap the catalog in an ExtensionRepository so all 5 loaders see
  // it as their long-lived constructor-injected dependency (per ADV-V2-1
  // option (a-2)). The lockfile snapshot is frozen at construction (see
  // ExtensionRepository class JSDoc); the load* functions use a lazy
  // getter so the lockfile is read on first need rather than at every
  // configureExtensionLoaders call.
  const repoModelsDir = resolveModelsDir(marker);
  const lockfilePath = join(
    isAbsolute(repoModelsDir) ? repoModelsDir : resolve(repoDir, repoModelsDir),
    "upstream_extensions.json",
  );
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  const localManifestIdentity = readLocalManifestIdentity(repoDir);
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository,
    repoRoot: repoDir,
    localManifestIdentity,
  });

  if (
    repository.anyKindNeedsInvalidation() ||
    repository.manifestIdentityChanged(localManifestIdentity)
  ) {
    const reconciler = new ReconcileFromDiskService({
      denoRuntime,
      repository,
      lockfileRepository,
      repoDir,
      localManifestIdentity,
    });
    await reconciler.execute();
  }

  modelRegistry.setLoader(() =>
    loadUserModels(
      repoDir,
      marker,
      denoRuntime,
      mergeManifestDirs(sourceModelsDirs, "models"),
      lazyResolver,
      repository,
      quiet,
      effectiveExtDir,
    )
  );
  vaultTypeRegistry.setLoader(() =>
    loadUserVaults(
      repoDir,
      marker,
      denoRuntime,
      mergeManifestDirs(sourceVaultsDirs, "vaults"),
      lazyResolver,
      repository,
      quiet,
      effectiveExtDir,
    )
  );
  datastoreTypeRegistry.setLoader(() =>
    loadUserDatastores(
      repoDir,
      marker,
      denoRuntime,
      mergeManifestDirs(sourceDatastoresDirs, "datastores"),
      repository,
      quiet,
      effectiveExtDir,
    )
  );
  reportRegistry.setLoader(() =>
    loadUserReports(
      repoDir,
      marker,
      denoRuntime,
      mergeManifestDirs(sourceReportsDirs, "reports"),
      lazyResolver,
      repository,
      quiet,
      effectiveExtDir,
    )
  );

  await checkForMissingPulledExtensions(repoDir, marker, deferredWarnings);
  await checkForSupersededSkills(repoDir, marker, deferredWarnings);
  await checkForLocalBundledSkills(repoDir, marker, deferredWarnings);
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
  identity: ClientIdentity = {},
): void {
  const trustedCollectives = resolveTrustedCollectives(marker, authCollectives);
  if (trustedCollectives.length === 0 || !marker) {
    setAutoResolver(null);
    return;
  }
  const serverUrl = Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
  const extensionClient = new ExtensionApiClient(serverUrl, identity);
  const apiKey = identity.bearerToken;
  const modelsDir = resolveModelsDir(marker);
  const denoRuntime = new EmbeddedDenoRuntime();
  setAutoResolver(
    new ExtensionAutoResolver({
      allowedCollectives: trustedCollectives,
      extensionLookup: {
        getExtension: (name) => extensionClient.getExtension(name, apiKey),
        searchExtensions: (params) =>
          extensionClient.searchExtensions(params, apiKey),
      },
      extensionInstaller: createAutoResolveInstallerAdapter({
        getExtension: (name) => extensionClient.getExtension(name, apiKey),
        downloadArchive: (name, version, channel) =>
          extensionClient.downloadArchive(name, version, apiKey, channel),
        getChecksum: (name, version, channel) =>
          extensionClient.getChecksum(name, version, apiKey, channel),
        lockfilePath: join(
          resolve(repoDir, modelsDir),
          "upstream_extensions.json",
        ),
        repoDir,
        denoRuntime,
        // W1b/(a-2): wrap the auto-resolver-context catalog in its own
        // ExtensionRepository so the loaders constructed inside
        // hotLoadModels/hotLoadVaults/hotLoadDatastores can route their
        // catalog operations through the repository. The
        // lockfile snapshot is taken here at adapter-creation time;
        // long-lived repository instances do not refresh.
        repository: new ExtensionRepository({
          catalog: new ExtensionCatalogStore(
            swampPath(repoDir, "_extension_catalog.db"),
          ),
          lockfileRepository: new LockfileRepository(
            join(resolve(repoDir, modelsDir), "upstream_extensions.json"),
            {},
          ),
          repoRoot: repoDir,
        }),
      }),
      output: createAutoResolveOutputAdapter(outputMode),
    }),
  );
}

export function commandNeedsLoaderSetup(args: string[]): boolean {
  const commandInfo = extractCommandInfo(args);
  if (NON_REPO_COMMANDS.has(commandInfo.command)) return false;
  if (commandInfo.command === "audit" && commandInfo.subcommand === "record") {
    return false;
  }
  return true;
}

/**
 * Checks whether the command is `audit record` (the PostToolUse hook).
 * Hook commands need the fastest possible startup and must never exit
 * non-zero from infrastructure code — they skip telemetry, update
 * checks, and all post-parse teardown.
 *
 * @internal Exported for testing
 */
export function isHookCommand(
  commandInfo: CommandInvocationData,
): boolean {
  return commandInfo.command === "audit" &&
    commandInfo.subcommand === "record";
}

/** A deferred warning message to emit after logging is initialized. */
export interface DeferredWarning {
  kind:
    | "model"
    | "vault"
    | "datastore"
    | "report"
    | "extensions"
    | "skills"
    | "skill-migration";
  file: string;
  error: string;
}

/**
 * Detects the "neither HOME nor USERPROFILE is set" failure raised by the
 * home-directory path helpers. Used to suppress the misleading per-kind
 * loader warnings in favour of the single actionable warning emitted by
 * {@link configureExtensionLoaders}.
 */
function isMissingHomeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("home directory");
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
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const modelsDir = resolveModelsDir(marker);
    // Handle both absolute and relative paths (cross-platform)
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(extBase, modelsDir);

    // W1b/(a-2): if no repository was passed, bootstrap one with an
    // empty lockfile lookup. The catalog stays open for the process
    // lifetime so the ExtensionLoader can query it via getCatalogStore()
    // when loadSingleType() is called later.
    const effectiveRepository = repository ?? new ExtensionRepository({
      catalog: new ExtensionCatalogStore(
        swampPath(repoDir, "_extension_catalog.db"),
      ),
      lockfileRepository: new LockfileRepository(
        join(absoluteModelsDir, "upstream_extensions.json"),
        {},
      ),
      repoRoot: repoDir,
    });

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      modelKindAdapter,
      repoDir,
      resolver,
      effectiveRepository,
    );
    const lockfilePath = join(absoluteModelsDir, "upstream_extensions.json");
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "models",
    );

    // Set type loader on the registry for on-demand loading.
    // The lazy entry carries bundle/source paths from the catalog index,
    // avoiding a redundant SQLite read inside loadSingleType.
    modelRegistry.setTypeLoader(async (type, lazyEntry) => {
      await loader.loadSingleType(type, lazyEntry);
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
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    // configureExtensionLoaders already emitted one actionable warning for
    // the missing-home case; suppress the misleading per-kind duplicate.
    if (isMissingHomeError(error)) return;
    logger
      .warn`Failed to load user model extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
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
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const vaultsDir = resolveVaultsDir(marker);
    const absoluteVaultsDir = isAbsolute(vaultsDir)
      ? vaultsDir
      : resolve(extBase, vaultsDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      vaultKindAdapter,
      repoDir,
      resolver,
      repository,
    );
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

    if (repository) {
      vaultTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(absoluteVaultsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user vault ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteVaultsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user vault ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    logger
      .warn`Failed to load user vault extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function loadUserDatastores(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const datastoresDir = resolveDatastoresDir(marker);
    const absoluteDatastoresDir = isAbsolute(datastoresDir)
      ? datastoresDir
      : resolve(extBase, datastoresDir);

    const loader = new ExtensionLoader(
      denoRuntime,
      datastoreKindAdapter,
      repoDir,
      undefined,
      repository,
    );
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

    if (repository) {
      datastoreTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(
        absoluteDatastoresDir,
        {
          additionalDirs: [...sourceDirs, ...pulledDirs],
        },
      );

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user datastore ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteDatastoresDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user datastore ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    logger
      .warn`Failed to load user datastore extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function loadUserReports(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const reportsDir = resolveReportsDir(marker);
    const absoluteReportsDir = isAbsolute(reportsDir)
      ? reportsDir
      : resolve(extBase, reportsDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      reportKindAdapter,
      repoDir,
      resolver,
      repository,
    );
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

    if (repository) {
      reportRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(absoluteReportsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user report ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteReportsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user report ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    logger
      .warn`Failed to load user report extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
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

    const lockfileRepository = await LockfileRepository.create(lockfilePath);
    const upstream = lockfileRepository.getAllEntries();
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

async function checkForSupersededSkills(
  repoDir: string,
  marker: RepoMarkerData | null,
  deferredWarnings: DeferredWarning[],
): Promise<void> {
  try {
    const tools = marker?.tools?.length
      ? marker.tools
      : [resolvePrimaryTool(marker)];
    const allStale = new Set<string>();
    for (const tool of tools) {
      const dir = SKILL_DIRS[tool];
      if (!dir) continue;
      const stale = await detectSupersededSkills(join(repoDir, dir));
      for (const name of stale) allStale.add(name);
    }
    if (allStale.size > 0) {
      const names = [...allStale].sort();
      deferredWarnings.push({
        kind: "skills",
        file: repoDir,
        error:
          `${names.length} old swamp-managed skill(s) can be safely deleted: ${
            names.join(", ")
          }. These have been replaced by the bundled swamp skill. Run 'swamp repo upgrade' to remove them.`,
      });
    }
  } catch {
    // Non-fatal — don't block startup for skill dir read errors
  }
}

const SKILL_MIGRATION_WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function checkForLocalBundledSkills(
  repoDir: string,
  marker: RepoMarkerData | null,
  deferredWarnings: DeferredWarning[],
): Promise<void> {
  try {
    if (!marker?.tools?.length) return;
    if (marker.skillMigrationDismissed) return;

    if (marker.lastSkillMigrationWarning) {
      const lastWarning = new Date(marker.lastSkillMigrationWarning).getTime();
      if (Date.now() - lastWarning < SKILL_MIGRATION_WARNING_INTERVAL_MS) {
        return;
      }
    }

    const localCopies = await detectLocalBundledSkills(
      repoDir,
      marker.tools,
    );
    if (localCopies.length === 0) return;

    const allNames = localCopies.flatMap((c) => c.names);
    const dirs = localCopies.map((c) =>
      c.names.map((n) => `  ${join(c.skillsDir, n)}/`)
    ).flat();

    deferredWarnings.push({
      kind: "skill-migration",
      file: repoDir,
      error:
        `Local copies of ${allNames.join(", ")} are shadowing the globally ` +
        "installed skills. Delete them manually:\n\n" +
        dirs.join("\n"),
    });

    const repoPath = RepoPath.create(repoDir);
    const markerRepo = new RepoMarkerRepository();
    const updatedMarker = {
      ...marker,
      lastSkillMigrationWarning: new Date().toISOString(),
    };
    await markerRepo.write(repoPath, updatedMarker);
  } catch {
    // Non-fatal — don't block startup
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
 * Priority: SWAMP_TELEMETRY_ENDPOINT env > .swamp.yaml telemetryEndpoint >
 * localhost auto-detect from auth serverUrl > default
 *
 * The env override is an operator escape hatch that applies to every repo in the
 * process regardless of marker. It exists for hosts whose auth serverUrl is a
 * non-localhost name the auto-detect can't recognize — e.g. a container on a
 * compose network reaching the server as `app:5173` — so all invocations route
 * to a local telemetry service without pinning each repo's `.swamp.yaml`.
 *
 * @internal Exported for testing
 */
export function resolveTelemetryEndpoint(
  markerEndpoint: string | undefined,
  authServerUrl: string | null,
  envEndpoint?: string | undefined,
): string {
  if (envEndpoint) return envEndpoint;
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
  /**
   * Repo-specific identifier, present only when the run happened inside a
   * swamp repo. Undefined for repo-less runs — the event is then keyed solely
   * by the user identity (userId).
   */
  repoId: string | undefined;
  telemetryEndpoint: string;
  keepFlushed: boolean;
  authToken: string | null;
}

/**
 * Initialize the telemetry service for this invocation.
 *
 * Telemetry is global: every run spools to the single user-level directory
 * ({@link globalTelemetryDir}) whether or not it happened inside a swamp repo.
 * A repo marker, when present, only *enriches* the event (repoId, configured
 * tools, datastore, endpoint, keepFlushed) and can opt the repo out; it no
 * longer gates telemetry or selects the spool. Repo-less runs honor a
 * persistent user-level opt-out at `<config>/telemetry.yaml`.
 *
 * Returns null only when telemetry is disabled for this run.
 */
async function initTelemetryService(
  repoDir: string,
): Promise<TelemetryContext | null> {
  try {
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    const marker = await markerRepo.read(repoPath);

    // Enrichment fields default to the repo-less state; a marker decorates the
    // event with repo-specific detail when the run happened inside a repo.
    let repoId: string | undefined;
    let configuredAiTools: string[] | undefined;
    let externalDatastore = false;
    let markerEndpoint: string | undefined;
    let keepFlushed = false;

    if (marker) {
      if (isTelemetryDisabledByConfig(marker)) {
        return null; // Per-repo opt-out via marker telemetryDisabled
      }

      // Lazy-migrate repoId if missing
      repoId = marker.repoId;
      if (!repoId) {
        repoId = crypto.randomUUID();
        marker.repoId = repoId;
        await markerRepo.write(repoPath, marker);
      }
      configuredAiTools = marker.tools;
      externalDatastore = isExternalDatastoreConfigured(marker.datastore);
      markerEndpoint = marker.telemetryEndpoint;
      keepFlushed = marker.telemetryKeepFlushed ?? false;
    } else {
      // Repo-less: honor the persistent user-level opt-out.
      const prefs = await new TelemetryPreferencesFileRepository().read();
      if (prefs.disabled) {
        return null;
      }
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

    // Drain any telemetry stranded in a home-as-repo legacy spool
    // (~/.swamp/telemetry) so it flushes with this run (swamp-club#1214).
    // Best-effort on top of the never-throw contract: migration must not
    // trip the outer catch and disable telemetry for the run.
    try {
      await migrateHomeRepoTelemetry();
    } catch {
      // Never let migration affect telemetry for this invocation.
    }

    // Single, user-level spool — never repo-local.
    const repository = new JsonTelemetryRepository(
      repoDir,
      globalTelemetryDir(),
    );
    const invocationContext = buildInvocationContext(
      projectEnvSnapshot(),
      configuredAiTools,
      externalDatastore,
    );
    const service = new TelemetryService(
      repository,
      VERSION,
      invocationContext,
    );
    const telemetryEndpoint = resolveTelemetryEndpoint(
      markerEndpoint,
      authServerUrl,
      Deno.env.get("SWAMP_TELEMETRY_ENDPOINT"),
    );

    return {
      service,
      userId,
      repoId,
      telemetryEndpoint,
      keepFlushed,
      authToken,
    };
  } catch {
    // Best-effort — any failure disables telemetry for this run.
    return null;
  }
}

export async function runCli(args: string[]): Promise<void> {
  // Rewrite `model @type method run` → `model method run @type` before
  // Cliffy parses the command tree. Must happen before any arg inspection.
  const { rewriteDirectTypeArgs } = await import("./arg_rewriter.ts");
  args = rewriteDirectTypeArgs(args);

  // Capture start time for telemetry
  const startTime = new Date();

  // Pre-parse --repo-dir so startup functions use the correct repository
  const repoDir = getRepoDirFromArgs(args);

  // Pre-parse --extensions-dir for split code-plane/data-plane scenarios
  const extensionsDir = getExtensionsDirFromArgs(args);

  if (extensionsDir !== undefined) {
    const swampDataDir = join(repoDir, ".swamp");
    if (
      extensionsDir === swampDataDir ||
      extensionsDir.startsWith(swampDataDir + "/") ||
      extensionsDir.startsWith(swampDataDir + "\\")
    ) {
      throw new UserError(
        "--extensions-dir must not point inside the .swamp data directory",
      );
    }
    try {
      const stat = await Deno.stat(extensionsDir);
      if (!stat.isDirectory) {
        throw new UserError(
          `--extensions-dir must be a directory: ${extensionsDir}`,
        );
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new UserError(
          `--extensions-dir directory not found: ${extensionsDir}`,
        );
      }
      throw error;
    }
  }

  // Pre-parse check for telemetry disable flag
  const telemetryDisabled = isTelemetryDisabled(args) ||
    isTelemetryDisabledByEnv();

  // Extract command info for telemetry (before parsing)
  const commandInfo = extractCommandInfo(args);

  // Hook commands (audit record --from-hook) run as PostToolUse hooks and
  // must be as fast as possible. Skip all non-essential startup and teardown
  // to avoid infrastructure errors causing non-zero exit.
  const hookMode = isHookCommand(commandInfo);

  const bootstrapSpan = getTracer().startSpan("swamp.cli.bootstrap");

  // Initialize telemetry service (only if in a swamp repo)
  let telemetryCtx: TelemetryContext | null = null;
  if (!telemetryDisabled && !hookMode) {
    telemetryCtx = await initTelemetryService(repoDir);
  }

  // Surface the active service for command actions that emit child
  // telemetry (e.g. workflow_run wiring into libswamp). Cleared in the
  // outer try/finally below regardless of how the invocation ends.
  if (telemetryCtx) {
    setActiveTelemetryService(telemetryCtx.service);
  }

  // Read marker once for log level, extension loading, and auto-resolver.
  // Hook commands skip this — null marker gives default "info" log level.
  let marker: RepoMarkerData | null = null;
  if (!hookMode) {
    try {
      const markerRepo = new RepoMarkerRepository();
      const repoPath = RepoPath.create(repoDir);
      marker = await markerRepo.read(repoPath);
    } catch {
      // Not in a swamp repo - marker stays null
    }
  }

  // Read extension sources (additional extension directories from
  // .swamp-sources.yaml). Resolved once and shared across all loaders.
  // Relative paths resolve against the git main working tree root so
  // worktrees see the same sibling sources as the main checkout.
  let resolvedSources: ResolvedSourceDirs[] = [];
  if (!hookMode) {
    const sourcesConfig = await readSwampSources(repoDir);
    if (sourcesConfig) {
      const sourceBaseDir = await resolveGitMainWorktreeRoot(repoDir);
      const expanded = await expandSourcePaths(
        sourcesConfig,
        repoDir,
        sourceBaseDir,
      );
      const { resolved } = await resolveSourceExtensionDirs(
        expanded,
      );
      resolvedSources = resolved;
    }
  }

  // Configure lazy extension loaders on each registry.
  // Extensions are NOT loaded here — they load on first access when a
  // command calls registry.ensureLoaded() via its dep factory.
  // Warnings are logged directly by the loaders (logging is initialized
  // by the time ensureLoaded() runs inside command .action() handlers).
  const deferredWarnings: DeferredWarning[] = [];
  if (commandNeedsLoaderSetup(args) && marker !== null) {
    const loaderSpan = getTracer().startSpan(
      "swamp.cli.configure_extension_loaders",
    );
    await configureExtensionLoaders(
      repoDir,
      marker,
      resolvedSources,
      deferredWarnings,
      isQuietFromArgs(args),
      extensionsDir,
    );
    loaderSpan.end();
  }

  // Resolve identity and scopes for SWAMP_API_KEY users. Calls whoami only
  // when the cache is stale (first use, key rotation, or missing scopes for
  // a collective token). Scopes are set directly from the response to avoid
  // cache round-trip issues with --unstable-bundle module duplication.
  // Must run before the authCollectives read so the first invocation gets
  // cached collectives for extension trust.
  if (!hookMode && Deno.env.get("SWAMP_API_KEY")) {
    try {
      const authRepo = new AuthRepository();
      const creds = await authRepo.load();
      if (creds) {
        if (creds.apiKey) setCollectiveToken(creds.apiKey);
        const isCollective = creds.apiKey.startsWith("swamp_org_");
        const fingerprint = apiKeyFingerprint(creds.apiKey);
        if (isCollective) {
          const cachedScopes = await authRepo.loadScopeCache(fingerprint);
          if (cachedScopes) {
            setAuthScopes(cachedScopes);
          } else {
            const identity = await loadIdentity();
            const client = new SwampClubClient(creds.serverUrl, identity);
            const signal = AbortSignal.timeout(10_000);
            const response = await client.whoami(creds.apiKey, signal);
            if (response.authenticated) {
              setAuthScopes(response.scopes);
              if (response.scopes) {
                await authRepo.saveScopeCache(fingerprint, response.scopes);
              }
            }
          }
        } else if (!creds.username) {
          const identity = await loadIdentity();
          const client = new SwampClubClient(creds.serverUrl, identity);
          const signal = AbortSignal.timeout(10_000);
          const response = await client.whoami(creds.apiKey, signal);
          if (response.authenticated && response.username) {
            const collectives = getCollectives(response) ?? [];
            await authRepo.saveIdentityCache(
              creds.serverUrl,
              response.username,
              collectives,
              fingerprint,
              response.scopes,
            );
          }
        }
      }
    } catch {
      // Best-effort — don't block CLI startup
    }
  }

  // Load cached auth collectives and scopes for membership-based trust
  let authCollectives: string[] | undefined;
  if (!hookMode) {
    try {
      const authRepo = new AuthRepository();
      const creds = await authRepo.load();
      authCollectives = creds?.collectives;
      if (!Deno.env.get("SWAMP_API_KEY")) {
        if (creds?.apiKey) setCollectiveToken(creds.apiKey);
        setAuthScopes(creds?.scopes);
      }
    } catch {
      // Auth file unreadable — continue without membership collectives
    }
  }

  // Create auto-resolver for trusted collectives (merging membership collectives)
  if (!hookMode) {
    const autoResolverIdentity = await loadIdentity();
    setAuthenticated(autoResolverIdentity.bearerToken !== undefined);
    configureExtensionAutoResolver(
      repoDir,
      marker,
      authCollectives,
      getOutputModeFromArgs(args),
      autoResolverIdentity,
    );
  }

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
      setConsoleGuardJsonMode(options.json ?? false);

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
        if (
          warning.kind === "extensions" || warning.kind === "skills" ||
          warning.kind === "skill-migration"
        ) {
          logger.warn`${warning.error}`;
        } else {
          logger
            .warn`Failed to load user ${warning.kind} ${warning.file}: ${warning.error}`;
        }
      }
    })
    .error(unknownCommandErrorHandler)
    .action(groupCommandAction)
    .command("access", accessCommand)
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
    .command("config", configCommand)
    .command("source", sourceCommand)
    .command("completions", completionCommand)
    .command("issue", issueCommand)
    .command("auth", authCommand)
    .command("extension", extensionCommand)
    .command("summarise", summariseCommand)
    .command("datastore", datastoreCommand)
    .command("doctor", doctorCommand)
    .command("run", runCommand)
    .command("report", reportCommand)
    .command("serve", serveCommand)
    .command("agent", agentCommand)
    .command("worker", workerCommand)
    .command("quest", questCommand);

  // Register help command last — needs reference to the fully-built CLI tree
  cli.command("help", createHelpCommand(cli));

  bootstrapSpan.end();

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

    // Hook commands exit immediately — no teardown needed. The action's
    // own try/catch handles all errors; skipping teardown prevents
    // infrastructure failures (telemetry flush, update checks) from
    // causing a non-zero exit that disrupts the user's coding session.
    if (hookMode) return;

    // Flush datastore sync (push to S3 + release lock)
    const teardownSpan = getTracer().startSpan("swamp.cli.teardown");
    try {
      await flushDatastoreSync();

      // Record successful invocation
      if (telemetryCtx) {
        try {
          await telemetryCtx.service.recordSuccess(commandInfo, startTime);

          // distinct_id is required by the sender. For repo-less runs it is
          // the global userId; if neither userId nor repoId resolved, skip the
          // flush and leave the entry spooled for a future run.
          const distinctId = telemetryCtx.userId ?? telemetryCtx.repoId;
          if (distinctId) {
            const sender = new HttpTelemetrySender(
              telemetryCtx.telemetryEndpoint,
              USER_AGENT,
            );
            const flushed = await telemetryCtx.service.flushTelemetry({
              sender,
              distinctId,
              repoId: telemetryCtx.repoId,
              authToken: telemetryCtx.authToken ?? undefined,
              keepFlushed: telemetryCtx.keepFlushed,
              signal: AbortSignal.timeout(2000),
            });
            if (!flushed) {
              logger
                .warn`Telemetry flush failed — entries are queued locally and will retry on the next invocation`;
            }
          }

          // Trigger cleanup asynchronously (fire-and-forget)
          telemetryCtx.service.cleanupOldTelemetry();
        } catch {
          // Best effort — never break the CLI for telemetry failures
        }
      }

      // Proactive update notification (after telemetry, before exit)
      if (!isUpdateCheckDisabledByEnv() && !isDevBuild(VERSION)) {
        const outputMode = getOutputModeFromArgs(args);
        const commandName = commandInfo.command;

        if (outputMode === "log" && commandName !== "update") {
          try {
            const prefsRepo = new UpdatePreferencesFileRepository();
            const prefs = await prefsRepo.read();

            if (prefs.enabled) {
              let logPath: string | undefined;
              if (Deno.build.os === "darwin") {
                const installedMode = await detectInstalledLaunchdMode();
                if (installedMode === "daemon") {
                  logPath = autoupdateLogPath("daemon");
                }
              } else if (Deno.build.os === "linux") {
                const installedMode = await detectInstalledLinuxMode();
                if (installedMode === "daemon") {
                  logPath = cronLogPath("daemon");
                }
              }
              const logRepo = new AutoupdateLogFileRepository(logPath);
              const entries = await logRepo.readAll();
              let prefsChanged = false;
              const updatedPrefs = { ...prefs };

              // Show post-autoupdate notice once after background upgrade
              if (prefs.notifiedVersion !== VERSION) {
                const lastUpdate = entries.findLast((e) =>
                  e.outcome === "updated" && e.versionAfter
                );
                if (lastUpdate && lastUpdate.versionAfter === VERSION) {
                  console.error(
                    `\nℹ swamp was auto-updated from ${lastUpdate.versionBefore} → ${lastUpdate.versionAfter}`,
                  );
                }
                updatedPrefs.notifiedVersion = VERSION;
                prefsChanged = true;
              }

              // Warn if background autoupdate is failing due to permissions
              // (throttled to at most once per 24h to avoid alarm fatigue)
              const lastEntry = entries.length > 0
                ? entries[entries.length - 1]
                : null;
              if (
                lastEntry?.outcome === "error" && lastEntry.error &&
                lastEntry.error.toLowerCase().includes("permission denied")
              ) {
                const lastWarned = updatedPrefs.lastPermissionWarning;
                const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
                if (!lastWarned || new Date(lastWarned).getTime() < oneDayAgo) {
                  const binaryPath = Deno.execPath();
                  console.error(
                    `\n⚠ Background autoupdate is failing: ${binaryPath} is not writable by your user.` +
                      `\n  Run \`sudo swamp update\` to update manually, or \`sudo chown $(whoami) ${binaryPath}\` to fix.` +
                      `\n  Run \`swamp doctor install\` for a full installation health check.` +
                      `\n  Disable with: swamp update --setup-auto disable`,
                  );
                  updatedPrefs.lastPermissionWarning = new Date().toISOString();
                  prefsChanged = true;
                }
              }

              if (prefsChanged) {
                await prefsRepo.write(updatedPrefs);
              }
            }

            // Skip the "run swamp update" banner if autoupdate handles it
            if (!prefs.enabled) {
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
            }
          } catch {
            // Silently ignore — never break the CLI for update checks
          }
        }
      }

      // Auth nudge banner (throttled to once per day, suppressed once logged in).
      // Skip for commands whose renderers already include their own inline
      // nudge to avoid showing it twice, and for auth commands (which handle
      // authentication directly — showing "please log in" after a successful
      // login is confusing).
      //   - repo init/upgrade: src/presentation/renderers/repo_init.ts
      //   - model method run: src/presentation/renderers/model_method_run.ts
      //   - workflow run/resume: src/presentation/renderers/workflow_run.ts
      //   - access grant/group: via model_method_run renderer
      //   - auth *: authentication commands manage login state directly
      {
        const outputMode = getOutputModeFromArgs(args);
        const skipNudge = (commandInfo.command === "repo" &&
          (commandInfo.subcommand === "init" ||
            commandInfo.subcommand === "upgrade")) ||
          (commandInfo.command === "model" &&
            commandInfo.subcommand === "method") ||
          (commandInfo.command === "workflow" &&
            (commandInfo.subcommand === "run" ||
              commandInfo.subcommand === "resume")) ||
          commandInfo.command === "access" ||
          commandInfo.command === "auth";
        if (outputMode === "log" && !isAuthenticated() && !skipNudge) {
          try {
            const nudgeRepo = new AuthNudgeRepository();
            const nudgeState = await nudgeRepo.read();
            if (shouldShowAuthNudge(nudgeState)) {
              if (isFirstRunNudge(nudgeState)) {
                renderFirstRunNudge();
              } else {
                renderAuthNudge();
              }
              await nudgeRepo.markShown();
            }
          } catch {
            // Best effort — never break the CLI for nudge state
          }
        }
      }
    } finally {
      teardownSpan.end();
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

      // distinct_id is required by the sender (see success path). Skip the
      // flush if neither userId nor repoId resolved.
      const distinctId = telemetryCtx.userId ?? telemetryCtx.repoId;
      if (distinctId) {
        const sender = new HttpTelemetrySender(
          telemetryCtx.telemetryEndpoint,
          USER_AGENT,
        );
        await telemetryCtx.service.flushTelemetry({
          sender,
          distinctId,
          repoId: telemetryCtx.repoId,
          authToken: telemetryCtx.authToken ?? undefined,
          keepFlushed: telemetryCtx.keepFlushed,
          signal: AbortSignal.timeout(2000),
        });
      }
    }
    throw error;
  } finally {
    // Always clear the module-scoped service handle when the CLI
    // invocation finishes — runCli is the single setter and must be the
    // single clearer.
    clearActiveTelemetryService();
  }
}
