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
 * Use direct instantiation (e.g., `new YamlInputRepository(repoDir)`) when:
 * - **Read-only operations** (search, get, validate, describe)
 * - You don't need index updates (faster, less overhead)
 * - You're in a context where the index service isn't needed
 *
 * ## Examples
 *
 * ```typescript
 * // Mutation operation - use createRepositoryContext
 * const ctx = createRepositoryContext({ repoDir, enableIndexing: true });
 * await ctx.inputRepo.save(type, model); // Will update /models/ index
 *
 * // Read-only operation - direct instantiation is fine
 * const inputRepo = new YamlInputRepository(repoDir);
 * const model = await inputRepo.findById(type, id); // No index needed
 * ```
 */

import { YamlInputRepository } from "./yaml_input_repository.ts";
import { YamlWorkflowRepository } from "./yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import { YamlResourceRepository } from "./yaml_resource_repository.ts";
import { YamlDataRepository } from "./yaml_data_repository.ts";
import { YamlOutputRepository } from "./yaml_output_repository.ts";
import { StreamingLogRepository } from "./streaming_log_repository.ts";
import { FileSystemFileRepository } from "./fs_file_repository.ts";
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
  ModelCreated,
  ModelDeleted,
  ModelUpdated,
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
// Legacy Repository Factory Functions (Deprecated)
// =============================================================================

/**
 * Creates a YamlInputRepository for storing model inputs.
 *
 * @deprecated Use createDefinitionRepository() instead. Model inputs have been
 * replaced by Definitions in the new architecture.
 *
 * @param repoDir - The repository directory path
 * @param eventBus - Optional event bus for emitting domain events
 * @returns A new YamlInputRepository instance
 */
export function createInputRepository(
  repoDir: string,
  eventBus?: EventBus,
): YamlInputRepository {
  return new YamlInputRepository(repoDir, eventBus);
}

/**
 * Creates a YamlResourceRepository for storing model resources.
 *
 * @deprecated Resources are now stored as unified Data with type=resource tag.
 * Use createUnifiedDataRepository() instead.
 *
 * @param repoDir - The repository directory path
 * @returns A new YamlResourceRepository instance
 */
export function createResourceRepository(
  repoDir: string,
): YamlResourceRepository {
  return new YamlResourceRepository(repoDir);
}

/**
 * Creates a YamlDataRepository for storing model data artifacts.
 *
 * @deprecated Use createUnifiedDataRepository() instead. The unified data
 * repository provides versioning, ownership validation, and garbage collection.
 *
 * @param repoDir - The repository directory path
 * @returns A new YamlDataRepository instance
 */
export function createDataRepository(repoDir: string): YamlDataRepository {
  return new YamlDataRepository(repoDir);
}

/**
 * Creates a StreamingLogRepository for storing streaming logs.
 *
 * @deprecated Logs are now stored as unified Data with type=log tag.
 * Use createUnifiedDataRepository() with streaming=true instead.
 *
 * @param repoDir - The repository directory path
 * @returns A new StreamingLogRepository instance
 */
export function createLogRepository(repoDir: string): StreamingLogRepository {
  return new StreamingLogRepository(repoDir);
}

/**
 * Creates a FileSystemFileRepository for storing files.
 *
 * @deprecated Files are now stored as unified Data with type=file tag.
 * Use createUnifiedDataRepository() instead.
 *
 * @param repoDir - The repository directory path
 * @returns A new FileSystemFileRepository instance
 */
export function createFileRepository(
  repoDir: string,
): FileSystemFileRepository {
  return new FileSystemFileRepository(repoDir);
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

  // New architecture repositories
  definitionRepo: YamlDefinitionRepository;
  evaluatedDefinitionRepo: YamlEvaluatedDefinitionRepository;
  unifiedDataRepo: FileSystemUnifiedDataRepository;
  outputRepo: YamlOutputRepository;
  workflowRepo: YamlWorkflowRepository;
  workflowRunRepo: YamlWorkflowRunRepository;
  vaultConfigRepo: YamlVaultConfigRepository;

  /**
   * @deprecated Use definitionRepo instead. Kept for migration compatibility.
   */
  inputRepo: YamlInputRepository;

  /**
   * @deprecated Use unifiedDataRepo with type=resource tag instead.
   */
  resourceRepo: YamlResourceRepository;

  /**
   * @deprecated Use unifiedDataRepo instead.
   */
  dataRepo: YamlDataRepository;

  /**
   * @deprecated Use unifiedDataRepo with streaming=true and type=log tag instead.
   */
  logRepo: StreamingLogRepository;

  /**
   * @deprecated Use unifiedDataRepo with type=file tag instead.
   */
  fileRepo: FileSystemFileRepository;
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
  const inputRepo = new YamlInputRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
  );
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

  // Unified data repository (new architecture)
  const unifiedDataRepo = new FileSystemUnifiedDataRepository(repoDir);
  const outputRepo = new YamlOutputRepository(repoDir);

  // Legacy repositories (deprecated, kept for migration)
  const resourceRepo = new YamlResourceRepository(repoDir);
  const dataRepo = new YamlDataRepository(repoDir);
  const logRepo = new StreamingLogRepository(repoDir);
  const fileRepo = new FileSystemFileRepository(repoDir);

  // Vault config repository with event bus
  const vaultConfigRepo = new YamlVaultConfigRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
  );

  // Create index service with new repositories
  const indexService = new SymlinkRepoIndexService({
    repoDir,
    inputRepo, // Legacy support
    definitionRepo, // New definition repository
    unifiedDataRepo, // New unified data repository
    workflowRepo,
    workflowRunRepo,
    vaultConfigRepo,
  });

  // Subscribe index service to events
  if (enableIndexing) {
    // Legacy model events (from InputRepository)
    eventBus.subscribe<ModelCreated>(
      "ModelCreated",
      (event) => indexService.handleModelCreated(event),
    );
    eventBus.subscribe<ModelUpdated>(
      "ModelUpdated",
      (event) => indexService.handleModelUpdated(event),
    );
    eventBus.subscribe<ModelDeleted>(
      "ModelDeleted",
      (event) => indexService.handleModelDeleted(event),
    );

    // Definition events (from DefinitionRepository) - map to model events
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

    // New architecture repositories
    definitionRepo,
    evaluatedDefinitionRepo,
    unifiedDataRepo,
    outputRepo,
    workflowRepo,
    workflowRunRepo,
    vaultConfigRepo,

    // Legacy repositories (deprecated)
    inputRepo,
    resourceRepo,
    dataRepo,
    logRepo,
    fileRepo,
  };
}
