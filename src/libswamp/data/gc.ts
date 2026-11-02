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

import {
  type DataRetentionResult,
  type DataRetentionScan,
  DefaultDataLifecycleService,
  type ExpiredDataInfo,
  type LifecycleGCResult,
  type VersionGcPreviewInfo,
} from "../../domain/data/data_lifecycle_service.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import {
  isRetentionExempt,
  RETENTION_EXEMPT_MODEL_TYPES,
} from "../../domain/retention/retention_exemptions.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { resolveDurableWrites } from "../../domain/datastore/datastore_config.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type {
  GarbageCollectionResult,
  UnifiedDataRepository,
} from "../../domain/data/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { DataLifecycleService } from "../../domain/data/data_lifecycle_service.ts";
import { getLogger } from "@logtape/logtape";

export interface DataGcPreviewItem {
  type: string;
  modelId: string;
  dataName: string;
  reason: string;
}

export interface VersionGcPreviewItem {
  type: string;
  modelId: string;
  versionsWouldBeRemoved: number;
  bytesWouldBeReclaimed: number;
}

export interface DataGcAgedOutPreview {
  entries: number;
  versions: number;
  bytes: number;
}

export interface DataGcPreview {
  items: DataGcPreviewItem[];
  versionGcItems: VersionGcPreviewItem[];
  agedOut?: DataGcAgedOutPreview;
}

export interface DataGcData {
  dataEntriesExpired: number;
  versionsDeleted: number;
  walPagesTotal: number;
  walPagesCheckpointed: number;
  bytesReclaimed: number;
  // dataGc always sets the aged-out counts; a server older than data retention
  // omits them from its data.gc response
  agedOutEntries?: number;
  agedOutVersions?: number;
  agedOutBytes?: number;
  dryRun: boolean;
  expiredEntries: Array<{
    type: string;
    modelId: string;
    dataName: string;
    reason: string;
  }>;
}

export type DataGcEvent =
  | { kind: "collecting" }
  | { kind: "completed"; data: DataGcData }
  | { kind: "error"; error: SwampError };

export interface DataGcInput {
  dryRun: boolean;
  /**
   * The repository's data retention (`garbageCollection.data` or
   * `retention` in `.swamp.yaml`). When set, every version of model data
   * older than this is deleted first, latest versions included.
   */
  dataRetentionMs?: number;
}

export interface DataGcDeps {
  findExpiredData: () => Promise<ExpiredDataInfo[]>;
  previewVersionGarbage: () => Promise<VersionGcPreviewInfo[]>;
  deleteExpiredData: (opts: {
    dryRun: boolean;
  }) => Promise<LifecycleGCResult>;
  deleteDataOlderThan?: (
    cutoff: Date,
    opts: { dryRun: boolean; limit?: number; scan?: DataRetentionScan },
  ) => Promise<DataRetentionResult>;
  compactCatalog?: () => {
    walPagesTotal: number;
    walPagesCheckpointed: number;
  };
}

export function createDataGcDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  markDirty?: MarkDirtyHook,
): DataGcDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);
  const unifiedDataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
    markDirty,
    undefined,
    namespaceFromResolver(datastoreResolver),
    undefined,
    undefined,
    undefined,
    undefined,
    resolveDurableWrites(datastoreResolver?.config()),
  );
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
  );
  return createDataGcDepsFrom(catalogStore, unifiedDataRepo, workflowRunRepo);
}

export function createDataGcDepsFrom(
  catalogStore: CatalogStore,
  unifiedDataRepo: FileSystemUnifiedDataRepository,
  workflowRunRepo: YamlWorkflowRunRepository,
): DataGcDeps {
  const service = new DefaultDataLifecycleService(
    unifiedDataRepo,
    workflowRunRepo,
  );
  return {
    findExpiredData: () => service.findExpiredData(),
    previewVersionGarbage: () => service.previewVersionGarbage(),
    deleteExpiredData: (opts) => service.deleteExpiredData(opts),
    deleteDataOlderThan: async (cutoff, opts) => {
      // Retention reads its candidates from the catalog, so a catalog not
      // yet filled from disk is filled first.
      await new DataQueryService(catalogStore, unifiedDataRepo)
        .ensurePopulated();
      return await service.deleteDataOlderThan(cutoff, {
        ...opts,
        isExempt: isRetentionExempt,
        exemptTypes: [...RETENTION_EXEMPT_MODEL_TYPES],
      });
    },
    compactCatalog: () => catalogStore.checkpoint(),
  };
}

export async function dataGcPreview(
  ctx: LibSwampContext,
  deps: DataGcDeps,
  input?: Pick<DataGcInput, "dataRetentionMs">,
): Promise<DataGcPreview> {
  ctx.logger.debug`Finding expired data and previewing version GC`;
  const agedOut = await previewAgedOut(deps, input?.dataRetentionMs);
  const [expired, versionGc] = await Promise.all([
    deps.findExpiredData(),
    deps.previewVersionGarbage(),
  ]);
  return {
    ...(agedOut ? { agedOut } : {}),
    items: expired.map((item) => ({
      type: item.type.toDirectoryPath(),
      modelId: item.modelId,
      dataName: item.dataName,
      reason: item.reason,
    })),
    versionGcItems: versionGc.map((item) => ({
      type: item.type.toDirectoryPath(),
      modelId: item.modelId,
      versionsWouldBeRemoved: item.versionsWouldBeRemoved,
      bytesWouldBeReclaimed: item.bytesWouldBeReclaimed,
    })),
  };
}

async function previewAgedOut(
  deps: DataGcDeps,
  dataRetentionMs: number | undefined,
): Promise<DataGcAgedOutPreview | undefined> {
  if (dataRetentionMs === undefined || !deps.deleteDataOlderThan) {
    return undefined;
  }
  const result = await deps.deleteDataOlderThan(
    new Date(Date.now() - dataRetentionMs),
    { dryRun: true },
  );
  return {
    entries: result.entriesDeleted,
    versions: result.versionsDeleted,
    bytes: result.bytesReclaimed,
  };
}

export async function* dataGc(
  ctx: LibSwampContext,
  deps: DataGcDeps,
  input: DataGcInput,
): AsyncIterable<DataGcEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.data.gc",
      {
        "gc.dry_run": input.dryRun,
        "gc.data_retention": input.dataRetentionMs !== undefined,
      },
      (async function* () {
        yield { kind: "collecting" } as const;

        // Retention runs first and unbounded: the manual command applies
        // the whole policy, and expiry then sees only what is left.
        const agedOut =
          input.dataRetentionMs !== undefined && deps.deleteDataOlderThan
            ? await deps.deleteDataOlderThan(
              new Date(Date.now() - input.dataRetentionMs),
              { dryRun: input.dryRun },
            )
            : undefined;

        const result = await deps.deleteExpiredData({ dryRun: input.dryRun });

        const compact = !input.dryRun ? deps.compactCatalog?.() : undefined;

        yield {
          kind: "completed" as const,
          data: {
            dataEntriesExpired: result.dataEntriesExpired,
            versionsDeleted: result.versionsDeleted,
            bytesReclaimed: result.bytesReclaimed,
            agedOutEntries: agedOut?.entriesDeleted ?? 0,
            agedOutVersions: agedOut?.versionsDeleted ?? 0,
            agedOutBytes: agedOut?.bytesReclaimed ?? 0,
            dryRun: result.dryRun,
            expiredEntries: result.expiredEntries,
            walPagesTotal: compact?.walPagesTotal ?? 0,
            walPagesCheckpointed: compact?.walPagesCheckpointed ?? 0,
          },
        };
      })(),
    ));
}

export interface AutoGcResult extends GarbageCollectionResult {
  dataEntriesExpired: number;
}

export interface AutoGcLifecycleDeps {
  dataRepo: Pick<UnifiedDataRepository, "findAllForModel" | "delete">;
  lifecycleService: Pick<DataLifecycleService, "isExpired">;
}

/**
 * catches all errors: auto-GC failure must never fail the method run. Output is
 * owned by the renderer via auto_gc_completed; this only logs at debug and
 * warn.
 */
export async function autoGc(
  dataRepo: {
    collectGarbage: (
      type: ModelType,
      modelId: string,
    ) => Promise<GarbageCollectionResult>;
  },
  type: ModelType,
  modelId: string,
  lifecycleDeps?: AutoGcLifecycleDeps,
): Promise<AutoGcResult | null> {
  const logger = getLogger(["swamp", "auto-gc"]);
  try {
    const result = await dataRepo.collectGarbage(type, modelId);

    let dataEntriesExpired = 0;
    if (lifecycleDeps) {
      const allData = await lifecycleDeps.dataRepo.findAllForModel(
        type,
        modelId,
      );
      for (const data of allData) {
        if (data.isDeleted) continue;
        try {
          if (await lifecycleDeps.lifecycleService.isExpired(data)) {
            await lifecycleDeps.dataRepo.delete(type, modelId, data.name);
            dataEntriesExpired++;
          }
        } catch (err) {
          logger
            .warn`Auto-GC lifetime check failed for ${type.normalized}/${modelId}/${data.name}: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    }

    logger
      .debug`Auto-GC for ${type.normalized}/${modelId}: ${result.versionsRemoved} version(s) removed, ${dataEntriesExpired} expired entry/entries deleted, ${result.bytesReclaimed} bytes reclaimed`;
    return { ...result, dataEntriesExpired };
  } catch (error) {
    logger
      .warn`Auto-GC failed for ${type.normalized}/${modelId}: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return null;
  }
}
