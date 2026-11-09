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

import { runRetentionAtCommandEnd } from "./retention_teardown.ts";
import { Command } from "@cliffy/command";
import { isAbsolute, join, resolve } from "@std/path";
import {
  globalTelemetryDir,
  isManagedConfigBaseResolved,
  managedConfigLockfilePath,
  resolveManagedConfigOnce,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import {
  type InstalledEntries,
  isAbsentFromDisk,
  pathsToRemoveForReinstall,
  readInstalledEntries,
  transitionalInstalledNames,
  transitionalLocalLockfilePath,
} from "../infrastructure/persistence/installed_entries.ts";
import {
  type DatastoreEnvReader,
  isExtensionBackedDatastore,
} from "../infrastructure/persistence/managed_config_lockfile.ts";
import { migrateHomeRepoTelemetry } from "../infrastructure/persistence/telemetry_spool_migration.ts";
import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import {
  markModelWording,
  wordedText,
  wordedUserError,
} from "../domain/behavior_wording.ts";
import {
  choosePulledDatastoreDirsOnDisk,
  enumeratePulledExtensionDirs,
} from "../libswamp/extensions/enumerate_pulled.ts";
import { getLogger, parseLogLevel } from "@logtape/logtape";
import {
  bufferStartupWarnings,
  initializeLogging,
} from "../infrastructure/logging/logger.ts";
import { VERSION, versionCommand } from "./commands/version.ts";
import { modelCommand } from "./commands/model_create.ts";
import { runCommand } from "./commands/run.ts";
import { repoCommand, repoInitCommand } from "./commands/repo_init.ts";
import { workflowCommand } from "./commands/workflow.ts";
import { completionCommand } from "./commands/completion.ts";
import { vaultCommand } from "./commands/vault.ts";
import { dataCommand } from "./commands/data.ts";
import { issueCommand } from "./commands/issue.ts";
import { inviteCommand } from "./commands/invite.ts";
import { firstRuleCommand } from "./commands/invite_link.ts";
import { telemetryCommand } from "./commands/telemetry_stats.ts";
import { auditCommand } from "./commands/audit.ts";
import { updateCommand } from "./commands/update.ts";
import { configCommand } from "./commands/config.ts";
import { sourceCommand } from "./commands/source.ts";
import { accessCommand } from "./commands/access.ts";
import { authCommand } from "./commands/auth.ts";
import { extensionCommand } from "./commands/extension.ts";
import { summariseCommand } from "./commands/summarise.ts";
import { behaviorCommand } from "./commands/behavior.ts";
import { datastoreCommand } from "./commands/datastore.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { reportCommand } from "./commands/report.ts";
import { serveCommand } from "./commands/serve.ts";
import { agentCommand } from "./commands/agent_setup.ts";
import { workerCommand } from "./commands/worker.ts";
import { questCommand } from "./commands/quest.ts";
import { subscriptionCommand } from "./commands/subscription.ts";
import { inboxCommand } from "./commands/inbox.ts";
import { startCommand } from "./commands/start.ts";
import { dashboardCommand } from "./commands/dashboard.ts";
import { workspaceCommand } from "./commands/workspace.ts";
import { createHelpCommand } from "./commands/help.ts";
import { unknownCommandErrorHandler } from "./unknown_command_handler.ts";
import { groupCommandAction } from "./group_action.ts";
import {
  applyColorPolicy,
  getClubApiKeyFileFromArgs,
  getExtensionsDirFromArgs,
  getRepoDirFromArgs,
  type GlobalOptions,
  hasExplicitRepoDir,
  isStdinTty,
  rebaseOntoRepoDir,
} from "./context.ts";
import { registerCompletionTypes } from "./completion_types.ts";
import { isTransientError } from "../infrastructure/persistence/io_errors.ts";
import {
  setImplicitServeRouting,
  setMarkerServerAddress,
  setRemoteIndicatorMode,
} from "./remote_run.ts";
import {
  serveUpstreamCommandPath,
  serveUpstreamRunsLocally,
  setServeUpstreamCommandPath,
} from "./serve_upstream.ts";
import { ExtensionCatalogStore } from "../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../infrastructure/persistence/extension_repository.ts";
import { readLocalManifestIdentity } from "../infrastructure/persistence/local_manifest_reader.ts";
import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";
import { ExtensionLoader } from "../domain/extensions/extension_loader.ts";
import { createLocalModelRefresher } from "../domain/extensions/local_model_refresh.ts";
import { modelKindAdapter } from "../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../domain/extensions/report_kind_adapter.ts";
import { webhookKindAdapter } from "../domain/extensions/webhook_kind_adapter.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { setConsoleGuardJsonMode } from "../domain/models/console_guard.ts";
import { datastoreTypeRegistry } from "../domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../domain/webhooks/webhook_type_registry.ts";
import {
  closeV3DatastoresAfterFailure,
  closeV3DatastoresAfterSuccess,
} from "./v3_teardown.ts";

import "../domain/datastore/datastore_types.ts";
import "../domain/reports/builtin/mod.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import { createDenoInfoModuleGraphReader } from "../infrastructure/runtime/deno_info_module_graph_reader.ts";
import { homeDirectoryIsSet } from "../infrastructure/persistence/paths.ts";
import { createDefaultExtensionArchiveCache } from "../infrastructure/persistence/extension_archive_cache.ts";
import { processOwnsConfigDir } from "../infrastructure/persistence/config_dir_ownership.ts";
import { renderAuthGateWarning } from "../presentation/renderers/auth_gate_warning.ts";
import { ReconcileFromDiskService } from "../libswamp/extensions/reconcile_from_disk_service.ts";
import { ProcessBundleProber } from "../infrastructure/runtime/process_bundle_prober.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { detectSupersededSkills } from "../domain/repo/repo_service.ts";
import { resolveSupersededSkillDirs } from "../domain/repo/superseded_skills.ts";
import { ExtensionAutoResolver } from "../domain/extensions/extension_auto_resolver.ts";
import { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../infrastructure/http/client_identity.ts";
import { loadIdentity } from "./load_identity.ts";
import {
  isCollectiveToken,
  setAuthenticated,
  setAuthScopes,
  setCollectiveToken,
  setScopeResolutionFailed,
} from "./auth_context.ts";
import {
  DEFAULT_SWAMP_CLUB_URL,
  keyFingerprint,
} from "../domain/auth/auth_credentials.ts";
import { setAutoResolver } from "./auto_resolver_context.ts";
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
  isBundleArtifactPath,
} from "./auto_resolver_adapters.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import { isTelemetryDisabledByEnv } from "../infrastructure/telemetry/telemetry_opt_out_env.ts";
import { JsonTelemetryFlushRecordRepository } from "../infrastructure/persistence/json_telemetry_flush_record_repository.ts";
import { JsonTelemetryRepository } from "../infrastructure/persistence/json_telemetry_repository.ts";
import { YamlVaultConfigRepository } from "../infrastructure/persistence/yaml_vault_config_repository.ts";
import { sendTelemetryAtCommandEnd } from "./telemetry_end_of_command.ts";
import {
  buildInvocationContext,
  clearActiveTelemetryContext,
  clearActiveTelemetryService,
  extractCommandInfo,
  isExternalDatastoreConfigured,
  isExternalVaultConfigured,
  isTelemetryDisabled,
  projectEnvSnapshot,
  setActiveTelemetryContext,
  setActiveTelemetryService,
  type TelemetryContext,
} from "./telemetry_integration.ts";
import type { CommandInvocationData } from "../domain/telemetry/command_invocation.ts";
import { UserIdentityRepository } from "../infrastructure/persistence/user_identity_repository.ts";
import { TelemetryPreferencesFileRepository } from "../infrastructure/persistence/telemetry_preferences_file_repository.ts";
import { AuthRepository } from "../infrastructure/persistence/auth_repository.ts";
import {
  hasApiKeySource,
  setApiKeyFileOverride,
} from "../infrastructure/persistence/api_key_source.ts";
import {
  getCollectives,
  SwampClubClient,
  type WhoamiResponse,
} from "../infrastructure/http/swamp_club_client.ts";
import type { DatastorePathResolver } from "../domain/datastore/datastore_path_resolver.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import { resolveDatastoreConfig } from "./resolve_datastore.ts";
import { resolveDatastoreExpressions } from "./datastore_expression_resolver.ts";
import { isDevBuild } from "../domain/update/update_service.ts";
import { withNoticeFields } from "../domain/update/update_preferences.ts";
import {
  createAutoupdateRefreshDeps,
  refreshAutoupdateSchedulerIfOwed,
} from "./autoupdate_refresh.ts";
import {
  lastCheckAgeDays,
  shouldWarnStaleAutoupdate,
} from "../domain/update/autoupdate_staleness.ts";
import { schedulerRepairCommand } from "../presentation/renderers/doctor_install.ts";
import { UpdateNotificationService } from "../domain/update/update_notification_service.ts";
import { UpdateCheckCacheFileRepository } from "../infrastructure/update/update_check_cache_file_repository.ts";
import { HttpUpdateChecker } from "../infrastructure/update/http_update_checker.ts";
import { Platform } from "../domain/update/platform.ts";
import { renderUpdateNotification } from "../presentation/renderers/update_notification.ts";
import {
  authGateBlockedError,
  type AuthGateOutcome,
  createAuthGateDeps,
  runAuthGate,
} from "./auth_gate.ts";
import {
  beginAuthGateSession,
  endAuthGateSession,
  publishNestedGatePass,
} from "./auth_gate_session.ts";
import { processLockHolderMarker } from "../domain/datastore/lock_holder_marker.ts";
import { authGateTiming } from "./auth_gate_exemptions.ts";
import {
  commandSucceeded,
  finishInboxNotice,
  inboxNoticeDisabledByEnv,
  inboxNoticeEligibility,
} from "./inbox_notice_gate.ts";
import {
  createInboxNoticeDeps,
  type InboxNoticeDeps,
  type InboxPoll,
  showInboxNotice,
  startInboxPoll,
} from "../libswamp/inbox/notice.ts";
import {
  accountNoticeEligibility,
  finishAccountNotice,
} from "./account_notice_gate.ts";
import {
  type AccountNoticeDeps,
  type AccountNoticePoll,
  createAccountNoticeDeps,
  showAccountNotice,
  startAccountNoticePoll,
} from "../libswamp/account_notices/notice.ts";
import { UpdatePreferencesFileRepository } from "../infrastructure/update/update_preferences_file_repository.ts";
import { AutoupdateLogFileRepository } from "../infrastructure/update/autoupdate_log_file_repository.ts";
import {
  autoupdateLogPath,
  detectInstalledLaunchdMode,
} from "../infrastructure/update/launchd_scheduler.ts";
import { detectInstalledLinuxMode } from "../infrastructure/update/scheduler_factory.ts";
import { cronLogPath } from "../infrastructure/update/cron_scheduler.ts";
import {
  getOutputModeFromArgs,
  isQuietFromArgs,
  postCommandNoticesAllowed,
} from "./context.ts";
import { isValueOnlyStdoutCommand } from "./stdout_contract.ts";
import {
  buildKnownSensitiveValues,
  resolveTelemetryInvocation,
  toRecordedInvocation,
} from "./telemetry_invocation.ts";
import { findEmptyOptionValue } from "./empty_option_value.ts";
import type { AnyCommand } from "./cli_schema.ts";
import { flushDatastoreSync } from "../infrastructure/persistence/datastore_sync_coordinator.ts";
import {
  getTracer,
  withActiveSpan,
  withSpan,
} from "../infrastructure/tracing/mod.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  flattenSourceKindDirs,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";
import { resolveSourceBaseDirs } from "../infrastructure/persistence/git_worktree.ts";
import type {
  ExtensionKind,
  ResolvedSourceDirs,
} from "../domain/repo/swamp_sources.ts";
import { discoverManifestCrossKindDirs } from "../domain/extensions/manifest_cross_kind_discovery.ts";

import "../domain/models/models.ts";

// Import and re-export — the canonical definitions live in
// separate files to avoid circular imports through mod.ts.
import {
  existingBehaviorsDir,
  resolveBehaviorsDir,
  resolveModelsDir,
} from "./resolve_models_dir.ts";
export { resolveModelsDir };
import { modelsDirEnvConflict } from "../infrastructure/persistence/resolve_models_dir.ts";
import {
  enableV3RecoveryProgress,
  ensureManagedConfigBase,
  markerSaysV3,
  resolveManagedConfigPaths,
  serveUpstreamConfigOptions,
  serveUpstreamOf,
  setLockProgressOutputMode,
  setLockProgressQuiet,
  setServeOfflineOutputMode,
} from "./repo_context.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";
export { resolveWorkflowsDir };
import { resolveVaultsDir } from "./resolve_vaults_dir.ts";
export { resolveVaultsDir };
import { resolveDatastoresDir } from "./resolve_datastores_dir.ts";
export { resolveDatastoresDir };
import { resolveReportsDir } from "./resolve_reports_dir.ts";
export { resolveReportsDir };
import { resolveWebhooksDir } from "./resolve_webhooks_dir.ts";
export { resolveWebhooksDir };

const logger = getLogger(["swamp", "cli"]);

export function resolveLogLevel(
  marker: RepoMarkerData | null,
): string | undefined {
  const envVal = Deno.env.get("SWAMP_LOG_LEVEL");
  if (envVal) return envVal;
  if (marker?.logLevel) return marker.logLevel;
  return undefined;
}

export { isTelemetryDisabledByEnv };

export function isTelemetryDisabledByConfig(
  marker: RepoMarkerData | null,
): boolean {
  return marker?.telemetryDisabled === true;
}

export interface TelemetryOptOutSources {
  marker: RepoMarkerData | null;
  userDisabled: boolean;
  /** The repo dir came from `--repo-dir` or `SWAMP_REPO_DIR`, not the cwd. */
  explicitRepoDir: boolean;
  repoScoped: boolean;
}

/**
 * every source can only opt out. a repo-scoped command with an explicit repo
 * dir and no marker is opted out too, since that repo's own opt-out and
 * endpoint are unknown
 */
export function isTelemetryOptedOut(sources: TelemetryOptOutSources): boolean {
  if (sources.userDisabled) return true;
  if (isTelemetryDisabledByConfig(sources.marker)) return true;
  return sources.marker === null && sources.explicitRepoDir &&
    sources.repoScoped;
}

export function isUpdateCheckDisabledByEnv(): boolean {
  const val = Deno.env.get("SWAMP_NO_UPDATE_CHECK");
  if (val === undefined) return false;
  return val !== "0" && val !== "false" && val !== "";
}

const NON_REPO_COMMANDS = new Set([
  "",
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
  "subscription",
  "inbox",
  // Manages its own home workspace by path; never runs a model.
  "start",
  // Manages the workspace registry; never runs inside one.
  "workspace",
]);

export function isRepoScopedCommand(
  commandInfo: Pick<CommandInvocationData, "command" | "subcommand">,
): boolean {
  if (NON_REPO_COMMANDS.has(commandInfo.command)) return false;
  return !(commandInfo.command === "repo" && commandInfo.subcommand === "init");
}

/**
 * the opt-out is read before the command writes it, so without this the
 * opting-out command would itself be recorded and sent
 */
export function isTelemetryOptOutInvocation(
  commandInfo: Pick<CommandInvocationData, "command" | "subcommand">,
  args: string[],
): boolean {
  if (commandInfo.command !== "config" || commandInfo.subcommand !== "set") {
    return false;
  }
  const keyIndex = args.indexOf("telemetry.collection");
  return keyIndex !== -1 && args[keyIndex + 1] === "disabled";
}

/**
 * completions runs at every shell start and Tab press and the shell waits for
 * stdout to close, so it must not wait on the telemetry flush at teardown
 */
export function isTelemetryExemptCommand(
  commandInfo: Pick<CommandInvocationData, "command">,
): boolean {
  return commandInfo.command === "completions";
}

/**
 * does not control when extensions load (each command's registry.ensureLoaded()
 * does), only whether the loader functions are configured on the registries
 */
export interface StartupExtensionOptions {
  repoDir: string;
  marker: RepoMarkerData | null;
  resolvedSources: ResolvedSourceDirs[];
  deferredWarnings: DeferredWarning[];
  quiet?: boolean;
  extensionsDir?: string;
  thinClient?: boolean;
  /**
   * the command leaves the repo untouched unless it loads extensions: the
   * catalog opens on first use, and managed config resolution, reconcile and
   * the missing-files check wait for the first loader
   */
  deferCatalog?: boolean;
  readDatastoreEnv?: DatastoreEnvReader;
  /**
   * drops a warning the command should not see; applies only to warnings the
   * deferred reconcile logs directly, the caller filters those collected at
   * startup
   */
  suppressWarning?: (warning: DeferredWarning) => boolean;
  datastoreLoader?: () => Promise<void>;
}

/**
 * resolves the managed config base before configuring loaders so none captures
 * a guessed lockfile path. with deferCatalog, resolution for extension-backed
 * datastores and the reconcile wait for the first loader
 */
export async function configureStartupExtensions(
  options: StartupExtensionOptions,
): Promise<() => void> {
  const {
    repoDir,
    marker,
    resolvedSources,
    deferredWarnings,
    quiet = false,
    extensionsDir,
    thinClient = false,
    deferCatalog = false,
    readDatastoreEnv,
  } = options;
  const effectiveExtDir = extensionsDir === undefined
    ? repoDir
    : rebaseOntoRepoDir(extensionsDir, repoDir);

  // extensions load through an embedded runtime under the home dir; without
  // HOME or USERPROFILE (e.g. systemd) each loader would fail with misleading
  // warnings, so warn once up front
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
        'and workflows that reference them fail with "Unknown behavior type".',
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
  const sourceWebhooksDirs = collectDirsForKind(resolvedSources, "webhooks");
  const mountedSourceDirs = flattenSourceKindDirs(resolvedSources);

  const resolveAbsoluteKindDir = (
    resolveDir: (m: RepoMarkerData | null) => string,
  ): string => {
    const dir = resolveDir(marker);
    return isAbsolute(dir)
      ? rebaseOntoRepoDir(dir, repoDir)
      : resolve(effectiveExtDir, dir);
  };

  const behaviorsDir = resolveBehaviorsDir(marker);
  const kindDirs = new Map<ExtensionKind, string[]>([
    ["models", [
      resolveAbsoluteKindDir(resolveModelsDir),
      // the behavior-spelled sibling of the default models directory; discovery
      // skips it when it does not exist
      ...(behaviorsDir === undefined
        ? []
        : [resolve(effectiveExtDir, behaviorsDir)]),
      ...sourceModelsDirs,
    ]],
    ["vaults", [resolveAbsoluteKindDir(resolveVaultsDir), ...sourceVaultsDirs]],
    [
      "datastores",
      [resolveAbsoluteKindDir(resolveDatastoresDir), ...sourceDatastoresDirs],
    ],
    [
      "reports",
      [resolveAbsoluteKindDir(resolveReportsDir), ...sourceReportsDirs],
    ],
    [
      "webhooks",
      [resolveAbsoluteKindDir(resolveWebhooksDir), ...sourceWebhooksDirs],
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

  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
    { openOnFirstUse: deferCatalog },
  );
  const dispose = () => catalog.close();

  try {
    const localManifestIdentity = readLocalManifestIdentity(repoDir);
    const managed = marker?.datastore?.managedConfig === true;
    const extensionBacked = isExtensionBackedDatastore(
      marker,
      readDatastoreEnv,
    );

    resolveManagedConfigPaths(repoDir, marker);

    // 2. The datastore extension must load before the base can resolve, so
    // in extension-backed repos it is discovered on disk, not via a lockfile.
    if (options.datastoreLoader) {
      datastoreTypeRegistry.setLoader(options.datastoreLoader);
    } else if (extensionBacked) {
      const datastoreRepository = new ExtensionRepository({
        catalog,
        lockfileRepository: new LockfileRepository(
          managedConfigLockfilePath(repoDir),
          {},
        ),
        repoRoot: repoDir,
        localManifestIdentity,
        mountedSourceDirs,
      });
      datastoreTypeRegistry.setLoader(() =>
        loadUserDatastores(
          repoDir,
          marker,
          denoRuntime,
          mergeManifestDirs(sourceDatastoresDirs, "datastores"),
          datastoreRepository,
          quiet,
          effectiveExtDir,
          undefined,
          undefined,
          () => choosePulledDatastoreDirsOnDisk(catalog, repoDir),
        )
      );
    }

    // installed-only; a failed attempt is remembered for this process so each
    // loader does not rerun the datastore index pass
    let resolutionFailed = false;
    const ensureResolvedForLoaders = async (): Promise<void> => {
      if (!extensionBacked || resolutionFailed) return;
      if (isManagedConfigBaseResolved(repoDir)) return;
      const resolved = await resolveManagedConfigOnce(
        repoDir,
        () =>
          ensureManagedConfigBase(repoDir, marker, undefined, {
            autoResolve: false,
          }),
      );
      if (!resolved) resolutionFailed = true;
    };
    if (managed && !extensionBacked) {
      await ensureManagedConfigBase(repoDir, marker);
    } else if (extensionBacked && !thinClient && !deferCatalog) {
      await ensureResolvedForLoaders();
    }
    const baseReady = () =>
      !extensionBacked || isManagedConfigBaseResolved(repoDir);

    const lockfilePathNow = () =>
      resolveManagedConfigPaths(repoDir, marker).lockfilePath;
    const localLockfileFor = (lockfilePath: string) =>
      transitionalLocalLockfilePath(
        repoDir,
        marker,
        lockfilePath,
        readDatastoreEnv,
      );
    const repositories = new Map<
      string,
      Promise<{
        repository: ExtensionRepository;
        lockfileRepository: LockfileRepository;
      }>
    >();
    const repositoryFor = (lockfilePath: string) => {
      let entry = repositories.get(lockfilePath);
      if (!entry) {
        entry = LockfileRepository.create(lockfilePath).then(
          (lockfileRepository) => ({
            lockfileRepository,
            repository: new ExtensionRepository({
              catalog,
              lockfileRepository,
              repoRoot: repoDir,
              localManifestIdentity,
              mountedSourceDirs,
            }),
          }),
        );
        entry.catch(() => repositories.delete(lockfilePath));
        repositories.set(lockfilePath, entry);
      }
      return entry;
    };

    let resolverPromise:
      | Promise<DatastorePathResolver | undefined>
      | undefined;
    const lazyResolver = async (): Promise<
      DatastorePathResolver | undefined
    > => {
      if (extensionBacked) {
        await ensureResolvedForLoaders();
        if (!isManagedConfigBaseResolved(repoDir)) return undefined;
      }
      const serveOptions = serveUpstreamConfigOptions(
        repoDir,
        await serveUpstreamOf(marker),
      );
      resolverPromise ??= resolveDatastoreConfig(
        marker,
        undefined,
        repoDir,
        serveOptions ?? (extensionBacked ? { autoResolve: false } : undefined),
      )
        .then((config) =>
          new DefaultDatastorePathResolver(
            repoDir,
            config,
          ) as DatastorePathResolver
        )
        .catch(() => {
          // an extension-backed repo retries once its base resolves,
          // installed-only; elsewhere the failure is kept so each loader does
          // not re-run the network auto-resolve
          if (extensionBacked) resolverPromise = undefined;
          return undefined;
        });
      return resolverPromise;
    };

    // reconcile returns false when the lockfile cannot be read; the
    // missing-files check reads the same file, so it is skipped rather than
    // repeating the warning
    const runReconcile = async (): Promise<boolean> => {
      const lockfilePath = lockfilePathNow();
      let loaded: Awaited<ReturnType<typeof repositoryFor>>;
      try {
        loaded = await repositoryFor(lockfilePath);
      } catch (error) {
        logger.warn`Skipping extension catalog repair: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return false;
      }
      const { repository, lockfileRepository } = loaded;
      if (
        !repository.anyKindNeedsInvalidation() &&
        !repository.manifestIdentityChanged(localManifestIdentity)
      ) {
        return true;
      }
      const reconciler = new ReconcileFromDiskService({
        denoRuntime,
        repository,
        lockfileRepository,
        repoDir,
        bundleProber: new ProcessBundleProber(),
        localManifestIdentity,
        scanOnDiskDatastores: extensionBacked,
        additionalInstalledNames: await transitionalInstalledNames(
          repoDir,
          marker,
          lockfilePath,
          readDatastoreEnv,
        ),
      });
      await reconciler.execute();
      return true;
    };
    // skip local file checks when routing to a remote serve: a thin checkout's
    // lockfile references files that exist only on the server
    const checkLocalFiles = !Deno.env.get("SWAMP_SERVE_URL");
    const checkMissing = (report: (warning: DeferredWarning) => void) => {
      const lockfilePath = lockfilePathNow();
      return checkForMissingPulledExtensions(
        repoDir,
        lockfilePath,
        localLockfileFor(lockfilePath),
        report,
      );
    };

    // reconcile counts as done only once it has read the lockfile; an
    // unreadable one (caught mid-rewrite by a sync) is retried on a later load
    let reconciled = false;
    if (baseReady() && !deferCatalog) {
      // a failed repair must not fail every command, or doctor extensions and
      // extension rm become unreachable. it is marked done for this process;
      // the populated markers stay unset so the next process retries
      let repaired = false;
      try {
        reconciled = await runReconcile();
        repaired = reconciled;
      } catch (error) {
        reconciled = true;
        const reason = (error instanceof Error ? error.message : String(error))
          .replace(/\.$/, "");
        logger
          .warn`Extension catalog repair failed: ${reason}. Run ${"swamp doctor extensions"} to inspect.`;
      }
      if (checkLocalFiles && repaired) {
        await checkMissing((w) => deferredWarnings.push(w));
      }
    }
    let deferredReconcile: Promise<void> | undefined;
    const runDeferredReconcileOnce = (): Promise<void> => {
      if (reconciled || !baseReady()) return Promise.resolve();
      deferredReconcile ??= (async () => {
        try {
          if (!await runReconcile()) {
            deferredReconcile = undefined;
            return;
          }
          reconciled = true;
          if (checkLocalFiles) {
            await checkMissing((w) => {
              if (!options.suppressWarning?.(w)) logger.warn`${w.error}`;
            });
          }
        } catch (error) {
          deferredReconcile = undefined;
          logger.warn`Extension catalog repair failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      })();
      return deferredReconcile;
    };

    const withLoaderContext = async (
      registry: { resetLoadedFlag(): void },
      load: (
        lockfilePath: string,
        repository: ExtensionRepository,
        localLockfilePath: string | undefined,
      ) => Promise<void>,
    ): Promise<void> => {
      await ensureResolvedForLoaders();
      await runDeferredReconcileOnce();
      const lockfilePath = lockfilePathNow();
      let repository: ExtensionRepository;
      try {
        ({ repository } = await repositoryFor(lockfilePath));
      } catch (error) {
        // An unreadable lockfile fails this load, but must not stay cached
        // in the registry: the next ensureLoaded retries the read.
        registry.resetLoadedFlag();
        throw error;
      }
      await load(lockfilePath, repository, localLockfileFor(lockfilePath));
    };

    modelRegistry.setLoader(() =>
      withLoaderContext(
        modelRegistry,
        (lockfilePath, repository, localLockfilePath) =>
          loadUserModels(
            repoDir,
            marker,
            denoRuntime,
            mergeManifestDirs(sourceModelsDirs, "models"),
            lazyResolver,
            repository,
            quiet,
            effectiveExtDir,
            lockfilePath,
            localLockfilePath,
          ),
      )
    );
    vaultTypeRegistry.setLoader(() =>
      withLoaderContext(
        vaultTypeRegistry,
        (lockfilePath, repository, localLockfilePath) =>
          loadUserVaults(
            repoDir,
            marker,
            denoRuntime,
            mergeManifestDirs(sourceVaultsDirs, "vaults"),
            lazyResolver,
            repository,
            quiet,
            effectiveExtDir,
            lockfilePath,
            localLockfilePath,
          ),
      )
    );
    if (!options.datastoreLoader && !extensionBacked) {
      datastoreTypeRegistry.setLoader(() =>
        withLoaderContext(
          datastoreTypeRegistry,
          (lockfilePath, repository, localLockfilePath) =>
            loadUserDatastores(
              repoDir,
              marker,
              denoRuntime,
              mergeManifestDirs(sourceDatastoresDirs, "datastores"),
              repository,
              quiet,
              effectiveExtDir,
              lockfilePath,
              localLockfilePath,
            ),
        )
      );
    }
    reportRegistry.setLoader(() =>
      withLoaderContext(
        reportRegistry,
        (lockfilePath, repository, localLockfilePath) =>
          loadUserReports(
            repoDir,
            marker,
            denoRuntime,
            mergeManifestDirs(sourceReportsDirs, "reports"),
            lazyResolver,
            repository,
            quiet,
            effectiveExtDir,
            lockfilePath,
            localLockfilePath,
          ),
      )
    );
    webhookTypeRegistry.setLoader(() =>
      withLoaderContext(
        webhookTypeRegistry,
        (lockfilePath, repository, localLockfilePath) =>
          loadUserWebhooks(
            repoDir,
            marker,
            denoRuntime,
            mergeManifestDirs(sourceWebhooksDirs, "webhooks"),
            lazyResolver,
            repository,
            quiet,
            effectiveExtDir,
            lockfilePath,
            localLockfilePath,
          ),
      )
    );

    if (checkLocalFiles) {
      await checkForSupersededSkills(repoDir, marker, deferredWarnings);
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return dispose;
}

/**
 * true when the command runs against a remote serve: --server, or SWAMP_SERVE_URL
 * / SWAMP_SERVER_URL. serve itself never counts, and a serverAddress in
 * .swamp.yaml is not considered (such checkouts still resolve at startup)
 */
/**
 * --detach asks serve to keep a run going, which only a run on serve can do, so
 * an address from the environment or .swamp.yaml still sends it there
 */
export function runsLocallyWithServeUpstream(
  marker: RepoMarkerData | null,
  commandInfo: { optionKeys: string[] },
): boolean {
  if (commandInfo.optionKeys.includes("--detach")) return false;
  return markerSaysV3(marker) &&
    serveUpstreamRunsLocally(serveUpstreamCommandPath());
}

export function isThinClientCommand(
  commandInfo: { command: string; optionKeys: string[] },
  readEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
  /**
   * the command runs locally with serve as its v3 datastore's upstream: only an
   * explicit --server makes it a thin client
   */
  servesUpstreamLocally = false,
): boolean {
  if (commandInfo.command === "serve") return false;
  if (commandInfo.optionKeys.includes("--server")) return true;
  if (servesUpstreamLocally) return false;
  return Boolean(readEnv("SWAMP_SERVE_URL") || readEnv("SWAMP_SERVER_URL"));
}

/**
 * check-config promises to leave the repo untouched, so startup does not create
 * or refresh the catalog; it still opens if the command loads extensions
 */
export function defersExtensionCatalog(
  commandInfo: Pick<CommandInvocationData, "command" | "subcommand">,
): boolean {
  return commandInfo.command === "serve" &&
    commandInfo.subcommand === "check-config";
}

/**
 * a managedConfig repo on an extension-backed datastore records auto-resolved
 * installs in the in-repo lockfile, never the datastore's, which pulls would
 * overwrite; pins still come from the datastore's
 */
export function resolveAutoResolverLockfilePath(
  repoDir: string,
  marker: RepoMarkerData | null,
  readDatastoreEnv?: DatastoreEnvReader,
): string {
  return isExtensionBackedDatastore(marker, readDatastoreEnv)
    ? managedConfigLockfilePath(repoDir)
    : resolveManagedConfigPaths(repoDir, marker).lockfilePath;
}

export function configureExtensionAutoResolver(
  repoDir: string,
  marker: RepoMarkerData | null,
  authCollectives: string[] | undefined,
  outputMode: "log" | "json",
  identity: ClientIdentity = {},
  managedLockfilePath?: string,
  mountedSourceDirs: readonly string[] = [],
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
  const effectiveLockfilePath = managedLockfilePath ?? join(
    resolve(repoDir, modelsDir),
    "upstream_extensions.json",
  );
  const denoRuntime = new EmbeddedDenoRuntime();
  setAutoResolver(
    new ExtensionAutoResolver({
      allowedCollectives: trustedCollectives,
      extensionLookup: {
        getExtension: (name) => extensionClient.getExtension(name, apiKey),
        searchExtensions: (params) =>
          extensionClient.searchExtensions(params, apiKey),
        getLatestVersionDetail: (name) =>
          extensionClient.getLatestVersionDetail(name, apiKey),
      },
      extensionInstaller: createAutoResolveInstallerAdapter({
        getExtension: (name, signal) =>
          extensionClient.getExtension(name, apiKey, signal),
        downloadArchive: (name, version, channel, signal) =>
          extensionClient.downloadArchive(
            name,
            version,
            apiKey,
            channel,
            signal,
          ),
        getChecksum: (name, version, channel, signal) =>
          extensionClient.getChecksum(name, version, apiKey, channel, signal),
        archiveCache: createDefaultExtensionArchiveCache(),
        lockfilePath: effectiveLockfilePath,
        repoDir,
        denoRuntime,
        datastoresOnDisk: isExtensionBackedDatastore(marker),
        resolvedLockfilePath: () =>
          isManagedConfigBaseResolved(repoDir)
            ? resolveManagedConfigPaths(repoDir, marker).lockfilePath
            : undefined,
        repository: new ExtensionRepository({
          // opened by the first install, so a command that resolves nothing
          // does not create the catalog
          catalog: new ExtensionCatalogStore(
            swampPath(repoDir, "_extension_catalog.db"),
            { openOnFirstUse: true },
          ),
          lockfileRepository: new LockfileRepository(
            effectiveLockfilePath,
            {},
          ),
          repoRoot: repoDir,
          mountedSourceDirs,
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
 * hook commands need the fastest startup and must never exit non-zero from
 * infrastructure code, so they skip telemetry, update checks and post-parse
 * teardown
 */
export function isHookCommand(
  commandInfo: CommandInvocationData,
): boolean {
  return commandInfo.command === "audit" &&
    commandInfo.subcommand === "record";
}

/**
 * a child the worker spawns per dispatch; it skips CLI teardown, recording no
 * telemetry and running no update check
 */
export function isDispatchRunnerCommand(
  commandInfo: CommandInvocationData,
): boolean {
  return commandInfo.command === "worker" &&
    commandInfo.subcommand === "exec-dispatch";
}

export interface DeferredWarning {
  kind:
    | "model"
    | "vault"
    | "datastore"
    | "report"
    | "webhook"
    | "extensions"
    | "skills"
    | "skill-migration";
  file: string;
  error: string;
}

const MISSING_PULLED_EXTENSIONS_MARKER =
  "pulled extension(s) have missing source files";

export function shouldSuppressMissingExtensionsWarning(
  commandInfo: CommandInvocationData,
  warning: DeferredWarning,
): boolean {
  return commandInfo.command === "extension" &&
    commandInfo.subcommand === "install" &&
    warning.kind === "extensions" &&
    warning.error.includes(MISSING_PULLED_EXTENSIONS_MARKER);
}

/**
 * used to suppress the misleading per-kind loader warnings in favour of the
 * single one from configureStartupExtensions
 */
function isMissingHomeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("home directory");
}

function throwOnTransientLoadFailures(
  failures: ReadonlyArray<
    { file: string; error: string; originalError?: unknown }
  >,
  kind: string,
  modelKind: string = kind,
): void {
  const transient = failures.filter((f) =>
    isTransientError(f.originalError ?? new Error(f.error))
  );
  if (transient.length === 0) return;
  const details = transient
    .map((f) => `${f.file}: ${f.error}`)
    .join("; ");
  const text = (noun: string) =>
    `Failed to load ${transient.length} extension ${noun}(s): ${details}. ` +
    "If another swamp process is writing the extension index, retry once it finishes.";
  throw markErrorPaths(
    markModelWording(
      new UserError(text(kind), "lock_timeout"),
      text(modelKind),
    ),
    transient.flatMap((f) => [f.file, ...errorPaths(f.originalError)]),
  );
}

async function loadUserModels(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[],
  resolverFactory: () => Promise<DatastorePathResolver | undefined>,
  repository: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
  managedLockfilePath?: string,
  localLockfilePath?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const modelsDir = resolveModelsDir(marker);
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(extBase, modelsDir);

    const lockfilePath = managedLockfilePath ??
      join(absoluteModelsDir, "upstream_extensions.json");

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      modelKindAdapter,
      repoDir,
      resolver,
      repository,
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "models",
      undefined,
      localLockfilePath,
    );

    // the lazy entry carries bundle/source paths from the catalog index,
    // avoiding a redundant SQLite read inside loadSingleType
    modelRegistry.setTypeLoader(async (type, lazyEntry) => {
      await loader.loadSingleType(type, lazyEntry);
    });

    // load order: local > sources > pulled; pulledDirs has one entry per
    // extension so file-name collisions cannot bleed across extensions
    const behaviorsDir = await existingBehaviorsDir(extBase, marker);
    const result = await loader.buildIndex(
      absoluteModelsDir,
      {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        ...(behaviorsDir ? { localDirs: [behaviorsDir] } : {}),
        indexOnly: true,
      },
    );

    throwOnTransientLoadFailures(result.failed, "behavior", "model");

    // built-in and eagerly registered types skip the type loader, so their
    // extensions attach through this hook, wired once the index is built so an
    // attach never reads a partial catalog
    modelRegistry.setExtensionAttacher((type) =>
      loader.attachPendingExtensionsForType(type)
    );
    // lets long-lived processes pick up edited local models. dirs are resolved
    // again on each pass because the scan drops catalog rows of sources it does
    // not see; the behaviors dir is watched before it exists
    const behaviorsCandidate = resolveBehaviorsDir(marker);
    // the refresher imports in-process in a long-lived process, so an edited
    // add-on to a type already in use attaches straight away; probing is only
    // for indexing
    modelRegistry.setSourceRefresher(
      createLocalModelRefresher(
        new ExtensionLoader(
          denoRuntime,
          modelKindAdapter,
          repoDir,
          resolver,
          repository,
          undefined,
          createDenoInfoModuleGraphReader,
        ),
        absoluteModelsDir,
        [
          ...(behaviorsCandidate ? [resolve(extBase, behaviorsCandidate)] : []),
          ...sourceDirs,
        ],
        async () => {
          const behaviors = await existingBehaviorsDir(extBase, marker);
          return {
            localDirs: behaviors ? [behaviors] : [],
            additionalDirs: [
              ...sourceDirs,
              ...await enumeratePulledExtensionDirs(
                lockfilePath,
                repoDir,
                "models",
                undefined,
                localLockfilePath,
              ),
            ],
          };
        },
      ),
    );

    for (const failure of result.failed) {
      if (
        failure.error.startsWith("Cannot extend unregistered behavior type")
      ) {
        logger
          .warn`User extension ${failure.file} targets unregistered base type — will retry once the base is loaded: ${failure.error}`;
      } else {
        logger
          .warn`Failed to load user behavior ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    // configureStartupExtensions already emitted one actionable warning for
    // the missing-home case; suppress the misleading per-kind duplicate.
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw wordedUserError(
        wordedText((w) =>
          `Failed to load extension ${w.nouns}: ${
            error instanceof Error ? error.message : String(error)
          }. ` +
          "If another swamp process is writing the extension index, retry once it finishes."
        ),
        "lock_timeout",
      );
    }
    logger
      .warn`Failed to load user behavior extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function loadUserVaults(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
  managedLockfilePath?: string,
  localLockfilePath?: string,
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
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = managedLockfilePath ?? join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "vaults",
      undefined,
      localLockfilePath,
    );

    if (repository) {
      vaultTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(absoluteVaultsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        indexOnly: true,
      });

      throwOnTransientLoadFailures(result.failed, "vault");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user vault ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteVaultsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      throwOnTransientLoadFailures(result.failed, "vault");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user vault ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw new UserError(
        `Failed to load extension vaults: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If another swamp process is writing the extension index, retry once it finishes.",
        "lock_timeout",
      );
    }
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
  managedLockfilePath?: string,
  localLockfilePath?: string,
  pulledDirsOverride?: () => Promise<string[]>,
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
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = managedLockfilePath ?? join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = pulledDirsOverride
      ? await pulledDirsOverride()
      : await enumeratePulledExtensionDirs(
        lockfilePath,
        repoDir,
        "datastores",
        undefined,
        localLockfilePath,
      );

    if (repository) {
      datastoreTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(
        absoluteDatastoresDir,
        {
          additionalDirs: [...sourceDirs, ...pulledDirs],
          indexOnly: true,
        },
      );

      throwOnTransientLoadFailures(result.failed, "datastore");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user datastore ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteDatastoresDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      throwOnTransientLoadFailures(result.failed, "datastore");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user datastore ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw new UserError(
        `Failed to load extension datastores: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If another swamp process is writing the extension index, retry once it finishes.",
        "lock_timeout",
      );
    }
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
  managedLockfilePath?: string,
  localLockfilePath?: string,
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
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = managedLockfilePath ?? join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "reports",
      undefined,
      localLockfilePath,
    );

    if (repository) {
      reportRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(absoluteReportsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        indexOnly: true,
      });

      throwOnTransientLoadFailures(result.failed, "report");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user report ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteReportsDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      throwOnTransientLoadFailures(result.failed, "report");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user report ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw new UserError(
        `Failed to load extension reports: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If another swamp process is writing the extension index, retry once it finishes.",
        "lock_timeout",
      );
    }
    logger
      .warn`Failed to load user report extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function loadUserWebhooks(
  repoDir: string,
  marker: RepoMarkerData | null,
  denoRuntime: EmbeddedDenoRuntime,
  sourceDirs: string[] = [],
  resolverFactory?: () => Promise<DatastorePathResolver | undefined>,
  repository?: ExtensionRepository,
  _quiet = false,
  extensionsDir?: string,
  managedLockfilePath?: string,
  localLockfilePath?: string,
): Promise<void> {
  try {
    const extBase = extensionsDir ?? repoDir;
    const webhooksDir = resolveWebhooksDir(marker);
    const absoluteWebhooksDir = isAbsolute(webhooksDir)
      ? webhooksDir
      : resolve(extBase, webhooksDir);

    const resolver = resolverFactory ? await resolverFactory() : undefined;
    const loader = new ExtensionLoader(
      denoRuntime,
      webhookKindAdapter,
      repoDir,
      resolver,
      repository,
      new ProcessBundleProber(),
      createDenoInfoModuleGraphReader,
    );
    const modelsDir = resolveModelsDir(marker);
    const lockfilePath = managedLockfilePath ?? join(
      isAbsolute(modelsDir) ? modelsDir : resolve(repoDir, modelsDir),
      "upstream_extensions.json",
    );
    const pulledDirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      repoDir,
      "webhooks",
      undefined,
      localLockfilePath,
    );

    if (repository) {
      webhookTypeRegistry.setTypeLoader(async (type) => {
        await loader.loadSingleType(type);
      });

      const result = await loader.buildIndex(absoluteWebhooksDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        indexOnly: true,
      });

      throwOnTransientLoadFailures(result.failed, "webhook");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user webhook ${failure.file}: ${failure.error}`;
      }
    } else {
      const result = await loader.load(absoluteWebhooksDir, {
        additionalDirs: [...sourceDirs, ...pulledDirs],
        skipAlreadyRegistered: true,
      });

      throwOnTransientLoadFailures(result.failed, "webhook");

      for (const failure of result.failed) {
        logger
          .warn`Failed to load user webhook ${failure.file}: ${failure.error}`;
      }
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error instanceof Deno.errors.NotFound) return;
    if (isMissingHomeError(error)) return;
    if (isTransientError(error)) {
      throw new UserError(
        `Failed to load extension webhooks: ${
          error instanceof Error ? error.message : String(error)
        }. ` +
          "If another swamp process is writing the extension index, retry once it finishes.",
        "lock_timeout",
      );
    }
    logger
      .warn`Failed to load user webhook extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function trackedSourceFiles(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const { files } = entry as { files?: unknown };
  return Array.isArray(files)
    ? files.filter((file): file is string => typeof file === "string")
    : [];
}

/**
 * entries found only in the in-repo lockfile are reported separately, since
 * extension install restores only the resolved one; an entry already gone
 * entirely awaits the auto-resolver and is not reported
 */
async function checkForMissingPulledExtensions(
  repoDir: string,
  lockfilePath: string,
  localLockfilePath: string | undefined,
  report: (warning: DeferredWarning) => void,
): Promise<void> {
  let installed: InstalledEntries;
  try {
    installed = await readInstalledEntries(lockfilePath, localLockfilePath);
  } catch (error) {
    logger.warn`Cannot check pulled extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return;
  }
  const { entries, localOnly } = installed;
  if (Object.keys(entries).length === 0) return;

  // skips bundle artifacts (regenerable cache), with the same filter as
  // inspectInstallation. advisory: a malformed entry is skipped and anything
  // else that goes wrong warns rather than failing startup
  const missing: Array<{ name: string; file: string }> = [];
  try {
    for (const [name, entry] of Object.entries(entries)) {
      for (const file of trackedSourceFiles(entry)) {
        if (isBundleArtifactPath(file)) continue;
        try {
          await Deno.stat(join(repoDir, file));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            missing.push({ name, file });
            break;
          }
        }
      }
    }
  } catch (error) {
    logger.warn`Cannot check pulled extensions: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return;
  }

  const describe = (items: typeof missing) => {
    const files = items.map((m) => m.file);
    const detail = ` (e.g. ${files.slice(0, 3).join(", ")})`;
    return `${items.map((m) => m.name).join(", ")}${detail}`;
  };
  // a team checkout's shared lockfile lists every extension the team pulled:
  // one this checkout never installed is reinstalled when a command needs it
  const shared: typeof missing = [];
  for (const m of missing) {
    if (localOnly.has(m.name)) continue;
    if (
      localLockfilePath !== undefined &&
      await isAbsentFromDisk(repoDir, m.name, entries[m.name])
    ) continue;
    shared.push(m);
  }
  const local: typeof missing = [];
  for (const m of missing) {
    if (!localOnly.has(m.name)) continue;
    // Gone entirely, it is reinstalled on next use: nothing to repair.
    if (await isAbsentFromDisk(repoDir, m.name, entries[m.name])) continue;
    local.push(m);
  }
  if (shared.length > 0) {
    report({
      kind: "extensions",
      file: lockfilePath,
      error: `${shared.length} pulled extension(s) have missing source files: ${
        describe(shared)
      }. Run 'swamp extension install' to restore them.`,
    });
  }
  if (local.length > 0) {
    // pulling would record the extension in the team's lockfile, so the remedy
    // is an auto-resolver reinstall. all of an extension's paths, skill dirs
    // included, must go or the auto-resolver treats it as installed
    const toRemove = local.map(({ name }) => {
      const paths = pathsToRemoveForReinstall(repoDir, name, entries);
      return paths.length > 0 ? `${name}: ${paths.join(", ")}` : name;
    });
    report({
      kind: "extensions",
      file: localLockfilePath ?? lockfilePath,
      error:
        `${local.length} auto-resolved extension(s) have missing source files: ${
          describe(local)
        }. To reinstall them, delete what each installed ` +
        `(${toRemove.join("; ")}) and the auto-resolver reinstalls it on ` +
        `next use. Don't use 'swamp extension pull': it would pin the ` +
        `extension in the team's lockfile.`,
    });
  }
}

async function checkForSupersededSkills(
  repoDir: string,
  marker: RepoMarkerData | null,
  deferredWarnings: DeferredWarning[],
): Promise<void> {
  try {
    const allStale = new Set<string>();
    const { contained } = await resolveSupersededSkillDirs(
      repoDir,
      marker?.tools ?? [],
    );
    for (const dir of contained) {
      const stale = await detectSupersededSkills(dir);
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

const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.swamp-club.com";

const LOCALHOST_TELEMETRY_ENDPOINT = "http://localhost:8080";

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
 * the env override is an operator escape hatch applying to every repo
 * regardless of marker, for hosts whose auth serverUrl is a non-localhost name
 * auto-detect cannot recognize (e.g. a compose network host app:5173)
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

import { resolveTrustedCollectives } from "../libswamp/extensions/trust.ts";

/**
 * telemetry is global: every run spools to the single user-level directory. a
 * repo marker only enriches the event and can opt the repo out; the user-level
 * opt-out applies to every run. null only when disabled
 */
async function initTelemetryService(
  repoDir: string,
  explicitRepoDir: boolean,
  repoScoped: boolean,
): Promise<TelemetryContext | null> {
  try {
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(repoDir);
    const marker = await markerRepo.read(repoPath);
    const prefs = await new TelemetryPreferencesFileRepository().read();
    if (
      isTelemetryOptedOut({
        marker,
        userDisabled: prefs.disabled,
        explicitRepoDir,
        repoScoped,
      })
    ) {
      return null;
    }

    let repoId: string | undefined;
    let configuredAiTools: string[] | undefined;
    let externalDatastore = false;
    let datastoreType: string | undefined;
    let externalVault = false;
    let markerEndpoint: string | undefined;
    let keepFlushed = false;

    if (marker) {
      repoId = marker.repoId;
      if (!repoId) {
        repoId = crypto.randomUUID();
        marker.repoId = repoId;
        await markerRepo.write(repoPath, marker);
      }

      // local variable only: the marker is not mutated so the expression text
      // survives future writes
      if (repoId) {
        try {
          const resolved = await resolveDatastoreExpressions(
            { v: repoId },
            { repoDir },
          );
          repoId = String(resolved.v);
        } catch {
          // Expression resolution failure in telemetry init is non-fatal —
          // fall back to the raw string so the CLI still starts.
          logger.warn`Failed to resolve repoId expression, using raw value`;
        }
      }

      configuredAiTools = marker.tools;
      externalDatastore = isExternalDatastoreConfigured(marker.datastore);
      datastoreType = marker.datastore?.type;

      try {
        const vaultRepo = new YamlVaultConfigRepository(repoDir);
        const vaultConfigs = await vaultRepo.findAll();
        externalVault = isExternalVaultConfigured(
          vaultConfigs.map((v) => v.toData()),
        );
      } catch {
        // Vault dir missing or unreadable — default to false
      }

      markerEndpoint = marker.telemetryEndpoint;
      keepFlushed = marker.telemetryKeepFlushed ?? false;
    }

    const identityRepo = new UserIdentityRepository();
    const userId = await identityRepo.getUserId();

    // loaded before telemetry endpoint resolution for localhost auto-detect
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

    // best-effort: migrating a legacy home-as-repo spool must not trip the
    // outer catch and disable telemetry for the run
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
      datastoreType,
      externalVault,
    );
    const telemetryEndpoint = resolveTelemetryEndpoint(
      markerEndpoint,
      authServerUrl,
      Deno.env.get("SWAMP_TELEMETRY_ENDPOINT"),
    );
    // entries are stamped with the endpoint resolved here and only flushed to
    // it, so a later run elsewhere cannot send them to its own endpoint
    const service = new TelemetryService(
      repository,
      VERSION,
      invocationContext,
      undefined,
      undefined,
      undefined,
      telemetryEndpoint,
      new JsonTelemetryFlushRecordRepository(globalTelemetryDir()),
      { repoId, distinctId: userId ?? repoId },
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

/**
 * kept free of invocation state so the real command tree can be built outside
 * runInvocation; the telemetry redaction fitness test walks it
 */
export function registerCommands(cli: AnyCommand): void {
  cli
    .command("access", accessCommand)
    .command("version", versionCommand)
    .command("behavior", behaviorCommand)
    .command("model", modelCommand)
    .command("init", repoInitCommand)
    .command("repo", repoCommand)
    .command("workflow", workflowCommand)
    .command("vault", vaultCommand)
    .command("data", dataCommand)
    .command("telemetry", telemetryCommand)
    .command("audit", auditCommand)
    .command("update", updateCommand)
    .command("config", configCommand)
    .command("source", sourceCommand)
    .command("completions", completionCommand)
    .command("issue", issueCommand)
    .command("invite", inviteCommand)
    // Hidden easter egg — the same command as `swamp invite link`.
    .command("first-rule", firstRuleCommand)
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
    .command("quest", questCommand)
    .command("subscription", subscriptionCommand)
    .command("inbox", inboxCommand)
    .command("start", startCommand)
    .command("dashboard", dashboardCommand)
    .command("workspace", workspaceCommand);

  // Register help command last — needs reference to the fully-built CLI tree
  cli.command("help", createHelpCommand(cli));
}

/**
 * never throws: the working directory may have been deleted during the command,
 * and a failure here must not replace the error being recorded
 */
function knownSensitiveValues(
  redactedValues: readonly string[],
  repoDir: string,
): string[] {
  try {
    return buildKnownSensitiveValues(redactedValues, {
      cwd: Deno.cwd(),
      home: Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE"),
      repoDir: resolve(repoDir),
    });
  } catch {
    return [...redactedValues];
  }
}

/**
 * flushes at once because the process is about to exit; shared by the outer
 * catch and the auth gate's early block so a failure is recorded one way
 */
async function recordAndFlushError(
  telemetryCtx: TelemetryContext,
  invocation: CommandInvocationData,
  startTime: Date,
  error: Error,
  sensitiveValues: readonly string[],
): Promise<void> {
  await telemetryCtx.service.recordError(
    invocation,
    startTime,
    error,
    sensitiveValues,
  );

  await sendTelemetryAtCommandEnd(telemetryCtx, { succeeded: false });
}

function endInvocation(): void {
  // runCli is the single setter and must be the single clearer.
  clearActiveTelemetryService();
  clearActiveTelemetryContext();
  setApiKeyFileOverride(undefined);
  endAuthGateSession();
}

/**
 * states the error contract every command shares, so a command's own help lists
 * only the codes it adds
 */
export const ROOT_DESCRIPTION = `AI Native Automation CLI

With --json, a command that fails writes its error to stderr as one JSON
document:

    { "error": "<message>", "code": "<error_code>" }

Match on "code" when it is present (an error without a stable identifier
has none, and other fields may appear); the message text can change
between releases.

Exit codes, shared by every command:

    0    success
    1    error
    2    unknown command or subcommand, or too many arguments
    75   temporary failure, such as lock contention or a temporary sign-in
         block; retry with backoff
    130  interrupted (Ctrl+C)

A command that adds codes of its own lists them in its help.`;

/**
 * no invocation state: the auth gate resolves commands against the same
 * declarations, so its decision and Cliffy's parse never disagree about an
 * option's arity
 */
export function createRootCommand(colorEnabled: boolean): AnyCommand {
  return registerCompletionTypes(
    new Command()
      .name("swamp")
      .version(VERSION)
      // Cliffy's help generator force-enables colour and ignores
      // applyColorPolicy, so it is handed the decision for help to honour
      // --no-color and a piped stdout; subcommands inherit it
      .help({ colors: colorEnabled })
      .description(ROOT_DESCRIPTION),
  )
    .globalOption("--json", "Output in JSON format (non-interactive)")
    .globalOption(
      "--log",
      "Show behavior and workflow run logs in terminal output",
    )
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
    .globalOption("--no-color", "Disable colored output");
}

/**
 * call before the real cli registers its commands: the instances are shared and
 * Cliffy re-parents each to the tree that registers it last
 */
export function buildCommandTree(): AnyCommand {
  const tree = createRootCommand(false);
  registerCommands(tree);
  return tree;
}

/** saves a CI run, which checks its signin token live, a second call */
async function gateWhoamiOr(
  outcome: AuthGateOutcome | undefined,
  serverUrl: string,
  apiKey: string,
): Promise<WhoamiResponse> {
  if (outcome?.kind === "pass" && outcome.liveResponse) {
    return outcome.liveResponse;
  }
  const client = new SwampClubClient(serverUrl, await loadIdentity());
  return await client.whoami(apiKey, AbortSignal.timeout(10_000));
}

/**
 * best effort and bounded by its own timeout; it runs at teardown, so a
 * long-running serve or worker refreshes only on exit and is re-gated on
 * restart
 */
async function runGateRefresh(
  outcome: AuthGateOutcome | undefined,
): Promise<void> {
  if (outcome?.kind !== "pass" || !outcome.refresh) return;
  try {
    await outcome.refresh();
  } catch {
    // Best effort — a failed refresh is retried on the next run.
  }
}

/**
 * the two spellings name one setting, so swamp will not guess which one was
 * meant
 */
export function assertModelsDirEnvConsistent(): void {
  const conflict = modelsDirEnvConflict();
  if (conflict !== undefined) throw new UserError(conflict);
}

export async function runCli(args: string[]): Promise<void> {
  // must happen before Cliffy parses the command tree and before any arg
  // inspection
  const { rewriteDirectTypeArgs } = await import("./arg_rewriter.ts");
  args = rewriteDirectTypeArgs(args);

  // extracted once args are final. also how --no-color is found: a real parse
  // that tracks the flag wherever it appears and skips option values, not a
  // bare scan
  const commandInfo = extractCommandInfo(args);
  setServeUpstreamCommandPath(
    [commandInfo.command, commandInfo.subcommand].filter((
      word,
    ): word is string => typeof word === "string" && word !== ""),
  );

  // root span of the whole invocation: bootstrap, the command and teardown nest
  // under it so one invocation is one trace
  await withSpan("swamp.cli", {
    "swamp.command": commandInfo.command,
    "swamp.subcommand": commandInfo.subcommand ?? "",
    "swamp.version": VERSION,
    "swamp.args": commandInfo.args.join(" "),
    "swamp.option_keys": commandInfo.optionKeys.join(" "),
    "swamp.global_options": commandInfo.globalOptions.join(" "),
  }, () => runInvocation(args, commandInfo));
}

async function runInvocation(
  args: string[],
  commandInfo: CommandInvocationData,
): Promise<void> {
  // decide colour before anything prints: Cliffy answers --version and --help
  // during parsing without reaching globalAction, so a decision made there
  // could not reach them
  const colorEnabled = applyColorPolicy(
    commandInfo.globalOptions.includes("--no-color"),
  );

  // Windows: clean up stale .old binary from a previous self-update
  if (Deno.build.os === "windows") {
    const { cleanupStaleBinary } = await import(
      "../infrastructure/update/http_update_checker.ts"
    );
    await cleanupStaleBinary(Deno.execPath());
  }

  const startTime = new Date();

  const repoDir = getRepoDirFromArgs(args);

  const extensionsDir = getExtensionsDirFromArgs(args);

  // every credential load below (telemetry, identity, auto-resolver) must use
  // the same collective key as the serve command that declares the flag
  const clubApiKeyFile = getClubApiKeyFileFromArgs(args, commandInfo);
  if (clubApiKeyFile !== undefined) {
    setApiKeyFileOverride(clubApiKeyFile);
  }

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
        throw markErrorPaths(
          new UserError(
            `--extensions-dir must be a directory: ${extensionsDir}`,
          ),
          [extensionsDir],
        );
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw markErrorPaths(
          new UserError(
            `--extensions-dir directory not found: ${extensionsDir}`,
          ),
          [extensionsDir],
        );
      }
      throw error;
    }
  }

  const telemetryDisabled = isTelemetryDisabled(args) ||
    isTelemetryDisabledByEnv() ||
    isTelemetryOptOutInvocation(commandInfo, args) ||
    isTelemetryExemptCommand(commandInfo);

  // hook commands run as PostToolUse hooks and must be fast: skip non-essential
  // startup and teardown so infrastructure errors cannot cause a non-zero exit
  const hookMode = isHookCommand(commandInfo);

  // conflicting SWAMP_MODELS_DIR and SWAMP_BEHAVIORS_DIR are refused once,
  // here; hook mode must not fail, so it runs on the SWAMP_MODELS_DIR value
  if (!hookMode) assertModelsDirEnvConsistent();

  const bootstrapSpan = getTracer().startSpan("swamp.cli.bootstrap");

  let telemetryCtx: TelemetryContext | null = null;
  if (!telemetryDisabled && !hookMode) {
    telemetryCtx = await initTelemetryService(
      repoDir,
      hasExplicitRepoDir(args),
      isRepoScopedCommand(commandInfo),
    );
  }

  // surfaces the active service for command actions that emit child telemetry;
  // cleared in the outer finally however the invocation ends
  if (telemetryCtx) {
    setActiveTelemetryService(telemetryCtx.service);
    // `swamp serve` reaches the teardown flush below only at process exit,
    // so it runs its own flush loop and needs these same credentials.
    setActiveTelemetryContext(telemetryCtx);
  }

  // buildCommandTree must run before registerCommands(cli) because Cliffy
  // re-parents shared instances to the last tree; hook mode checks locally and,
  // when blocked, records nothing and exits 0
  const commandTree = hookMode ? undefined : buildCommandTree();
  // a process that does not own the config dir (e.g. a root system daemon)
  // reads it but never writes it, leaving no root-owned files the user's own
  // runs cannot read
  const configDirOwned = processOwnsConfigDir();
  const gateTiming = commandTree ? authGateTiming(commandTree, args) : "gated";
  let gateOutcome: AuthGateOutcome | undefined;
  if (gateTiming === "exempt") telemetryCtx?.service.setAuthMode("none");
  if (gateTiming !== "exempt") {
    // Ends the run before the outer try is entered: records the failure the
    // same way the outer catch would (best effort), then clears per-run state.
    const endGatedRun = async (error: Error): Promise<void> => {
      try {
        if (telemetryCtx && commandTree) {
          telemetryCtx.service.setAuthMode("none");
          const sensitive: string[] = [];
          await recordAndFlushError(
            telemetryCtx,
            toRecordedInvocation(
              resolveTelemetryInvocation(commandTree, args, sensitive),
            ),
            startTime,
            error,
            knownSensitiveValues(sensitive, repoDir),
          );
        }
      } catch {
        // Best effort — telemetry never changes how a run ends.
      } finally {
        bootstrapSpan.end();
        endInvocation();
      }
    };
    const gateDeps = createAuthGateDeps({
      liveChecks: !hookMode,
      canWrite: configDirOwned,
    });
    const gateTime = gateDeps.now();
    try {
      gateOutcome = await runAuthGate(gateDeps);
    } catch (error) {
      // A misconfigured key source or an unreadable auth.json. Hook mode
      // treats it as a block; otherwise it is reported as itself.
      if (!hookMode) {
        await endGatedRun(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }
      gateOutcome = { kind: "block", reason: { kind: "no_credential" } };
    }
    // a worker connect with no credential may pass on the serve that enrolls
    // it, so its no_credential block waits for enrollment; every other block
    // stands
    const deferred = gateOutcome.kind === "block" &&
      gateTiming === "enrollment" &&
      gateOutcome.reason.kind === "no_credential";
    if (gateOutcome.kind === "block" && !deferred) {
      const error = authGateBlockedError(gateOutcome.reason);
      await endGatedRun(error);
      if (hookMode) return;
      throw error;
    }
    telemetryCtx?.service.setAuthMode(
      gateOutcome.kind === "pass" ? gateOutcome.authMode : "none",
    );
    publishNestedGatePass(
      gateOutcome.kind === "pass" ? gateOutcome.handoff : undefined,
    );
    beginAuthGateSession({
      deps: gateDeps,
      outcome: gateOutcome,
      gateTime,
      deferred,
    });
  }

  // Before any command can drain or take per-model locks: hand this
  // process's pid and its ancestor chain down to any swamp it starts.
  processLockHolderMarker.publish();

  // decided after publish, so a nested run sees the chain it inherited
  const noticeCommandPath = commandTree
    ? resolveTelemetryInvocation(commandTree, args, []).commandPath ?? []
    : [];
  const nestedRun = processLockHolderMarker.ancestorPids().size > 0;
  const inbox = inboxNoticeEligibility({
    commandPath: noticeCommandPath,
    gateTiming,
    gatePassed: gateOutcome?.kind === "pass",
    nested: nestedRun,
    disabledByEnv: inboxNoticeDisabledByEnv(),
  });
  const accountNotice = accountNoticeEligibility({
    commandPath: noticeCommandPath,
    gateTiming,
    gatePassed: gateOutcome?.kind === "pass",
    nested: nestedRun,
    hook: hookMode || isDispatchRunnerCommand(commandInfo),
  });

  // hook commands skip this: a null marker gives the default info log level and
  // no serverAddress fallback
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
  setMarkerServerAddress(marker?.serverAddress);
  // a v3 checkout written through serve runs its data-plane commands here with
  // serve as upstream: only an explicit --server sends them to serve
  setImplicitServeRouting(!runsLocallyWithServeUpstream(marker, commandInfo));

  // relative paths resolve against the repo's place in the git main working
  // tree, so worktrees see the same sibling sources as the main checkout
  let resolvedSources: ResolvedSourceDirs[] = [];
  if (!hookMode) {
    const sourcesConfig = await readSwampSources(repoDir);
    if (sourcesConfig) {
      const { baseDir, legacyBaseDir } = await resolveSourceBaseDirs(
        repoDir,
      );
      // logging starts only after Cliffy parses, so buffer the warning for a
      // source still resolved against the git root
      if (legacyBaseDir !== undefined) await bufferStartupWarnings();
      const expanded = await expandSourcePaths(
        sourcesConfig,
        repoDir,
        baseDir,
        legacyBaseDir,
      );
      const { resolved } = await resolveSourceExtensionDirs(
        expanded,
      );
      resolvedSources = resolved;
    }
  }

  // extensions are not loaded here but on first access, when a command calls
  // registry.ensureLoaded(); loaders log warnings directly since logging is
  // initialized by then
  const deferredWarnings: DeferredWarning[] = [];
  if (commandNeedsLoaderSetup(args) && marker !== null) {
    await withActiveSpan(
      bootstrapSpan,
      () =>
        withSpan("swamp.cli.configure_extension_loaders", {}, async () => {
          // loader warnings raised while resolving the managed config base
          // would be dropped otherwise: logging starts only after Cliffy parses
          await bufferStartupWarnings();
          await configureStartupExtensions({
            repoDir,
            marker,
            resolvedSources,
            deferredWarnings,
            quiet: isQuietFromArgs(args),
            extensionsDir,
            thinClient: isThinClientCommand(
              commandInfo,
              undefined,
              runsLocallyWithServeUpstream(marker, commandInfo),
            ),
            deferCatalog: defersExtensionCatalog(commandInfo),
            suppressWarning: (warning) =>
              shouldSuppressMissingExtensionsWarning(commandInfo, warning),
          });
        }),
    );

    for (let i = deferredWarnings.length - 1; i >= 0; i--) {
      if (
        shouldSuppressMissingExtensionsWarning(commandInfo, deferredWarnings[i])
      ) {
        deferredWarnings.splice(i, 1);
      }
    }
  }

  // whoami is called only when the cache is stale. scopes are set from the
  // response to avoid cache round-trip issues with --unstable-bundle module
  // duplication. must run before the authCollectives read
  let uncachedCollectives: string[] | undefined;
  if (!hookMode && hasApiKeySource()) {
    try {
      const authRepo = new AuthRepository();
      const creds = await authRepo.load();
      if (creds) {
        if (creds.apiKey) setCollectiveToken(creds.apiKey);
        if (isCollectiveToken()) {
          const scopeFingerprint = await keyFingerprint(creds.apiKey);
          const cachedScopes = await authRepo.loadScopeCache(scopeFingerprint);
          if (cachedScopes) {
            setAuthScopes(cachedScopes);
          } else {
            const response = await gateWhoamiOr(
              gateOutcome,
              creds.serverUrl,
              creds.apiKey,
            );
            if (response.authenticated) {
              setAuthScopes(response.scopes);
              if (response.scopes && configDirOwned) {
                await authRepo.saveScopeCache(
                  scopeFingerprint,
                  response.scopes,
                );
              }
            }
          }
        } else if (!creds.username) {
          const response = await gateWhoamiOr(
            gateOutcome,
            creds.serverUrl,
            creds.apiKey,
          );
          if (response.authenticated && response.username) {
            const collectives = getCollectives(response) ?? [];
            // A process that does not own the config dir must not write the
            // cache, so it keeps this run's collectives in memory instead.
            uncachedCollectives = collectives;
            if (configDirOwned) {
              await authRepo.saveIdentityCache(
                creds.serverUrl,
                response.username,
                collectives,
                await keyFingerprint(creds.apiKey),
                response.scopes,
              );
            }
          }
        }
      }
    } catch (err) {
      setScopeResolutionFailed(true);
      logger.warn`Scope resolution failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  let authCollectives: string[] | undefined;
  if (!hookMode) {
    try {
      const authRepo = new AuthRepository();
      const creds = await authRepo.load();
      authCollectives = creds?.collectives ?? uncachedCollectives;
      if (!hasApiKeySource()) {
        if (creds?.apiKey) setCollectiveToken(creds.apiKey);
        setAuthScopes(creds?.scopes);
      }
    } catch {
      // Auth file unreadable — continue without membership collectives
    }
  }

  if (!hookMode) {
    const autoResolverIdentity = await loadIdentity();
    setAuthenticated(Boolean(autoResolverIdentity.bearerToken));
    if (!commandNeedsLoaderSetup(args) || marker === null) {
      await ensureManagedConfigBase(repoDir, marker);
    }
    configureExtensionAutoResolver(
      repoDir,
      marker,
      authCollectives,
      getOutputModeFromArgs(args),
      autoResolverIdentity,
      resolveAutoResolverLockfilePath(repoDir, marker),
      flattenSourceKindDirs(resolvedSources),
    );
  }

  // Cliffy's own reading of -q, for the notices printed after the command;
  // startup code that fires before parsing has only the isQuietFromArgs
  // pre-parse
  let quietRequested = false;

  const cli = createRootCommand(colorEnabled)
    .globalAction(async function (options: GlobalOptions) {
      const outputMode = getOutputModeFromArgs(args);
      setConsoleGuardJsonMode(outputMode === "json");
      quietRequested = options.quiet ?? false;
      setLockProgressQuiet(quietRequested);
      setLockProgressOutputMode(outputMode);
      setRemoteIndicatorMode(
        outputMode,
        commandInfo.optionKeys.includes("--server"),
      );
      setServeOfflineOutputMode(outputMode);
      enableV3RecoveryProgress();

      // Feeds the NO_COLOR that children inherit and the log sink choice.
      // prettyOutput asks about stdin, not stdout, since log records go to
      // stderr.
      const noColor = options.color === false ||
        Deno.env.get("NO_COLOR") !== undefined;
      if (noColor) {
        Deno.env.set("NO_COLOR", "1");
      }
      const prettyOutput = !noColor && isStdinTty();

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

      const forceLog = options.log ?? false;
      const verbose = options.verbose ?? false;
      if (verbose && logLevel === "info") {
        logLevel = "debug";
      }
      await initializeLogging({
        prettyOutput,
        showProperties: options.showProperties ?? false,
        logLevel,
        jsonMode: outputMode === "json",
        noColor,
        forceLog: forceLog || verbose,
        quiet: options.quiet ?? false,
        // commands whose stdout carries a value keep log output off it
        // entirely, or -v corrupts whatever the caller pipes
        stderrOnly: isValueOnlyStdoutCommand(commandInfo),
      });

      for (const warning of deferredWarnings) {
        if (
          warning.kind === "extensions" || warning.kind === "skills" ||
          warning.kind === "skill-migration"
        ) {
          logger.warn`${warning.error}`;
        } else {
          const kind = warning.kind === "model" ? "behavior" : warning.kind;
          logger
            .warn`Failed to load user ${kind} ${warning.file}: ${warning.error}`;
        }
      }

      if (gateOutcome?.kind === "pass" && gateOutcome.warning) {
        renderAuthGateWarning(outputMode, gateOutcome.warning);
      }
    })
    .error(unknownCommandErrorHandler)
    .action(groupCommandAction);

  registerCommands(cli);

  // resolved against the real command tree before parsing, since recording
  // needs it whether the parse succeeds or throws. raw redacted values stay in
  // memory only, to scrub them from an error message; they are never recorded
  const redactedValues: string[] = [];
  const telemetryInvocation = toRecordedInvocation(
    resolveTelemetryInvocation(cli, args, redactedValues),
  );

  bootstrapSpan.end();

  // started inside the try so both teardown paths settle it. one set of deps
  // serves the poll and the notice; only the poll needs the client identity
  let inboxDeps: InboxNoticeDeps | null = null;
  let inboxPoll: InboxPoll | null = null;
  let accountNoticeDeps: AccountNoticeDeps | null = null;
  let accountNoticePoll: AccountNoticePoll | null = null;
  try {
    if (inbox.poll || inbox.notice) {
      inboxDeps = createInboxNoticeDeps({
        identity: inbox.poll ? await loadIdentity() : undefined,
      });
    }
    if (inbox.poll && inboxDeps) {
      inboxPoll = await startInboxPoll(inboxDeps);
    }
    // a fast run polls only while an ended trial is cached; the policy decides
    if (accountNotice.eligible) {
      accountNoticeDeps = createAccountNoticeDeps({
        identity: await loadIdentity(),
      });
      accountNoticePoll = await startAccountNoticePoll(accountNoticeDeps, {
        slowCommand: accountNotice.slowCommand,
      });
    }

    // Cliffy would take the token after an empty --title= as its value, so
    // reject the empty value before it parses
    const emptyOption = findEmptyOptionValue(cli, args);
    if (emptyOption !== undefined) {
      throw new UserError(`Missing value for option "${emptyOption}".`);
    }

    await cli.parse(args);

    // hook commands skip teardown so infrastructure failures cannot cause a
    // non-zero exit; the dispatch runner skips it too. Neither polls the inbox;
    // one that did would have to settle it before returning
    if (hookMode || isDispatchRunnerCommand(commandInfo)) return;

    await withSpan("swamp.cli.teardown", {}, async () => {
      // each part spanned, so a teardown that holds the exit names which
      await withSpan("swamp.cli.teardown.sync", {}, () => flushDatastoreSync());
      // after the command's locks are released, before the v3 writer hold ends:
      // the pass takes the lock itself and compacts v3 history as the writer.
      // never fails the run
      await withSpan(
        "swamp.cli.teardown.retention",
        {},
        () => runRetentionAtCommandEnd(),
      );
      await withSpan(
        "swamp.cli.teardown.datastores",
        {},
        () => closeV3DatastoresAfterSuccess(),
      );
      await withSpan(
        "swamp.cli.teardown.gate_refresh",
        {},
        () => runGateRefresh(gateOutcome),
      );

      if (telemetryCtx) {
        try {
          await telemetryCtx.service.recordSuccess(
            telemetryInvocation,
            startTime,
          );

          await sendTelemetryAtCommandEnd(telemetryCtx, { succeeded: true });
        } catch {
          // Best effort — never break the CLI for telemetry failures
        }
      }

      // Re-register the macOS autoupdate job once per installed version, as
      // launchd can refuse a binary that replaced itself. Never from update.
      let schedulerRefreshed = false;
      if (!isDevBuild(VERSION) && commandInfo.command !== "update") {
        const refresh = await refreshAutoupdateSchedulerIfOwed(
          createAutoupdateRefreshDeps(),
          VERSION,
        );
        schedulerRefreshed = refresh.outcome === "refreshed";
        if (
          refresh.outcome === "failed" &&
          postCommandNoticesAllowed(getOutputModeFromArgs(args), quietRequested)
        ) {
          console.error(
            `\n⚠ Could not re-register the autoupdate scheduler: ${refresh.error}` +
              `\n  Run \`${schedulerRepairCommand(refresh.job)}\` to fix it.`,
          );
        }
      }

      // The inbox notice prints after the command's output, before the
      // update banner.
      await withSpan("swamp.cli.teardown.inbox", {}, () =>
        finishInboxNotice({
          poll: inboxPoll,
          notice: inbox.notice,
          outputMode: getOutputModeFromArgs(args),
          quiet: quietRequested,
          // `workflow run` and `behavior run` report a failed run through the
          // exit code and return normally, so a clean return alone is not a
          // success.
          succeeded: commandSucceeded(Deno.exitCode),
          show: () =>
            inboxDeps ? showInboxNotice(inboxDeps) : Promise.resolve(null),
        }));

      if (!isUpdateCheckDisabledByEnv() && !isDevBuild(VERSION)) {
        const outputMode = getOutputModeFromArgs(args);
        const commandName = commandInfo.command;

        if (
          postCommandNoticesAllowed(outputMode, quietRequested) &&
          commandName !== "update"
        ) {
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

              // the update banner is suppressed while autoupdate is on, so a
              // dead scheduler is otherwise invisible; throttled, and skipped
              // right after a refresh, which starts a fresh check
              const now = new Date();
              if (
                lastEntry && shouldWarnStaleAutoupdate({
                  lastEntry,
                  cadence: prefs.cadence,
                  lastStaleWarning: updatedPrefs.lastStaleWarning,
                  schedulerJustRefreshed: schedulerRefreshed,
                  now,
                })
              ) {
                console.error(
                  `\n⚠ Background autoupdate has not checked for updates in ${
                    lastCheckAgeDays(lastEntry, now)
                  } days (since ${lastEntry.timestamp}).` +
                    `\n  Run \`swamp doctor install\` to see why.`,
                );
                updatedPrefs.lastStaleWarning = now.toISOString();
                prefsChanged = true;
              }

              if (prefsChanged && configDirOwned) {
                // merge onto a fresh read so a concurrent scheduler refresh's
                // fields are not rolled back
                await prefsRepo.write(
                  withNoticeFields(await prefsRepo.read(), updatedPrefs),
                );
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

      // last, and outside the update check's env guard, so nothing hides it
      await finishAccountNotice({
        poll: accountNoticePoll,
        eligible: accountNotice.eligible,
        outputMode: getOutputModeFromArgs(args),
        quiet: quietRequested,
        succeeded: commandSucceeded(Deno.exitCode),
        show: () =>
          accountNoticeDeps
            ? showAccountNotice(accountNoticeDeps)
            : Promise.resolve(null),
      });
    });
  } catch (error) {
    // release the datastore lock even on failure. flushDatastoreSync can throw,
    // so errors are swallowed: the original command error takes precedence and
    // telemetry recording below must still run
    try {
      await flushDatastoreSync();
    } catch {
      // Best effort — don't shadow the original error.
    }
    // a command that committed nothing is not told its changes are saved
    const reported = await closeV3DatastoresAfterFailure(error);

    // The command already ran, so a proof due its weekly refresh still
    // gets one.
    if (!hookMode && !isDispatchRunnerCommand(commandInfo)) {
      await runGateRefresh(gateOutcome);
    }
    // Saves the poll; a failed command's output ends with its error, so it
    // prints no notice.
    await finishInboxNotice({
      poll: inboxPoll,
      notice: false,
      outputMode: getOutputModeFromArgs(args),
      quiet: quietRequested,
      succeeded: false,
      show: () => Promise.resolve(null),
    });
    await finishAccountNotice({
      poll: accountNoticePoll,
      eligible: false,
      outputMode: getOutputModeFromArgs(args),
      quiet: quietRequested,
      succeeded: false,
      show: () => Promise.resolve(null),
    });

    if (telemetryCtx && reported instanceof Error) {
      await recordAndFlushError(
        telemetryCtx,
        telemetryInvocation,
        startTime,
        reported,
        knownSensitiveValues(redactedValues, repoDir),
      );
    }
    throw reported;
  } finally {
    endInvocation();
  }
}
