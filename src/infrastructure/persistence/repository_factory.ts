// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import {
  createNamespace,
  type Namespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import { ExtensionWorkflowRepository } from "./extension_workflow_repository.ts";
import { CompositeWorkflowRepository } from "./composite_workflow_repository.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { NoopRepoIndexService } from "../repo/noop_repo_index_service.ts";
import type { RepoIndexService } from "../../domain/repo/repo_index_service.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { YamlVaultConfigRepository } from "./yaml_vault_config_repository.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type {
  HydrateFileHook,
  MarkDirtyHook,
} from "../../domain/datastore/datastore_sync_service.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { CatalogStore } from "./catalog_store.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import { join } from "@std/path";

// =============================================================================
// Catalog Store Factory
// =============================================================================

/**
 * Resolves the on-disk path of the `_catalog.db` SQLite read-model.
 *
 * The catalog is **repo-local**: it always lives under the repo's own
 * `.swamp/data/` directory, never in the (possibly shared, possibly
 * namespaced) datastore tier. Under giga-swamp, multiple repos can share a
 * single datastore; a per-repo catalog lets each one own a private index
 * instead of clobbering the others' rows via full-replace backfill. The
 * resolver's `localPath` is never namespace-prefixed, so this is identical
 * across solo and namespaced repos.
 *
 * This is the single source of truth for the catalog path — callers that need
 * the path (e.g. `datastore compact`) must use this helper rather than
 * recomputing it, so the location can never silently drift.
 *
 * @param repoDir - The repository directory path
 * @param datastoreResolver - Optional datastore path resolver
 * @returns The absolute path to `_catalog.db`
 */
export function catalogDbPath(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): string {
  const dataBaseDir = datastoreResolver?.localPath(SWAMP_SUBDIRS.data) ??
    swampPath(repoDir, SWAMP_SUBDIRS.data);
  return join(dataBaseDir, "_catalog.db");
}

/**
 * Derives the giga-swamp {@link Namespace} value from a datastore path
 * resolver's config.
 *
 * Construction sites that build a {@link FileSystemUnifiedDataRepository}
 * directly (outside {@link createRepositoryContext}) use this so the catalog
 * namespace stamp stays in lockstep with the namespaced data path the same
 * resolver produces. Returns {@link SOLO_NAMESPACE} when no namespace is
 * configured. Centralizing the derivation keeps the ~13 direct sites from
 * drifting into a split-brain (namespaced path, solo stamp, or vice versa).
 */
export function namespaceFromResolver(
  datastoreResolver?: DatastorePathResolver,
): Namespace {
  const slug = datastoreResolver?.config().namespace ?? "";
  return slug.length > 0 ? createNamespace(slug) : SOLO_NAMESPACE;
}

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
  return new CatalogStore(catalogDbPath(repoDir, datastoreResolver));
}

/**
 * Writes a `.catalog-export.json` file to the local cache for the given
 * namespace. The file contains all catalog rows for that namespace as a
 * flat JSON array. Extensions upload this file to the remote datastore
 * via {@link DatastoreSyncService.exportCatalog}.
 */
export async function writeCatalogExport(
  catalogStore: CatalogStore,
  cachePath: string,
  namespace: string,
): Promise<number> {
  const rows = [...catalogStore.iterateNamespace(namespace)];
  const exportPath = join(cachePath, namespace, ".catalog-export.json");
  await Deno.writeTextFile(
    exportPath,
    JSON.stringify(rows, null, 2) + "\n",
  );
  return rows.length;
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
  baseDir?: string,
  markDirty?: MarkDirtyHook,
): YamlEvaluatedDefinitionRepository {
  return new YamlEvaluatedDefinitionRepository(repoDir, baseDir, markDirty);
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
  markDirty?: MarkDirtyHook,
  namespace: Namespace = SOLO_NAMESPACE,
): FileSystemUnifiedDataRepository {
  return new FileSystemUnifiedDataRepository(
    repoDir,
    baseDir,
    catalogStore,
    markDirty,
    undefined,
    namespace,
  );
}

/**
 * Creates a YamlOutputRepository for storing method execution outputs.
 *
 * Outputs track method execution state, timing, and produced artifacts.
 *
 * @param repoDir - The repository directory path
 * @returns A new YamlOutputRepository instance
 */
export function createOutputRepository(
  repoDir: string,
  baseDir?: string,
  markDirty?: MarkDirtyHook,
): YamlOutputRepository {
  return new YamlOutputRepository(repoDir, baseDir, markDirty);
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
  baseDir?: string,
  markDirty?: MarkDirtyHook,
): YamlWorkflowRunRepository {
  return new YamlWorkflowRunRepository(repoDir, eventBus, baseDir, markDirty);
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
  /**
   * Hook wired through to every datastore-tier repository so cache writes
   * invalidate the sync service's fast-path watermark. Supplied by the CLI
   * when a remote datastore with a sync service is active; absent for
   * filesystem datastores. When absent, writes do not notify — which is
   * correct for datastores without a fast-path. See `design/datastores.md`.
   */
  markDirty?: MarkDirtyHook;
  hydrateFile?: HydrateFileHook;
  /**
   * Namespace slug from the resolved datastore config (giga-swamp Phase 2).
   * Translated into the Namespace value object and stamped onto every catalog
   * row written by the unified data repository. Absent/empty → SOLO_NAMESPACE.
   */
  namespace?: string;
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
  dataQueryService: DataQueryService;
  markDirty?: MarkDirtyHook;
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
    markDirty,
    hydrateFile,
  } = config;

  // Translate the raw config namespace slug into the Namespace value object
  // exactly once — this factory is the single composition root where config
  // becomes a domain value. Empty/absent → SOLO_NAMESPACE (solo mode).
  const namespace: Namespace = config.namespace
    ? createNamespace(config.namespace)
    : SOLO_NAMESPACE;

  // Helper to resolve datastore-tier base directories
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver ? datastoreResolver.resolvePath(subdir) : undefined;

  // Create event bus
  const eventBus = new EventBus();

  // Create repositories with event bus
  // Definition and workflow repos are always local (not datastore tier).
  // Auto-definitions are datastore-tier — resolve via the datastore path
  // resolver so they're found at the namespaced path after migration.
  const autoDefDir = dsPath(SWAMP_SUBDIRS.autoDefinitions) ??
    swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions);
  const definitionRepo = new YamlDefinitionRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    definitionsDir,
    autoDefDir,
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

  // Datastore-tier repositories get resolved base directories. markDirty
  // is only wired when the caller supplies one — bare factory consumers
  // (tests, filesystem datastores) pass undefined and writes do not notify.
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
    markDirty,
  );

  // Evaluated definition repository (derived data, no events)
  const evaluatedDefinitionRepo = new YamlEvaluatedDefinitionRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.definitionsEvaluated),
    markDirty,
  );

  // Create catalog store for data query
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);

  // Unified data repository with catalog write-through
  const unifiedDataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
    markDirty,
    hydrateFile,
    namespace,
  );

  // Construct the query service alongside its dependencies so consumers
  // never need to reach into the repo to rebuild it. This keeps the
  // catalog handle as an infrastructure detail of the composition root.
  const dataQueryService = new DataQueryService(catalogStore, unifiedDataRepo);
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
    markDirty,
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
    dataQueryService,
    markDirty,
  };
}
