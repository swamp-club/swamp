import { Command } from "@cliffy/command";
import { isAbsolute, resolve } from "@std/path";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { VERSION, versionCommand } from "./commands/version.ts";
import { modelCommand } from "./commands/model_create.ts";
import { typeCommand } from "./commands/type_describe.ts";
import { repoCommand } from "./commands/repo_init.ts";
import { workflowCommand } from "./commands/workflow.ts";
import { completionCommand } from "./commands/completion.ts";
import { vaultCommand } from "./commands/vault.ts";
import { dataCommand } from "./commands/data.ts";
import type { GlobalOptions } from "./context.ts";
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

export async function runCli(args: string[]): Promise<void> {
  // Load user models before setting up CLI
  await loadUserModels();
  const cli = new Command()
    .name("swamp")
    .version(VERSION)
    .description("AI Native Automation CLI")
    .globalType("model_name", new ModelNameType())
    .globalType("model_type", new ModelTypeType())
    .globalType("workflow_name", new WorkflowNameType())
    .globalOption("--debug-logs", "Enable debug logging to dev-logs directory")
    .globalOption("--json", "Output in JSON format (non-interactive)")
    .globalOption("--stream", "Stream logs in real-time during execution")
    .globalOption("-q, --quiet", "Suppress non-essential output")
    .globalOption("-v, --verbose", "Show detailed output")
    .globalAction(async function (options: GlobalOptions) {
      await initializeLogging({
        debugLogs: options.debugLogs ?? false,
      });
    })
    .action(function () {
      this.showHelp();
    })
    .command("version", versionCommand)
    .command("model", modelCommand)
    .command("type", typeCommand)
    .command("repo", repoCommand)
    .command("workflow", workflowCommand)
    .command("vault", vaultCommand)
    .command("data", dataCommand)
    .command("completions", completionCommand);

  await cli.parse(args);
}
