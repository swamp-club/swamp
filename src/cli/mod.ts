import { Command } from "@cliffy/command";
import { isAbsolute, resolve } from "@std/path";
import { parseLogLevel } from "@logtape/logtape";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { VERSION, versionCommand } from "./commands/version.ts";
import { modelCommand } from "./commands/model_create.ts";
import { typeCommand } from "./commands/type_describe.ts";
import { repoCommand, repoInitCommand } from "./commands/repo_init.ts";
import { workflowCommand } from "./commands/workflow.ts";
import { completionCommand } from "./commands/completion.ts";
import { vaultCommand } from "./commands/vault.ts";
import { dataCommand } from "./commands/data.ts";
import { telemetryCommand } from "./commands/telemetry_stats.ts";
import { updateCommand } from "./commands/update.ts";
import { type GlobalOptions, isStdinTty } from "./context.ts";
import {
  ModelNameType,
  ModelTypeType,
  WorkflowNameType,
} from "./completion_types.ts";
import { UserModelLoader } from "../domain/models/user_model_loader.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { TelemetryService } from "../domain/telemetry/telemetry_service.ts";
import { JsonTelemetryRepository } from "../infrastructure/persistence/json_telemetry_repository.ts";
import {
  extractCommandInfo,
  isTelemetryDisabled,
} from "./telemetry_integration.ts";

// Import models barrel to trigger self-registration
import "../domain/models/models.ts";

/**
 * Resolves the models directory path.
 * Priority: SWAMP_MODELS_DIR env var > .swamp.yaml config > default "extensions/models"
 *
 * @internal Exported for testing
 */
export function resolveModelsDir(marker: RepoMarkerData | null): string {
  // Environment variable takes highest priority
  const envModelsDir = Deno.env.get("SWAMP_MODELS_DIR");
  if (envModelsDir) {
    return envModelsDir;
  }

  // Then .swamp.yaml config
  if (marker?.modelsDir) {
    return marker.modelsDir;
  }

  // Default
  return "extensions/models";
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

    const loader = new UserModelLoader();
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
 * Initialize telemetry service if in a swamp repository.
 */
async function initTelemetryService(): Promise<TelemetryService | null> {
  try {
    const cwd = Deno.cwd();
    const markerRepo = new RepoMarkerRepository();
    const repoPath = RepoPath.create(cwd);

    const marker = await markerRepo.read(repoPath);
    if (!marker) {
      return null; // Not in a swamp repo
    }

    const repository = new JsonTelemetryRepository(cwd);
    return new TelemetryService(repository, VERSION);
  } catch {
    // Not in a swamp repo or other error
    return null;
  }
}

export async function runCli(args: string[]): Promise<void> {
  // Capture start time for telemetry
  const startTime = new Date();

  // Pre-parse check for telemetry disable flag
  const telemetryDisabled = isTelemetryDisabled(args);

  // Extract command info for telemetry (before parsing)
  const commandInfo = extractCommandInfo(args);

  // Initialize telemetry service (only if in a swamp repo)
  let telemetryService: TelemetryService | null = null;
  if (!telemetryDisabled) {
    telemetryService = await initTelemetryService();
  }

  // Load user models before setting up CLI
  await loadUserModels();

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
      }
      const prettyOutput = !noColor && isStdinTty();

      // Derive log level: --quiet → error, --log-level → parsed, default → info
      let logLevel: "trace" | "debug" | "info" | "warning" | "error" | "fatal" =
        "info";
      if (options.quiet) {
        logLevel = "error";
      } else if (options.logLevel) {
        logLevel = parseLogLevel(options.logLevel);
      }

      await initializeLogging({
        prettyOutput,
        showProperties: options.showProperties ?? false,
        logLevel,
        jsonMode: options.json ?? false,
        noColor,
      });
    })
    .action(function () {
      this.showHelp();
    })
    .command("version", versionCommand)
    .command("model", modelCommand)
    .command("type", typeCommand)
    .command("init", repoInitCommand)
    .command("repo", repoCommand)
    .command("workflow", workflowCommand)
    .command("vault", vaultCommand)
    .command("data", dataCommand)
    .command("telemetry", telemetryCommand)
    .command("update", updateCommand)
    .command("completions", completionCommand);

  try {
    await cli.parse(args);

    // Record successful invocation
    if (telemetryService) {
      await telemetryService.recordSuccess(commandInfo, startTime);
      // Trigger cleanup asynchronously (fire-and-forget)
      telemetryService.cleanupOldTelemetry();
    }
  } catch (error) {
    // Record error invocation before re-throwing
    if (telemetryService && error instanceof Error) {
      await telemetryService.recordError(commandInfo, startTime, error);
    }
    throw error;
  }
}
