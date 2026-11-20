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

import type { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import {
  ambiguousBehavior,
  behaviorNotFound,
  type SwampError,
} from "../errors.ts";
import { selectLookup } from "../lookup_by_id.ts";

export interface RecordedDataOwner {
  readonly modelType: string;
  readonly modelId: string;
  readonly modelName: string;
}

export interface DataOwnerLookupDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  lookupDefinitionById?: (
    id: string,
    expectedName?: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findRecordedOwners?: (
    idOrName: string,
    dataName?: string,
  ) => Promise<readonly RecordedDataOwner[]>;
}

export interface DataOwnerLookupInput {
  modelIdOrName: string;
  byId?: boolean;
  expectedName?: string;
  /** an owner the caller already found and authorized; read it and nothing else */
  recordedOwner?: RecordedDataOwner;
  dataName?: string;
}

export type DataOwnerResolution =
  | { kind: "found"; modelType: ModelType; modelId: string; modelName: string }
  | { kind: "error"; error: SwampError };

/** absent without a catalog: the fallback reads only what the catalog records */
export function recordedOwnerFinder(
  catalogStore: CatalogStore | undefined,
  dataRepo: UnifiedDataRepository,
): DataOwnerLookupDeps["findRecordedOwners"] {
  if (!catalogStore) return undefined;
  const service = new DataQueryService(catalogStore, dataRepo);
  return (idOrName, dataName) => service.findRecordedOwners(idOrName, dataName);
}

/**
 * the definition decides when it exists; otherwise the owner the catalog
 * records, refused when the name matches several, so a read never guesses
 */
export async function resolveDataOwner(
  operation: string,
  deps: DataOwnerLookupDeps,
  input: DataOwnerLookupInput,
): Promise<DataOwnerResolution> {
  if (input.recordedOwner) {
    return {
      kind: "found",
      modelType: ModelType.create(input.recordedOwner.modelType),
      modelId: input.recordedOwner.modelId,
      modelName: input.recordedOwner.modelName,
    };
  }
  const lookup = selectLookup(
    operation,
    input.byId,
    deps.lookupDefinition,
    deps.lookupDefinitionById,
    input.expectedName,
  );
  const result = await lookup(input.modelIdOrName);
  if (result) {
    return {
      kind: "found",
      modelType: result.type,
      modelId: result.definition.id,
      modelName: result.definition.name,
    };
  }
  // a by-id read acts only on what the caller authorized, never on a fallback
  if (input.byId || !deps.findRecordedOwners) {
    return { kind: "error", error: behaviorNotFound(input.modelIdOrName) };
  }
  const owners = await deps.findRecordedOwners(
    input.modelIdOrName,
    input.dataName,
  );
  if (owners.length === 0) {
    return { kind: "error", error: behaviorNotFound(input.modelIdOrName) };
  }
  if (owners.length > 1) {
    return {
      kind: "error",
      error: ambiguousBehavior(input.modelIdOrName, owners),
    };
  }
  return {
    kind: "found",
    modelType: ModelType.create(owners[0].modelType),
    modelId: owners[0].modelId,
    modelName: owners[0].modelName,
  };
}
