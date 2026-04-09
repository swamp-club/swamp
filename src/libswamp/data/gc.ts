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

import {
  DefaultDataLifecycleService,
  type ExpiredDataInfo,
  type LifecycleGCResult,
} from "../../domain/data/data_lifecycle_service.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Preview item for a single expired data entry. */
export interface DataGcPreviewItem {
  type: string;
  modelId: string;
  dataName: string;
  reason: string;
}

/** Preview data returned before confirmation. */
export interface DataGcPreview {
  items: DataGcPreviewItem[];
}

/** Data structure for the data gc completed event. */
export interface DataGcData {
  dataEntriesExpired: number;
  versionsDeleted: number;
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
  deleteExpiredData: (opts: {
    dryRun: boolean;
  }) => Promise<LifecycleGCResult>;
}

/** Wires real infrastructure into DataGcDeps. */
export function createDataGcDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): DataGcDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const unifiedDataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
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
    deleteExpiredData: (opts) => service.deleteExpiredData(opts),
  };
}

/** Gathers preview info for the data gc operation. */
export async function dataGcPreview(
  ctx: LibSwampContext,
  deps: DataGcDeps,
): Promise<DataGcPreview> {
  ctx.logger.debug`Finding expired data`;
  const expired = await deps.findExpiredData();
  return {
    items: expired.map((item) => ({
      type: item.type.toDirectoryPath(),
      modelId: item.modelId,
      dataName: item.dataName,
      reason: item.reason,
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

      yield {
        kind: "completed" as const,
        data: {
          dataEntriesExpired: result.dataEntriesExpired,
          versionsDeleted: result.versionsDeleted,
          bytesReclaimed: result.bytesReclaimed,
          dryRun: result.dryRun,
          expiredEntries: result.expiredEntries,
        },
      };
    })(),
  );
}
