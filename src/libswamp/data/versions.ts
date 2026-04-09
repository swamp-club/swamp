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

import type { Definition } from "../../domain/definitions/definition.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Version information for a single data entry. */
export interface DataVersionInfo {
  version: number;
  createdAt: string;
  size?: number;
  checksum?: string;
  isLatest: boolean;
}

/** Data payload for the completed event. */
export interface DataVersionsData {
  dataName: string;
  modelId: string;
  modelName: string;
  modelType: string;
  versions: DataVersionInfo[];
  total: number;
}

export type DataVersionsEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: DataVersionsData }
  | { kind: "error"; error: SwampError };

export interface DataVersionsInput {
  modelIdOrName: string;
  dataName: string;
}

/** Data entry with version metadata. */
interface DataEntry {
  version: number;
  createdAt: Date;
  size?: number;
  checksum?: string;
}

/** Dependencies for the data versions operation. */
export interface DataVersionsDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  listVersions: (
    type: ModelType,
    definitionId: string,
    dataName: string,
  ) => Promise<number[]>;
  findByName: (
    type: ModelType,
    definitionId: string,
    dataName: string,
    version: number,
  ) => Promise<DataEntry | null>;
}

/** Wires real infrastructure into DataVersionsDeps. */
export function createDataVersionsDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): DataVersionsDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
  );
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    listVersions: (type, definitionId, name) =>
      dataRepo.listVersions(type, definitionId, name),
    findByName: (type, definitionId, name, version) =>
      dataRepo.findByName(type, definitionId, name, version),
  };
}

/** Yields all versions of a specific data entry for a model. */
export async function* dataVersions(
  _ctx: LibSwampContext,
  deps: DataVersionsDeps,
  input: DataVersionsInput,
): AsyncIterable<DataVersionsEvent> {
  yield* withGeneratorSpan(
    "swamp.data.versions",
    { "data.name": input.dataName },
    (async function* () {
      yield { kind: "resolving" };

      const result = await deps.lookupDefinition(input.modelIdOrName);
      if (!result) {
        yield { kind: "error", error: notFound("Model", input.modelIdOrName) };
        return;
      }
      const { definition, type: modelType } = result;

      const versionNumbers = await deps.listVersions(
        modelType,
        definition.id,
        input.dataName,
      );

      if (versionNumbers.length === 0) {
        yield {
          kind: "error",
          error: notFound(
            "Data",
            `"${input.dataName}" for model "${input.modelIdOrName}"`,
          ),
        };
        return;
      }

      const versions: DataVersionInfo[] = [];
      const latestVersion = Math.max(...versionNumbers);

      for (const version of versionNumbers) {
        const data = await deps.findByName(
          modelType,
          definition.id,
          input.dataName,
          version,
        );
        if (data) {
          versions.push({
            version: data.version,
            createdAt: data.createdAt.toISOString(),
            size: data.size,
            checksum: data.checksum,
            isLatest: version === latestVersion,
          });
        }
      }

      // Sort versions descending (newest first)
      versions.sort((a, b) => b.version - a.version);

      yield {
        kind: "completed",
        data: {
          dataName: input.dataName,
          modelId: definition.id,
          modelName: definition.name,
          modelType: modelType.normalized,
          versions,
          total: versions.length,
        },
      };
    })(),
  );
}
