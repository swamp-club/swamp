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
  DataDeleteService,
  type DeletePreview,
  type DeleteResult,
} from "../../domain/data/data_delete_service.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Data structure for the data delete completed event. */
export interface DataDeleteData {
  modelId: string;
  modelName: string;
  modelType: string;
  dataName: string;
  version?: number;
  versionsDeleted: number;
}

/** Preview returned before confirmation. */
export interface DataDeletePreview {
  modelId: string;
  modelName: string;
  modelType: string;
  dataName: string;
  versionsCount: number;
}

export type DataDeleteEvent =
  | { kind: "deleting" }
  | { kind: "completed"; data: DataDeleteData }
  | { kind: "error"; error: SwampError };

/** Input for the data delete operation. */
export interface DataDeleteInput {
  modelIdOrName: string;
  dataName: string;
  version?: number;
}

/** Dependencies for the data delete operation. */
export interface DataDeleteDeps {
  delete: (
    modelIdOrName: string,
    dataName: string,
    version?: number,
  ) => Promise<DeleteResult>;
  preview: (
    modelIdOrName: string,
    dataName: string,
  ) => Promise<DeletePreview>;
}

/** Wires real infrastructure into DataDeleteDeps. */
export function createDataDeleteDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): DataDeleteDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
  );
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const service = new DataDeleteService(dataRepo, definitionRepo);
  return {
    delete: (modelIdOrName, dataName, version) =>
      service.delete(modelIdOrName, dataName, version),
    preview: (modelIdOrName, dataName) =>
      service.previewDelete(modelIdOrName, dataName),
  };
}

/** Gathers preview info (version count) without mutating state. */
export async function dataDeletePreview(
  ctx: LibSwampContext,
  deps: DataDeleteDeps,
  input: { modelIdOrName: string; dataName: string },
): Promise<DataDeletePreview> {
  ctx.logger
    .debug`Previewing data delete: model=${input.modelIdOrName}, dataName=${input.dataName}`;
  const preview = await deps.preview(input.modelIdOrName, input.dataName);
  return {
    modelId: preview.modelId,
    modelName: preview.modelName,
    modelType: preview.modelType,
    dataName: preview.dataName,
    versionsCount: preview.versionsCount,
  };
}

/** Deletes a data instance (all versions, or a single version when set). */
export async function* dataDelete(
  ctx: LibSwampContext,
  deps: DataDeleteDeps,
  input: DataDeleteInput,
): AsyncIterable<DataDeleteEvent> {
  yield* withGeneratorSpan(
    "swamp.data.delete",
    {
      "data.name": input.dataName,
      "data.version": input.version ?? -1,
    },
    (async function* () {
      yield { kind: "deleting" };

      ctx.logger
        .debug`Deleting data: model=${input.modelIdOrName}, dataName=${input.dataName}, version=${input.version}`;

      let result: DeleteResult;
      try {
        result = await deps.delete(
          input.modelIdOrName,
          input.dataName,
          input.version,
        );
      } catch (error) {
        yield {
          kind: "error",
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      yield {
        kind: "completed",
        data: {
          modelId: result.modelId,
          modelName: result.modelName,
          modelType: result.modelType,
          dataName: result.dataName,
          version: result.version,
          versionsDeleted: result.versionsDeleted,
        },
      };
    })(),
  );
}
