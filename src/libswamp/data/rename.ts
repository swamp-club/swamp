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
  DataRenameService,
  type RenameResult,
} from "../../domain/data/data_rename_service.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the data rename output.
 */
export interface DataRenameData {
  oldName: string;
  newName: string;
  modelId: string;
  modelName: string;
  modelType: string;
  copiedVersion: number;
  newVersion: number;
  warning: string;
}

export type DataRenameEvent =
  | { kind: "renaming" }
  | { kind: "completed"; data: DataRenameData }
  | { kind: "error"; error: SwampError };

/** Input for the data rename operation. */
export interface DataRenameInput {
  modelIdOrName: string;
  oldName: string;
  newName: string;
}

/** Dependencies for the data rename operation. */
export interface DataRenameDeps {
  rename: (
    modelIdOrName: string,
    oldName: string,
    newName: string,
  ) => Promise<RenameResult>;
}

/** Wires real infrastructure into DataRenameDeps. */
export function createDataRenameDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): DataRenameDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
  );
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const service = new DataRenameService(dataRepo, definitionRepo);
  return {
    rename: (modelIdOrName, oldName, newName) =>
      service.rename(modelIdOrName, oldName, newName),
  };
}

/** Renames a data instance with backwards-compatible forwarding. */
export async function* dataRename(
  ctx: LibSwampContext,
  deps: DataRenameDeps,
  input: DataRenameInput,
): AsyncIterable<DataRenameEvent> {
  yield* withGeneratorSpan(
    "swamp.data.rename",
    { "data.old_name": input.oldName, "data.new_name": input.newName },
    (async function* () {
      yield { kind: "renaming" };

      ctx.logger
        .debug`Renaming data: model=${input.modelIdOrName}, ${input.oldName} -> ${input.newName}`;

      // Validate names are different
      if (input.oldName === input.newName) {
        yield {
          kind: "error",
          error: validationFailed(
            "Old name and new name must be different.",
          ),
        };
        return;
      }

      let result: RenameResult;
      try {
        result = await deps.rename(
          input.modelIdOrName,
          input.oldName,
          input.newName,
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

      const data: DataRenameData = {
        oldName: result.oldName,
        newName: result.newName,
        modelId: result.modelId,
        modelName: result.modelName,
        modelType: result.modelType,
        copiedVersion: result.copiedVersion,
        newVersion: result.newVersion,
        warning:
          `Any workflows or models that produce data under "${result.oldName}" ` +
          `will overwrite the forward reference. Update them to use "${result.newName}" instead.`,
      };

      yield { kind: "completed", data };
    })(),
  );
}
