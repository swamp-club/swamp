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
import { isAbsolute, resolve } from "@std/path";
import { parseLogLevel } from "@logtape/logtape";
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
import { unknownCommandErrorHandler } from "./unknown_command_handler.ts";
import { type GlobalOptions, isStdinTty } from "./context.ts";
import {
  ModelNameType,
  ModelTypeType,
  WorkflowNameType,
} from "./completion_types.ts";
import { UserModelLoader } from "../domain/models/user_model_loader.ts";
import { UserVaultLoader } from "../domain/vaults/user_vault_loader.ts";
import { EmbeddedDenoRuntime } from "../infrastructure/runtime/embedded_deno_runtime.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import { JsonTelemetryRepository } from "../infrastructure/persistence/json_telemetry_repository.ts";
import { HttpTelemetrySender } from "../infrastructure/telemetry/http_telemetry_sender.ts";
import {
  extractCommandInfo,
  isTelemetryDisabled,
} from "./telemetry_integration.ts";
import { UserIdentityRepository } from "../infrastructure/persistence/user_identity_repository.ts";
import { AuthRepository } from "../infrastructure/persistence/auth_repository.ts";
import { isDevBuild } from "../domain/update/update_service.ts";
import { UpdateNotificationService } from "../domain/update/update_notification_service.ts";
import { UpdateCheckCacheFileRepository } from "../infrastructure/update/update_check_cache_file_repository.ts";
import { HttpUpdateChecker } from "../infrastructure/update/http_update_checker.ts";
import { Platform } from "../domain/update/platform.ts";
import { renderUpdateNotification } from "../presentation/output/update_notification_output.ts";
import { getOutputModeFromArgs } from "./context.ts";

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
 * Load user models from configured directory.
 */
async function loadUserModels(): Promise<void> {
  const cwd = Deno.cwd();
  const markerRepo = new RepoMarkerRepository();

  try {
    const repoPath = RepoPath.create(cwd);
    const marker = await markerRepo.read(repoPath);

    const modelsDir = resolveModelsDir(marker);
    // Handle both absolute and relative paths (cross-platform)
    const absoluteModelsDir = isAbsolute(modelsDir)
      ? modelsDir
      : resolve(cwd, modelsDir);

    const denoRuntime = new EmbeddedDenoRuntime();
    const loader = new UserModelLoader(denoRuntime, cwd);
    const result = await loader.loadModels(absoluteModelsDir);

    // Log extension successes at debug level
    if (Deno.env.get("SWAMP_DEBUG")) {
      for (const file of result.extended) {
        console.debug(`Extended model type from ${file}`);
      }
    }

    // Log failures as warnings (don't block CLI startup)
    for (const failure of result.failed) {
      console.error(
        `Warning: Failed to load user model ${failure.file}: ${failure.error}`,
      );
    }
  } catch (error) {
    // Not in a swamp repo or other error - log at debug level for troubleshooting
    if (Deno.env.get("SWAMP_DEBUG")) {
      console.debug(`Skipping user models: ${error}`);
    }
  }
}

/**
 * Load user vault implementations from configured directory.
 */
async function loadUserVaults(): Promise<void> {
  const cwd = Deno.cwd();
  const markerRepo = new RepoMarkerRepository();

  try {
    const repoPath = RepoPath.create(cwd);
    const marker = await markerRepo.read(repoPath);

    const vaultsDir = resolveVaultsDir(marker);
    const absoluteVaultsDir = isAbsolute(vaultsDir)
      ? vaultsDir
      : resolve(cwd, vaultsDir);

    const denoRuntime = new EmbeddedDenoRuntime();
    const loader = new UserVaultLoader(denoRuntime, cwd);
    const result = await loader.loadVaults(absoluteVaultsDir);

    // Log successes at debug level
    if (Deno.env.get("SWAMP_DEBUG")) {
      for (const file of result.loaded) {
        console.debug(`Loaded user vault type from ${file}`);
      }
    }

    // Log failures as warnings (don't block CLI startup)
    for (const failure of result.failed) {
      console.error(
        `Warning: Failed to load user vault ${failure.file}: ${failure.error}`,
      );
    }
  } catch (error) {
    // Not in a swamp repo or other error - log at debug level for troubleshooting
    if (Deno.env.get("SWAMP_DEBUG")) {
      console.debug(`Skipping user vaults: ${error}`);
    }
  }
}

/** Default telemetry endpoint */
const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.swamp.club";

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
async function initTelemetryService(): Promise<TelemetryContext | null> {
  try {
    const cwd = Deno.cwd();
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(cwd);

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

    const repository = new JsonTelemetryRepository(cwd);
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

  // Pre-parse check for telemetry disable flag
  const telemetryDisabled = isTelemetryDisabled(args) ||
    isTelemetryDisabledByEnv();

  // Extract command info for telemetry (before parsing)
  const commandInfo = extractCommandInfo(args);

  // Initialize telemetry service (only if in a swamp repo)
  let telemetryCtx: TelemetryContext | null = null;
  if (!telemetryDisabled) {
    telemetryCtx = await initTelemetryService();
  }

  // Load user models and vaults before setting up CLI
  await loadUserModels();
  await loadUserVaults();

  // Read marker for resolveLogLevel (used in globalAction closure)
  let marker: RepoMarkerData | null = null;
  try {
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(Deno.cwd());
    marker = await markerRepo.read(repoPath);
  } catch {
    // Not in a swamp repo - marker stays null
  }

  const cli = new Command()
    .name("swamp")
    .version(VERSION)
    .description("AI Native Automation CLI")
    .globalType("model_name", new ModelNameType())
    .globalType("model_type", new ModelTypeType())
    .globalType("workflow_name", new WorkflowNameType())
    .globalOption("--json", "Output in JSON format (non-interactive)")
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
    .command("extension", extensionCommand);

  try {
    await cli.parse(args);

    // Record successful invocation
    if (telemetryCtx) {
      await telemetryCtx.service.recordSuccess(commandInfo, startTime);

      // Flush unflushed telemetry to remote endpoint (fire-and-forget)
      const sender = new HttpTelemetrySender(telemetryCtx.telemetryEndpoint);
      telemetryCtx.service.flushTelemetry({
        sender,
        distinctId: telemetryCtx.userId ?? telemetryCtx.repoId,
        repoId: telemetryCtx.repoId,
        authToken: telemetryCtx.authToken ?? undefined,
        keepFlushed: telemetryCtx.keepFlushed,
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
    // Record error invocation before re-throwing
    if (telemetryCtx && error instanceof Error) {
      await telemetryCtx.service.recordError(commandInfo, startTime, error);
    }
    throw error;
  }
}
