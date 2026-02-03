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
  inputRepo: YamlInputRepository;
  definitionRepo: YamlDefinitionRepository;
  unifiedDataRepo: FileSystemUnifiedDataRepository;
  workflowRepo: YamlWorkflowRepository;
  workflowRunRepo: YamlWorkflowRunRepository;
  resourceRepo: YamlResourceRepository;
  dataRepo: YamlDataRepository;
  outputRepo: YamlOutputRepository;
  logRepo: StreamingLogRepository;
  fileRepo: FileSystemFileRepository;
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

  // These repositories don't emit events (yet)
  const resourceRepo = new YamlResourceRepository(repoDir);
  const dataRepo = new YamlDataRepository(repoDir);
  const unifiedDataRepo = new FileSystemUnifiedDataRepository(repoDir);
  const outputRepo = new YamlOutputRepository(repoDir);
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
    inputRepo,
    definitionRepo,
    unifiedDataRepo,
    workflowRepo,
    workflowRunRepo,
    resourceRepo,
    dataRepo,
    outputRepo,
    logRepo,
    fileRepo,
    vaultConfigRepo,
  };
}
