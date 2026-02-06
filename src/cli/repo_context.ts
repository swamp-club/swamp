/**
 * CLI adapter for validating repository initialization.
 *
 * This module bridges CLI commands with the domain's RepoService by:
 * - Checking if a directory is an initialized swamp repository
 * - Throwing clear errors when not initialized
 */

import type { OutputMode } from "../presentation/output/output.ts";
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
 * Validates that a directory is an initialized swamp repository.
 *
 * Throws a UserError with helpful instructions if the directory
 * is not initialized.
 *
 * @param options - The repo directory and output mode
 * @param factoryConfig - Optional factory configuration overrides
 * @returns The validated repo context
 * @throws UserError if not initialized
 */
export async function requireInitializedRepo(
  options: RequireRepoOptions,
  factoryConfig?: Partial<Omit<RepositoryFactoryConfig, "repoDir">>,
): Promise<RepoValidationContext> {
  const { repoDir } = options;

  const repoPath = RepoPath.create(repoDir);
  const service = new RepoService(VERSION);
  const isInit = await service.isInitialized(repoPath);

  if (!isInit) {
    throw new UserError(
      `Not a swamp repository: ${repoPath.value}\n\n` +
        `To initialize a new repository, run:\n` +
        `  swamp repo init\n\n` +
        `Or specify an existing repository with --repo-dir:\n` +
        `  swamp <command> --repo-dir /path/to/repo`,
    );
  }

  // Create repository context with the validated directory
  const repoContext = createRepositoryContext({
    repoDir: repoPath.value,
    ...factoryConfig,
  });

  return {
    repoDir: repoPath.value,
    repoContext,
  };
}
