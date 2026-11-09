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
 * use createRepositoryContext when mutating data so events keep the logical
 * views in sync; direct repository instantiation is enough for read-only
 * operations
 */

import type { RetentionWatermarkRepository } from "../../domain/retention/retention_watermark.ts";
import type { EvaluationTrust } from "../datastore_v3/trusted_evaluations.ts";
import type {
  ContinuationClaims,
  RunRecordCurrency,
} from "../../domain/workflows/continuation_claim.ts";
import type { SignalWaitSupport } from "../../domain/workflows/signal_wait_store.ts";
import { YamlWorkflowRepository } from "./yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "./yaml_workflow_run_repository.ts";
import { YamlOutputRepository } from "./yaml_output_repository.ts";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "./yaml_evaluated_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";
import { resolveDurableWrites } from "../../domain/datastore/datastore_config.ts";
import { selectDurableWriteSync } from "./ordered_sync.ts";
import {
  type Namespace,
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import { ExtensionWorkflowRepository } from "./extension_workflow_repository.ts";
import { CompositeWorkflowRepository } from "./composite_workflow_repository.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import { NoopRepoIndexService } from "../repo/noop_repo_index_service.ts";
import type { RepoIndexService } from "../../domain/repo/repo_index_service.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { ForeignContentFetcher } from "../../domain/data/repositories.ts";
import { YamlVaultConfigRepository } from "./yaml_vault_config_repository.ts";
import {
  type DatastorePathResolver,
  resolverEngine,
} from "../../domain/datastore/datastore_path_resolver.ts";
import { v3CatalogPath } from "../datastore_v3/record_path_guard.ts";
import type {
  HydrateFileHook,
  MarkDirtyHook,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { CatalogStore, ITERATE_PAGE_SIZE } from "./catalog_store.ts";
import {
  bindCommitLogEngine,
  type CommitLogEngine,
} from "./repo_unit_of_work.ts";
import { unitOfWorkBinding } from "./unit_of_work_binding.ts";
import {
  CATALOG_WRITERS_DIR,
  SharedDatastoreWriteTracker,
} from "./shared_datastore_write_tracker.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import { dirname, join, resolve } from "@std/path";
import { ensureDir } from "@std/fs";

/**
 * repo-local under .swamp/data, never in the shared datastore tier, so repos
 * sharing a datastore each own a private index; callers must use this helper so
 * the location cannot drift
 */
export function catalogDbPath(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): string {
  // on v3 the catalog is the read model's, in the checkout's own state
  // directory, and the read model fills it
  if (resolverEngine(datastoreResolver) === "v3") return v3CatalogPath(repoDir);
  const dataBaseDir = datastoreResolver?.localPath(SWAMP_SUBDIRS.data) ??
    swampPath(repoDir, SWAMP_SUBDIRS.data);
  return join(dataBaseDir, "_catalog.db");
}

export async function removeCatalogDb(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): Promise<void> {
  const dbPath = catalogDbPath(repoDir, datastoreResolver);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      await Deno.remove(dbPath + suffix);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

/**
 * keeps the catalog namespace stamp in lockstep with the namespaced data path,
 * so direct construction sites cannot split-brain (namespaced path with solo
 * stamp, or the reverse)
 */
export function namespaceFromResolver(
  datastoreResolver?: DatastorePathResolver,
): Namespace {
  const slug = datastoreResolver?.config().namespace ?? "";
  return slug.length > 0 ? restoreNamespace(slug) : SOLO_NAMESPACE;
}

export function createCatalogStore(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): CatalogStore {
  return new CatalogStore(catalogDbPath(repoDir, datastoreResolver), {
    writeTracker: sharedDatastoreWriteTracker(datastoreResolver),
  });
}

/**
 * only for a filesystem datastore outside the repo's own .swamp, where other
 * repos may write too; repo-local and extension datastores get none
 */
function sharedDatastoreWriteTracker(
  datastoreResolver?: DatastorePathResolver,
): SharedDatastoreWriteTracker | undefined {
  if (datastoreResolver?.config().type !== "filesystem") return undefined;
  // A v3 checkout's records are its own; other writers reach it through
  // commits, which its read model applies.
  if (resolverEngine(datastoreResolver) === "v3") return undefined;
  const dataDir = resolve(datastoreResolver.resolvePath(SWAMP_SUBDIRS.data));
  if (dataDir === resolve(datastoreResolver.localPath(SWAMP_SUBDIRS.data))) {
    return undefined;
  }
  return new SharedDatastoreWriteTracker(
    join(dirname(dataDir), CATALOG_WRITERS_DIR),
  );
}

/**
 * writes to a temp file then renames atomically so a crash never corrupts the
 * previous export; yields the event loop between pages so synchronous SQLite
 * reads do not starve other work
 */
export async function writeCatalogExport(
  catalogStore: CatalogStore,
  cachePath: string,
  namespace: string,
): Promise<number> {
  const namespaceDir = join(cachePath, namespace);
  const exportPath = join(namespaceDir, ".catalog-export.json");
  const tmpPath = join(namespaceDir, `.${crypto.randomUUID()}.tmp`);
  // A checkout with no local data has not created the namespace dir yet.
  await ensureDir(namespaceDir);
  const encoder = new TextEncoder();
  const file = await Deno.open(tmpPath, {
    write: true,
    create: true,
    truncate: true,
  });
  try {
    let rowCount = 0;
    const pageBuffer: string[] = [];
    await file.write(encoder.encode("["));
    for (const row of catalogStore.iterateNamespace(namespace)) {
      if (rowCount > 0) pageBuffer.push(",");
      pageBuffer.push(JSON.stringify(row));
      rowCount++;
      if (rowCount % ITERATE_PAGE_SIZE === 0) {
        await file.write(encoder.encode(pageBuffer.join("")));
        pageBuffer.length = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (pageBuffer.length > 0) {
      await file.write(encoder.encode(pageBuffer.join("")));
    }
    await file.write(encoder.encode("]\n"));
    file.close();
    await Deno.rename(tmpPath, exportPath);
    return rowCount;
  } catch (error) {
    try {
      file.close();
    } catch { /* already closed or I/O error */ }
    try {
      await Deno.remove(tmpPath);
    } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function createDefinitionRepository(
  repoDir: string,
  eventBus?: EventBus,
  baseDir?: string,
): YamlDefinitionRepository {
  return new YamlDefinitionRepository(repoDir, eventBus, baseDir);
}

export function createEvaluatedDefinitionRepository(
  repoDir: string,
  baseDir?: string,
  markDirty?: MarkDirtyHook,
): YamlEvaluatedDefinitionRepository {
  return new YamlEvaluatedDefinitionRepository(repoDir, baseDir, markDirty);
}

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

export function createOutputRepository(
  repoDir: string,
  baseDir?: string,
  markDirty?: MarkDirtyHook,
): YamlOutputRepository {
  return new YamlOutputRepository(repoDir, baseDir, markDirty);
}

export function createWorkflowRepository(
  repoDir: string,
  eventBus?: EventBus,
  baseDir?: string,
): YamlWorkflowRepository {
  return new YamlWorkflowRepository(repoDir, eventBus, baseDir);
}

export function createWorkflowRunRepository(
  repoDir: string,
  eventBus?: EventBus,
  baseDir?: string,
  markDirty?: MarkDirtyHook,
): YamlWorkflowRunRepository {
  return new YamlWorkflowRunRepository(repoDir, eventBus, baseDir, markDirty);
}

export interface RepositoryFactoryConfig {
  repoDir: string;
  enableIndexing?: boolean;
  workflowsDir?: string;
  additionalWorkflowsDirs?: string[];
  definitionsDir?: string;
  yamlWorkflowsDir?: string;
  vaultsDir?: string;
  datastoreResolver?: DatastorePathResolver;
  /**
   * absent for filesystem datastores, where writes do not notify because there
   * is no fast-path watermark to invalidate
   */
  markDirty?: MarkDirtyHook;
  hydrateFile?: HydrateFileHook;
  /**
   * content a v3 read model could not materialise from absent content: reads of
   * it fail loudly and listings warn they leave it out. Set only for a v3
   * datastore
   */
  unreadableContent?: UnreadableContentLookup;
  /**
   * reads another namespace's content from the remote datastore, for the
   * foreign rows a catalog pull adds
   */
  fetchForeignContent?: ForeignContentFetcher;
  /**
   * stamped onto every catalog row the unified data repository writes; absent
   * or empty means solo
   */
  namespace?: string;
  autoGc?: boolean;
  /**
   * drops rows whose raw file is absent on local disk; right for filesystem
   * datastores, but must be false for remote ones where content may not be
   * hydrated yet
   */
  filterStaleRows?: boolean;
  /**
   * set only for v3; the factory gives the context its own hook when markDirty
   * is absent and marks it requireUnit, so a write outside a commit-log unit is
   * refused
   */
  commitLog?: (
    markDirty: MarkDirtyHook,
    workflowRunRepo: () => YamlWorkflowRunRepository,
  ) => CommitLogEngine;
  /**
   * the v3 read model's catalog on a v3 datastore, filled by the read model, so
   * the query service never backfills it from disk
   */
  catalogStore?: CatalogStore;
}

export interface RepositoryContext {
  eventBus: EventBus;
  indexService: RepoIndexService;

  definitionRepo: YamlDefinitionRepository;
  /** the auto-definitions only, for code that must not touch models/ */
  autoDefinitionRepo: YamlDefinitionRepository;
  evaluatedDefinitionRepo: YamlEvaluatedDefinitionRepository;
  unifiedDataRepo: FileSystemUnifiedDataRepository;
  outputRepo: YamlOutputRepository;
  workflowRepo: WorkflowRepository;
  /** The repo's own workflows dir, also wrapped by `workflowRepo`. */
  yamlWorkflowRepo: YamlWorkflowRepository;
  extensionWorkflowRepo: ExtensionWorkflowRepository | null;
  workflowRunRepo: YamlWorkflowRunRepository;
  vaultConfigRepo: YamlVaultConfigRepository;
  catalogStore: CatalogStore;
  dataQueryService: DataQueryService;
  markDirty?: MarkDirtyHook;
  hydrateFile?: HydrateFileHook;
  unreadableContent?: UnreadableContentLookup;
  commitLog?: CommitLogEngine;
  autoDefinitionsDir: string;
  /**
   * code building its own data repositories for this repo passes it on, so
   * their writes keep the same caps
   */
  autoGc?: boolean;
  /**
   * absent in a context built without a resolved datastore, which then refuses
   * a wait
   */
  signalWaits?: SignalWaitSupport;
  /**
   * absent where the datastore has no store every host reads directly; a resume
   * there takes none
   */
  continuationClaims?: ContinuationClaims;
  /**
   * absent on a filesystem datastore, where the host's record and the
   * datastore's are the same file, and where the sync service has no
   * fetchContent
   */
  runRecordCurrency?: RunRecordCurrency;
  /**
   * absent where the datastore has no control-plane store every host reads, or
   * for a read-only command on a custom datastore
   */
  retentionWatermarks?: RetentionWatermarkRepository;
  /**
   * serve sets it on v3, where a team member's client forwards its own
   * evaluations and only serve's own are run; unset, evaluated repositories are
   * read directly
   */
  evaluationTrust?: EvaluationTrust;
  /**
   * this repository is a v3 serve's: members forward run records to it, so a
   * run's reported state is the member's own
   */
  takesForwardedRunRecords?: boolean;
}

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
    hydrateFile,
    unreadableContent,
  } = config;

  // A v3 context gets a hook of its own when none was given: the hook is the
  // context's identity for its units, and must never be shared with a v2
  // context (the requireUnit mark is permanent).
  const markDirty: MarkDirtyHook | undefined = config.commitLog === undefined
    ? config.markDirty
    : config.markDirty ?? (() => Promise.resolve());
  if (config.commitLog !== undefined && markDirty !== undefined) {
    unitOfWorkBinding.requireUnit(markDirty);
  }
  const commitLog = config.commitLog !== undefined && markDirty !== undefined
    // The run repository is built below; the engine reads it only when a
    // root settles a refusal, long after this function returns.
    ? config.commitLog(markDirty, () => workflowRunRepo)
    : undefined;
  if (commitLog !== undefined && markDirty !== undefined) {
    bindCommitLogEngine(markDirty, commitLog);
  }

  const namespace: Namespace = config.namespace
    ? restoreNamespace(config.namespace)
    : SOLO_NAMESPACE;

  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver ? datastoreResolver.resolvePath(subdir) : undefined;

  const eventBus = new EventBus();

  // definition and workflow repos are always local; auto-definitions are
  // datastore-tier, resolved through the resolver so they are found at the
  // namespaced path
  const autoDefDir = dsPath(SWAMP_SUBDIRS.autoDefinitions) ??
    swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions);
  const definitionRepo = new YamlDefinitionRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    definitionsDir,
    autoDefDir,
    markDirty,
    unreadableContent,
  );
  const autoDefinitionRepo = new YamlDefinitionRepository(
    repoDir,
    undefined,
    autoDefDir,
    false,
    markDirty,
    unreadableContent,
  );
  const yamlWorkflowRepo = new YamlWorkflowRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    yamlWorkflowsDir,
    markDirty,
  );

  const extensionWorkflowRepo = workflowsDir
    ? new ExtensionWorkflowRepository(workflowsDir, additionalWorkflowsDirs)
    : null;
  const workflowRepo: WorkflowRepository = new CompositeWorkflowRepository(
    yamlWorkflowRepo,
    extensionWorkflowRepo,
  );

  // markDirty is wired only when the caller supplies one; bare consumers
  // (tests, filesystem datastores) pass undefined and writes do not notify
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
    markDirty,
    undefined,
    unreadableContent,
  );

  const evaluatedDefinitionRepo = new YamlEvaluatedDefinitionRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.definitionsEvaluated),
    markDirty,
    unreadableContent,
  );

  const catalogStore = config.catalogStore ??
    createCatalogStore(repoDir, datastoreResolver);

  const unifiedDataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
    markDirty,
    hydrateFile,
    namespace,
    config.autoGc ?? false,
    undefined,
    config.fetchForeignContent,
    unreadableContent,
    resolveDurableWrites(datastoreResolver?.config()),
    selectDurableWriteSync(
      datastoreResolver,
      catalogDbPath(repoDir, datastoreResolver),
      { catalogStoreInjected: config.catalogStore !== undefined },
    ),
  );

  const dataQueryService = new DataQueryService(catalogStore, unifiedDataRepo, {
    filterStaleRows: config.filterStaleRows ?? true,
    backfill: config.catalogStore === undefined,
  });
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
    markDirty,
    unreadableContent,
  );

  const vaultConfigRepo = new YamlVaultConfigRepository(
    repoDir,
    enableIndexing ? eventBus : undefined,
    vaultsDir,
    markDirty,
  );

  const indexService = new NoopRepoIndexService();

  return {
    eventBus,
    indexService,
    definitionRepo,
    autoDefinitionRepo,
    evaluatedDefinitionRepo,
    unifiedDataRepo,
    outputRepo,
    workflowRepo,
    yamlWorkflowRepo,
    extensionWorkflowRepo,
    workflowRunRepo,
    vaultConfigRepo,
    catalogStore,
    dataQueryService,
    markDirty,
    hydrateFile,
    ...(unreadableContent !== undefined ? { unreadableContent } : {}),
    ...(commitLog !== undefined ? { commitLog } : {}),
    autoDefinitionsDir: autoDefDir,
    autoGc: config.autoGc ?? false,
  };
}
