/**
 * Factory for creating repositories with optional EventBus wiring.
 *
 * This factory provides a centralized way to create repositories that
 * automatically emit domain events for index updates.
 */

import { YamlInputRepository } from "./yaml_input_repository.ts";
import { YamlWorkflowRepository } from "./yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import { YamlResourceRepository } from "./yaml_resource_repository.ts";
import { YamlDataRepository } from "./yaml_data_repository.ts";
import { YamlOutputRepository } from "./yaml_output_repository.ts";
import { StreamingLogRepository } from "./streaming_log_repository.ts";
import { FileSystemFileRepository } from "./fs_file_repository.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { SymlinkRepoIndexService } from "../repo/symlink_repo_index_service.ts";
import type { RepoIndexService } from "../../domain/repo/repo_index_service.ts";
import type {
  ModelCreated,
  ModelDeleted,
  ModelUpdated,
  WorkflowCreated,
  WorkflowDeleted,
  WorkflowRunCompleted,
  WorkflowRunFailed,
  WorkflowRunStarted,
  WorkflowUpdated,
} from "../../domain/events/types.ts";

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
  workflowRepo: YamlWorkflowRepository;
  workflowRunRepo: YamlWorkflowRunRepository;
  resourceRepo: YamlResourceRepository;
  dataRepo: YamlDataRepository;
  outputRepo: YamlOutputRepository;
  logRepo: StreamingLogRepository;
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
  const outputRepo = new YamlOutputRepository(repoDir);
  const logRepo = new StreamingLogRepository(repoDir);
  const fileRepo = new FileSystemFileRepository(repoDir);

  // Create index service
  const indexService = new SymlinkRepoIndexService({
    repoDir,
    inputRepo,
    workflowRepo,
    workflowRunRepo,
  });

  // Subscribe index service to events
  if (enableIndexing) {
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
  }

  return {
    eventBus,
    indexService,
    inputRepo,
    workflowRepo,
    workflowRunRepo,
    resourceRepo,
    dataRepo,
    outputRepo,
    logRepo,
    fileRepo,
  };
}
