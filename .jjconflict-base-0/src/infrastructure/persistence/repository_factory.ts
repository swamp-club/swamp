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

/**
 * Factory for creating repositories with optional EventBus wiring.
 *
 * This factory provides a centralized way to create repositories that
 * automatically emit domain events for index updates.
 *
 * ## When to Use createRepositoryContext
 *
 * Use `createRepositoryContext()` when:
 * - **Creating or mutating data** (model create, delete, workflow run, etc.)
 * - You need the logical views (`/models/`, `/workflows/`) to stay in sync
 * - You want automatic index updates via domain events
 *
 * ## When to Use Direct Repository Instantiation
 *
 * Use direct instantiation (e.g., `new YamlDefinitionRepository(repoDir)`) when:
 * - **Read-only operations** (search, get, validate, describe)
 * - You don't need index updates (faster, less overhead)
 * - You're in a context where the index service isn't needed
 *
 * ## Examples
 *
 * ```typescript
 * // Mutation operation - use createRepositoryContext
 * const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
 * await ctx.definitionRepo.save(type, model); // Will update /models/ index
 *
 * // Read-only operation - direct instantiation is fine
 * const definitionRepo = new YamlDefinitionRepository(repoDir);
 * const model = await definitionRepo.findById(type, id); // No index needed
 * ```
 */

import { YamlWorkflowRepository } from "./yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import { YamlOutputRepository } from "./yaml_output_repository.ts";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "./yaml_evaluated_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { SymlinkRepoIndexService } from "../repo/symlink_repo_index_service.ts";
import type { RepoIndexService } from "../../domain/repo/repo_index_service.ts";
import type {
  DefinitionCreated,
  DefinitionDeleted,
  DefinitionUpdated,
  VaultCreated,
  VaultDeleted,
  VaultSecretUpdated,
  VaultUpdated,
  WorkflowCreated,
  WorkflowDeleted,
  WorkflowRunCompleted,
  WorkflowRunFailed,
  WorkflowRunStarted,
  WorkflowUpdated,
} from "../../domain/events/types.ts";
import { YamlVaultConfigRepository } from "./yaml_vault_config_repository.ts";

// =============================================================================
// Standalone Repository Factory Functions
// =============================================================================
// Use these when you need a single repository without the full context.
// For read-only operations, these are more efficient than createRepositoryContext.

/**
 * Creates a YamlDefinitionRepository for storing model definitions.
 *
 * @param repoDir - The repository directory path
 * @param eventBus - Optional event bus for emitting domain events
 * @returns A new YamlDefinitionRepository instance
 */
export function createDefinitionRepository(
  repoDir: string,
  eventBus?: EventBus,
): YamlDefinitionRepository {
  return new YamlDefinitionRepository(repoDir, eventBus);
}

/**
 * Creates a YamlEvaluatedDefinitionRepository for storing evaluated definitions.
 *
 * Evaluated definitions have CEL expressions already resolved.
 * This repository stores derived data that can be regenerated.
 *
 * @param repoDir - The repository directory path
 * @returns A new YamlEvaluatedDefinitionRepository instance
 */
export function createEvaluatedDefinitionRepository(
  repoDir: string,
): YamlEvaluatedDefinitionRepository {
  return new YamlEvaluatedDefinitionRepository(repoDir);
}

/**
 * Creates a FileSystemUnifiedDataRepository for storing versioned data.
 *
 * The unified data repository provides:
 * - Versioned data storage with automatic version management
 * - Ownership validation to prevent unauthorized writes
 * - Garbage collection based on lifetime policies
 * - Support for streaming data
 *
 * @param repoDir - The repository directory path
 * @returns A new FileSystemUnifiedDataRepository instance
 */
export function createUnifiedDataRepository(
  repoDir: string,
): FileSystemUnifiedDataRepository {
  return new FileSystemUnifiedDataRepository(repoDir);
}

/**
 * Creates a YamlOutputRepository for storing method execution outputs.
 *
 * Outputs track method execution state, timing, and produced artifacts.
 *
 * @param repoDir - The repository directory path
 * @returns A new YamlOutputRepository instance
 */
export function createOutputRepository(repoDir: string): YamlOutputRepository {
  return new YamlOutputRepository(repoDir);
}

/**
 * Creates a YamlWorkflowRepository for storing workflow definitions.
 *
 * @param repoDir - The repository directory path
 * @param eventBus - Optional event bus for emitting domain events
 * @returns A new YamlWorkflowRepository instance
 */
export function createWorkflowRepository(
  repoDir: string,
  eventBus?: EventBus,
): YamlWorkflowRepository {
  return new YamlWorkflowRepository(repoDir, eventBus);
}

/**
 * Creates a YamlWorkflowRunRepository for storing workflow run records.
 *
 * @param repoDir - The repository directory path
 * @param eventBus - Optional event bus for emitting domain events
 * @returns A new YamlWorkflowRunRepository instance
 */
export function createWorkflowRunRepository(
  repoDir: string,
  eventBus?: EventBus,
): YamlWorkflowRunRepository {
  return new YamlWorkflowRunRepository(repoDir, eventBus);
}

/**
 * Creates a YamlVaultConfigRepository for storing vault configurations.
 *
 * @param repoDir - The repository directory path
 * @param eventBus - Optional event bus for emitting domain events
 * @returns A new YamlVaultConfigRepository instance
 */
export function createVaultConfigRepository(
  repoDir: string,
  eventBus?: EventBus,
): YamlVaultConfigRepository {
  return new YamlVaultConfigRepository(repoDir, eventBus);
}

// =============================================================================
// Repository Context
// =============================================================================

/**
 * Configuration for the repository factory.
 */
export interface RepositoryFactoryConfig {
  repoDir: string;
  enableIndexing?: boolean;
}

/**
 * Container for all repositories and the event bus.
 */
export interface RepositoryContext {
  eventBus: EventBus;
  indexService: RepoIndexService;

  definitionRepo: YamlDefinitionRepository;
  evaluatedDefinitionRepo: YamlEvaluatedDefinitionRepository;
  unifiedDataRepo: FileSystemUnifiedDataRepository;
  outputRepo: YamlOutputRepository;
  workflowRepo: YamlWorkflowRepository;
  workflowRunRepo: YamlWorkflowRunRepository;
  vaultConfigRepo: YamlVaultConfigRepository;
}

/**
 * Creates a repository context with all repositories wired to an event bus.
 *
 * When enableIndexing is true (default), repositories will emit events
 * that the RepoIndexService uses to maintain logical views.
 */
export function createRepositoryContext(
  config: RepositoryFactoryConfig,
): RepositoryContext {
  const { repoDir, enableIndexing = true } = config;

  // Create event bus
  const eventBus = new EventBus();

  // Create repositories with event bus
  const definitionRepo = new YamlDefinitionRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
  );
  const workflowRepo = new YamlWorkflowRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
  );
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
  );

  // Evaluated definition repository (derived data, no events)
  const evaluatedDefinitionRepo = new YamlEvaluatedDefinitionRepository(
    repoDir,
  );

  // Unified data repository
  const unifiedDataRepo = new FileSystemUnifiedDataRepository(repoDir);
  const outputRepo = new YamlOutputRepository(repoDir);

  // Vault config repository with event bus
  const vaultConfigRepo = new YamlVaultConfigRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
  );

  // Create index service
  const indexService = new SymlinkRepoIndexService({
    repoDir,
    definitionRepo,
    unifiedDataRepo,
    workflowRepo,
    workflowRunRepo,
    vaultConfigRepo,
  });

  // Subscribe index service to events
  if (enableIndexing) {
    // Definition events
    eventBus.subscribe<DefinitionCreated>(
      "DefinitionCreated",
      (event) =>
        indexService.handleModelCreated({
          type: "ModelCreated",
          timestamp: event.timestamp,
          modelType: event.modelType,
          modelInputId: event.definitionId,
          modelName: event.definitionName,
        }),
    );
    eventBus.subscribe<DefinitionUpdated>(
      "DefinitionUpdated",
      (event) =>
        indexService.handleModelUpdated({
          type: "ModelUpdated",
          timestamp: event.timestamp,
          modelType: event.modelType,
          modelInputId: event.definitionId,
          modelName: event.definitionName,
        }),
    );
    eventBus.subscribe<DefinitionDeleted>(
      "DefinitionDeleted",
      (event) =>
        indexService.handleModelDeleted({
          type: "ModelDeleted",
          timestamp: event.timestamp,
          modelType: event.modelType,
          modelInputId: event.definitionId,
          modelName: event.definitionName,
        }),
    );

    eventBus.subscribe<WorkflowCreated>(
      "WorkflowCreated",
      (event) => indexService.handleWorkflowCreated(event),
    );
    eventBus.subscribe<WorkflowUpdated>(
      "WorkflowUpdated",
      (event) => indexService.handleWorkflowUpdated(event),
    );
    eventBus.subscribe<WorkflowDeleted>(
      "WorkflowDeleted",
      (event) => indexService.handleWorkflowDeleted(event),
    );
    eventBus.subscribe<WorkflowRunStarted>(
      "WorkflowRunStarted",
      (event) => indexService.handleWorkflowRunStarted(event),
    );
    eventBus.subscribe<WorkflowRunCompleted>(
      "WorkflowRunCompleted",
      (event) => indexService.handleWorkflowRunCompleted(event),
    );
    eventBus.subscribe<WorkflowRunFailed>(
      "WorkflowRunFailed",
      (event) => indexService.handleWorkflowRunFailed(event),
    );
    eventBus.subscribe<VaultCreated>(
      "VaultCreated",
      (event) => indexService.handleVaultCreated(event),
    );
    eventBus.subscribe<VaultUpdated>(
      "VaultUpdated",
      (event) => indexService.handleVaultUpdated(event),
    );
    eventBus.subscribe<VaultDeleted>(
      "VaultDeleted",
      (event) => indexService.handleVaultDeleted(event),
    );
    eventBus.subscribe<VaultSecretUpdated>(
      "VaultSecretUpdated",
      (event) => indexService.handleVaultSecretUpdated(event),
    );
  }

  return {
    eventBus,
    indexService,
    definitionRepo,
    evaluatedDefinitionRepo,
    unifiedDataRepo,
    outputRepo,
    workflowRepo,
    workflowRunRepo,
    vaultConfigRepo,
  };
}
