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
  type IsModelLive,
  type OrphanedDataInfo,
  type OrphanReclamationResult,
} from "../../domain/data/data_lifecycle_service.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Preview item for a single orphaned model whose data would be reclaimed. */
export interface DataPrunePreviewItem {
  type: string;
  modelId: string;
  modelName?: string;
  dataNames: string[];
  versionCount: number;
  bytesReclaimed: number;
}

/** Preview data returned before confirmation. */
export interface DataPrunePreview {
  items: DataPrunePreviewItem[];
}

/** Data structure for the data prune completed event. */
export interface DataPruneData {
  modelsReclaimed: number;
  dataEntriesReclaimed: number;
  versionsDeleted: number;
  bytesReclaimed: number;
  dryRun: boolean;
  reclaimedModels: Array<{
    type: string;
    modelId: string;
    modelName?: string;
    dataNames: string[];
    versionCount: number;
    bytesReclaimed: number;
  }>;
  walPagesTotal: number;
  walPagesCheckpointed: number;
}

export type DataPruneEvent =
  | { kind: "collecting" }
  | { kind: "completed"; data: DataPruneData }
  | { kind: "error"; error: SwampError };

/** Input for the data prune operation. */
export interface DataPruneInput {
  dryRun: boolean;
}

/** Dependencies for the data prune operation. */
export interface DataPruneDeps {
  findOrphanedData: () => Promise<OrphanedDataInfo[]>;
  deleteOrphanedData: (opts: {
    dryRun: boolean;
  }) => Promise<OrphanReclamationResult>;
  /** Checkpoints the catalog WAL. Omit in tests that don't need compaction. */
  compactCatalog?: () => {
    walPagesTotal: number;
    walPagesCheckpointed: number;
  };
}

/** Wires real infrastructure into DataPruneDeps. */
export function createDataPruneDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): DataPruneDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);
  const unifiedDataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
    undefined,
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

  // The definition repository resolves models from BOTH models/ and
  // .swamp/auto-definitions/ (the constructor default), matching what
  // `swamp model get <id>` reports. isModelLive MUST use this per-item lookup —
  // NOT model search / findAllGlobal, which skip auto-definitions and would
  // falsely flag every auto-definition-backed model as orphaned.
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const isModelLive: IsModelLive = async (type, modelId) =>
    (await definitionRepo.findById(type, createDefinitionId(modelId))) !== null;

  return {
    findOrphanedData: () => service.findOrphanedData(isModelLive),
    deleteOrphanedData: (opts) =>
      service.deleteOrphanedData({ isModelLive, dryRun: opts.dryRun }),
    compactCatalog: () => catalogStore.checkpoint(),
  };
}

/** Gathers preview info for the data prune operation. */
export async function dataPrunePreview(
  ctx: LibSwampContext,
  deps: DataPruneDeps,
): Promise<DataPrunePreview> {
  ctx.logger.debug`Finding orphaned data`;
  const orphans = await deps.findOrphanedData();
  return {
    items: orphans.map((item) => ({
      type: item.type.toDirectoryPath(),
      modelId: item.modelId,
      modelName: item.modelName,
      dataNames: item.dataNames,
      versionCount: item.versionCount,
      bytesReclaimed: item.bytesReclaimed,
    })),
  };
}

/** Reclaims orphaned data whose owning model definition no longer exists. */
export async function* dataPrune(
  _ctx: LibSwampContext,
  deps: DataPruneDeps,
  input: DataPruneInput,
): AsyncIterable<DataPruneEvent> {
  yield* withGeneratorSpan(
    "swamp.data.prune",
    { "prune.dry_run": input.dryRun },
    (async function* () {
      yield { kind: "collecting" } as const;

      const result = await deps.deleteOrphanedData({ dryRun: input.dryRun });

      const compact = !input.dryRun ? deps.compactCatalog?.() : undefined;

      yield {
        kind: "completed" as const,
        data: {
          modelsReclaimed: result.modelsReclaimed,
          dataEntriesReclaimed: result.dataEntriesReclaimed,
          versionsDeleted: result.versionsDeleted,
          bytesReclaimed: result.bytesReclaimed,
          dryRun: result.dryRun,
          reclaimedModels: result.reclaimedModels,
          walPagesTotal: compact?.walPagesTotal ?? 0,
          walPagesCheckpointed: compact?.walPagesCheckpointed ?? 0,
        },
      };
    })(),
  );
}
