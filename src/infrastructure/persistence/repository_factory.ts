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
import { ExtensionWorkflowRepository } from "./extension_workflow_repository.ts";
import { CompositeWorkflowRepository } from "./composite_workflow_repository.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { NoopRepoIndexService } from "../repo/noop_repo_index_service.ts";
import type { RepoIndexService } from "../../domain/repo/repo_index_service.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { YamlVaultConfigRepository } from "./yaml_vault_config_repository.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { CatalogStore } from "./catalog_store.ts";
import { join } from "@std/path";

// =============================================================================
// Catalog Store Factory
// =============================================================================

/**
 * Creates a CatalogStore for the given repository.
 *
 * Centralizes the three-step pattern: resolve data base dir, build DB path,
 * construct CatalogStore. Use this whenever you need a CatalogStore outside
 * of {@link createRepositoryContext}.
 *
 * @param repoDir - The repository directory path
 * @param datastoreResolver - Optional datastore path resolver
 * @returns A new CatalogStore instance
 */
export function createCatalogStore(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): CatalogStore {
  const dataBaseDir = datastoreResolver?.resolvePath(SWAMP_SUBDIRS.data) ??
    swampPath(repoDir, SWAMP_SUBDIRS.data);
  const catalogDbPath = join(dataBaseDir, "_catalog.db");
  return new CatalogStore(catalogDbPath);
}

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
  baseDir?: string,
): YamlDefinitionRepository {
  return new YamlDefinitionRepository(repoDir, eventBus, baseDir);
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
  catalogStore: CatalogStore,
  baseDir?: string,
): FileSystemUnifiedDataRepository {
  return new FileSystemUnifiedDataRepository(repoDir, baseDir, catalogStore);
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
  baseDir?: string,
): YamlWorkflowRepository {
  return new YamlWorkflowRepository(repoDir, eventBus, baseDir);
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
  baseDir?: string,
): YamlVaultConfigRepository {
  return new YamlVaultConfigRepository(repoDir, eventBus, baseDir);
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
  workflowsDir?: string;
  /** Additional workflow directories to scan (e.g. pulled extensions). */
  additionalWorkflowsDirs?: string[];
  definitionsDir?: string;
  yamlWorkflowsDir?: string;
  vaultsDir?: string;
  datastoreResolver?: DatastorePathResolver;
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
  workflowRepo: WorkflowRepository;
  workflowRunRepo: YamlWorkflowRunRepository;
  vaultConfigRepo: YamlVaultConfigRepository;
  catalogStore: CatalogStore;
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
  const {
    repoDir,
    enableIndexing = true,
    workflowsDir,
    additionalWorkflowsDirs,
    definitionsDir,
    yamlWorkflowsDir,
    vaultsDir,
    datastoreResolver,
  } = config;

  // Helper to resolve datastore-tier base directories
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver ? datastoreResolver.resolvePath(subdir) : undefined;

  // Create event bus
  const eventBus = new EventBus();

  // Create repositories with event bus
  // Definition and workflow repos are always local (not datastore tier)
  const definitionRepo = new YamlDefinitionRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    definitionsDir,
  );
  const yamlWorkflowRepo = new YamlWorkflowRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    yamlWorkflowsDir,
  );

  // Create composite workflow repo if extension workflows dir is provided
  const extensionWorkflowRepo = workflowsDir
    ? new ExtensionWorkflowRepository(workflowsDir, additionalWorkflowsDirs)
    : null;
  const workflowRepo: WorkflowRepository = new CompositeWorkflowRepository(
    yamlWorkflowRepo,
    extensionWorkflowRepo,
  );

  // Datastore-tier repositories get resolved base directories
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
  );

  // Evaluated definition repository (derived data, no events)
  const evaluatedDefinitionRepo = new YamlEvaluatedDefinitionRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.definitionsEvaluated),
  );

  // Create catalog store for data query
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);

  // Unified data repository with catalog write-through
  const unifiedDataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
  );
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
  );

  // Vault config repository with event bus
  const vaultConfigRepo = new YamlVaultConfigRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    vaultsDir,
  );

  // Create index service (no-op — symlink-based indexing has been removed)
  const indexService = new NoopRepoIndexService();

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
    catalogStore,
  };
}
