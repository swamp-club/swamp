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
import { join, resolve } from "@std/path";
import {
  globalTelemetryDir,
  isManagedConfigBaseResolved,
  managedConfigLockfilePath,
  swampPath,
} from "../infrastructure/persistence/paths.ts";

import {
  type DatastoreEnvReader,
  isExtensionBackedDatastore,
} from "../infrastructure/persistence/managed_config_lockfile.ts";
import { migrateHomeRepoTelemetry } from "../infrastructure/persistence/telemetry_spool_migration.ts";
import { markErrorPaths, UserError } from "../domain/errors.ts";

import { getLogger, parseLogLevel } from "@logtape/logtape";
import {
  configureStartupExtensions,
  type DeferredWarning,
  shouldSuppressMissingExtensionsWarning,
} from "./startup_extensions.ts";
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
} from "./context.ts";
import { registerCompletionTypes } from "./completion_types.ts";

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

import { LockfileRepository } from "../infrastructure/persistence/lockfile_repository.ts";

import { setConsoleGuardJsonMode } from "../domain/models/console_guard.ts";

import {
  closeV3DatastoresAfterFailure,
  closeV3DatastoresAfterSuccess,
} from "./v3_teardown.ts";

import "../domain/datastore/datastore_types.ts";
import "../domain/reports/builtin/mod.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";

import { createDefaultExtensionArchiveCache } from "../infrastructure/persistence/extension_archive_cache.ts";
import { processOwnsConfigDir } from "../infrastructure/persistence/config_dir_ownership.ts";
import { renderAuthGateWarning } from "../presentation/renderers/auth_gate_warning.ts";

import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";

import { ExtensionAutoResolver } from "../domain/extensions/extension_auto_resolver.ts";
import { ExtensionApiClient } from "../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../infrastructure/http/client_identity.ts";
import { loadIdentity, USER_AGENT } from "./load_identity.ts";
import { resolveAccountAuthentication } from "../libswamp/auth/account.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../domain/auth/auth_credentials.ts";
import { setAutoResolver } from "./auto_resolver_context.ts";
import {
  createAutoResolveInstallerAdapter,
  createAutoResolveOutputAdapter,
} from "./auto_resolver_adapters.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import { isTelemetryDisabledByEnv } from "../infrastructure/telemetry/telemetry_opt_out_env.ts";
import { JsonTelemetryFlushRecordRepository } from "../infrastructure/persistence/json_telemetry_flush_record_repository.ts";
import { JsonTelemetryRepository } from "../infrastructure/persistence/json_telemetry_repository.ts";
import { YamlVaultConfigRepository } from "../infrastructure/persistence/yaml_vault_config_repository.ts";
import { HttpTelemetrySender } from "../infrastructure/telemetry/http_telemetry_sender.ts";
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
  setApiKeyFileOverride,
} from "../infrastructure/persistence/api_key_source.ts";

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
  expandSourcePaths,
  flattenSourceKindDirs,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../infrastructure/persistence/swamp_sources_repository.ts";
import { resolveSourceBaseDirs } from "../infrastructure/persistence/git_worktree.ts";
import type { ResolvedSourceDirs } from "../domain/repo/swamp_sources.ts";

import "../domain/models/models.ts";

// Import and re-export — the canonical definitions live in
// separate files to avoid circular imports through mod.ts.
import { resolveModelsDir } from "./resolve_models_dir.ts";
export { resolveModelsDir };
import { modelsDirEnvConflict } from "../infrastructure/persistence/resolve_models_dir.ts";
import {
  enableV3RecoveryProgress,
  ensureManagedConfigBase,
  markerSaysV3,
  resolveManagedConfigPaths,
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

  // distinct_id is required by the sender; skip the flush if neither userId nor
  // repoId resolved
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

  if (!hookMode) {
    const { identity: autoResolverIdentity, collectives: authCollectives } =
      await resolveAccountAuthentication({
        gateOutcome,
        canWrite: configDirOwned,
        loadIdentity,
        onScopeResolutionFailure: (err) => {
          logger.warn`Scope resolution failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        },
      });
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
      await flushDatastoreSync();
      // after the command's locks are released, before the v3 writer hold ends:
      // the pass takes the lock itself and compacts v3 history as the writer.
      // never fails the run
      await runRetentionAtCommandEnd();
      await closeV3DatastoresAfterSuccess();
      await runGateRefresh(gateOutcome);

      if (telemetryCtx) {
        try {
          await telemetryCtx.service.recordSuccess(
            telemetryInvocation,
            startTime,
          );

          // distinct_id is required by the sender; if neither userId nor repoId
          // resolved, skip the flush and leave the entry spooled for a future
          // run
          const distinctId = telemetryCtx.userId ?? telemetryCtx.repoId;
          if (distinctId) {
            const sender = new HttpTelemetrySender(
              telemetryCtx.telemetryEndpoint,
              USER_AGENT,
            );
            const flushResult = await telemetryCtx.service.flushTelemetry({
              sender,
              distinctId,
              repoId: telemetryCtx.repoId,
              authToken: telemetryCtx.authToken ?? undefined,
              keepFlushed: telemetryCtx.keepFlushed,
              signal: AbortSignal.timeout(2000),
            });
            if (!flushResult.result.ok) {
              const detail = flushResult.result.reason
                ? ` (${flushResult.result.reason})`
                : "";
              logger.warn(
                `Telemetry flush failed${detail} — entries are queued locally and will retry on the next invocation`,
              );
            }
          }

          // Cleanup with bounded timeout so Deno.exit() doesn't kill it
          await Promise.race([
            telemetryCtx.service.cleanupOldTelemetry(),
            new Promise<void>((r) => setTimeout(r, 3000)),
          ]);
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
      await finishInboxNotice({
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
      });

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
