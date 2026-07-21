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
  DefaultDataLifecycleService,
  type ExpiredDataInfo,
  type LifecycleGCResult,
  type VersionGcPreviewInfo,
} from "../../domain/data/data_lifecycle_service.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type {
  GarbageCollectionResult,
  UnifiedDataRepository,
} from "../../domain/data/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { DataLifecycleService } from "../../domain/data/data_lifecycle_service.ts";
import { getLogger } from "@logtape/logtape";

/** Preview item for a single expired data entry. */
export interface DataGcPreviewItem {
  type: string;
  modelId: string;
  dataName: string;
  reason: string;
}

/** Preview item for a model that has versions to prune via version GC. */
export interface VersionGcPreviewItem {
  type: string;
  modelId: string;
  versionsWouldBeRemoved: number;
  bytesWouldBeReclaimed: number;
}

/** Preview data returned before confirmation. */
export interface DataGcPreview {
  items: DataGcPreviewItem[];
  versionGcItems: VersionGcPreviewItem[];
}

/** Data structure for the data gc completed event. */
export interface DataGcData {
  dataEntriesExpired: number;
  versionsDeleted: number;
  walPagesTotal: number;
  walPagesCheckpointed: number;
  bytesReclaimed: number;
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

/** Input for the data gc operation. */
export interface DataGcInput {
  dryRun: boolean;
}

/** Dependencies for the data gc operation. */
export interface DataGcDeps {
  findExpiredData: () => Promise<ExpiredDataInfo[]>;
  previewVersionGarbage: () => Promise<VersionGcPreviewInfo[]>;
  deleteExpiredData: (opts: {
    dryRun: boolean;
  }) => Promise<LifecycleGCResult>;
  /** Checkpoints the catalog WAL. Omit in tests that don't need compaction. */
  compactCatalog?: () => {
    walPagesTotal: number;
    walPagesCheckpointed: number;
  };
}

/** Wires real infrastructure into DataGcDeps. */
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
  );
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
  );
  const service = new DefaultDataLifecycleService(
    unifiedDataRepo,
    workflowRunRepo,
  );
  return {
    findExpiredData: () => service.findExpiredData(),
    previewVersionGarbage: () => service.previewVersionGarbage(),
    deleteExpiredData: (opts) => service.deleteExpiredData(opts),
    compactCatalog: () => catalogStore.checkpoint(),
  };
}

/** Gathers preview info for the data gc operation. */
export async function dataGcPreview(
  ctx: LibSwampContext,
  deps: DataGcDeps,
): Promise<DataGcPreview> {
  ctx.logger.debug`Finding expired data and previewing version GC`;
  const [expired, versionGc] = await Promise.all([
    deps.findExpiredData(),
    deps.previewVersionGarbage(),
  ]);
  return {
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

/** Runs garbage collection on expired data. */
export async function* dataGc(
  _ctx: LibSwampContext,
  deps: DataGcDeps,
  input: DataGcInput,
): AsyncIterable<DataGcEvent> {
  yield* withGeneratorSpan(
    "swamp.data.gc",
    { "gc.dry_run": input.dryRun },
    (async function* () {
      yield { kind: "collecting" } as const;

      const result = await deps.deleteExpiredData({ dryRun: input.dryRun });

      const compact = !input.dryRun ? deps.compactCatalog?.() : undefined;

      yield {
        kind: "completed" as const,
        data: {
          dataEntriesExpired: result.dataEntriesExpired,
          versionsDeleted: result.versionsDeleted,
          bytesReclaimed: result.bytesReclaimed,
          dryRun: result.dryRun,
          expiredEntries: result.expiredEntries,
          walPagesTotal: compact?.walPagesTotal ?? 0,
          walPagesCheckpointed: compact?.walPagesCheckpointed ?? 0,
        },
      };
    })(),
  );
}

/** Result of auto-GC including both version and lifetime expiration. */
export interface AutoGcResult extends GarbageCollectionResult {
  dataEntriesExpired: number;
}

/** Dependencies for model-scoped lifetime expiration during auto-GC. */
export interface AutoGcLifecycleDeps {
  dataRepo: Pick<UnifiedDataRepository, "findAllForModel" | "delete">;
  lifecycleService: Pick<DataLifecycleService, "isExpired">;
}

/**
 * Runs garbage collection for a single model. Catches all errors — auto-GC
 * failure must never fail the method run. User-visible output is owned by the
 * renderer via the auto_gc_completed event; this function only logs at debug
 * and warn levels.
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
