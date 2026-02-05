/**
 * CLI adapter for validating repository initialization and providing interactive prompts.
 *
 * This module bridges CLI commands with the domain's RepoService by:
 * - Checking if a directory is an initialized swamp repository
 * - Prompting users interactively to initialize or specify a different path
 * - Throwing clear errors in non-interactive mode
 */

import type { OutputMode } from "../presentation/output/output.tsx";
import {
  createRepositoryContext,
  type RepositoryContext,
  type RepositoryFactoryConfig,
} from "../infrastructure/persistence/repository_factory.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { RepoService } from "../domain/repo/repo_service.ts";
import { UserError } from "../domain/errors.ts";
import { VERSION } from "./commands/version.ts";

/**
 * Options for requireInitializedRepo.
 */
export interface RequireRepoOptions {
  repoDir: string;
  outputMode: OutputMode;
}

/**
 * Result of successful repo validation containing the validated directory
 * and repository context.
 */
export interface RepoValidationContext {
  repoDir: string;
  repoContext: RepositoryContext;
}

/**
 * Prompts user for a choice in interactive mode.
 * Returns the user's single-character input.
 */
async function promptChoice(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message}: `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    return "";
  }

  return decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
}

/**
 * Prompts user for a path in interactive mode.
 */
async function promptPath(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message}: `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) {
    return "";
  }

  return decoder.decode(buf.subarray(0, n)).trim();
}

/**
 * Displays the interactive menu for uninitialized repository.
 */
function displayMenu(repoDir: string): void {
  console.log(`\nThis directory is not a swamp repository: ${repoDir}\n`);
  console.log("Options:");
  console.log("  [i] Initialize here (swamp repo init)");
  console.log("  [p] Specify a different path");
  console.log("  [q] Quit\n");
}

/**
 * Handles the interactive flow when a repository is not initialized.
 * Returns the final validated repo directory or throws if user quits.
 */
async function handleInteractivePrompt(
  initialRepoDir: string,
  _outputMode: OutputMode,
): Promise<string> {
  let currentDir = initialRepoDir;

  while (true) {
    displayMenu(currentDir);
    const choice = await promptChoice("Choice");

    switch (choice) {
      case "i": {
        // Initialize the current directory
        const repoPath = RepoPath.create(currentDir);
        const service = new RepoService(VERSION);
        const result = await service.init(repoPath);

        console.log(`\nRepository initialized at ${result.path}`);
        console.log(`Version: ${result.version}`);
        if (result.skillsCopied.length > 0) {
          console.log(`Skills copied: ${result.skillsCopied.join(", ")}`);
        }
        if (result.claudeMdCreated) {
          console.log("Created CLAUDE.md");
        }
        console.log("");

        return currentDir;
      }
      case "p": {
        // Prompt for a different path
        const newPath = await promptPath("Enter repository path");
        if (!newPath) {
          console.log("No path entered, please try again.");
          continue;
        }

        // Validate the new path
        const repoPath = RepoPath.create(newPath);
        const service = new RepoService(VERSION);
        const isInit = await service.isInitialized(repoPath);

        if (isInit) {
          return repoPath.value;
        }

        // Not initialized - update currentDir and loop again
        currentDir = repoPath.value;
        break;
      }
      case "q":
        throw new UserError("Operation cancelled by user.");
      default:
        console.log(`Invalid choice: '${choice}'. Please enter i, p, or q.`);
    }
  }
}

/**
 * Validates that a directory is an initialized swamp repository.
 *
 * In interactive mode, prompts the user with options to:
 * - Initialize the current directory
 * - Specify a different path
 * - Quit
 *
 * In non-interactive mode (json/stream), throws a UserError with
 * helpful instructions.
 *
 * @param options - The repo directory and output mode
 * @param factoryConfig - Optional factory configuration overrides
 * @returns The validated repo context
 * @throws UserError if not initialized and user quits or in non-interactive mode
 */
export async function requireInitializedRepo(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<RepoValidationContext> {
  const { repoDir, outputMode } = options;

  const repoPath = RepoPath.create(repoDir);
  const service = new RepoService(VERSION);
  const isInit = await service.isInitialized(repoPath);

  let finalRepoDir = repoPath.value;

  if (!isInit) {
    if (outputMode === "interactive") {
      // Interactive mode: prompt user
      finalRepoDir = await handleInteractivePrompt(repoPath.value, outputMode);
    } else {
      // Non-interactive mode: throw helpful error
      throw new UserError(
        `Not a swamp repository: ${repoPath.value}\n\n` +
          `To initialize a new repository, run:\n` +
          `  swamp repo init\n\n` +
          `Or specify an existing repository with --repo-dir:\n` +
          `  swamp <command> --repo-dir /path/to/repo`,
      );
    }
  }

  // Create repository context with the final validated directory
  const repoContext = createRepositoryContext({
    repoDir: finalRepoDir,
    ...factoryConfig,
  });

  return {
    repoDir: finalRepoDir,
    repoContext,
  };
}
