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
 * The v3 data catalog (swamp-club#3239): `_catalog_v3.db`, kept apart from
 * `_catalog.db` so no v2 code changes. It is opened with the existing
 * {@link CatalogStore}, unchanged, so it has the schema and query API data
 * query already uses; switching data query to it is the opt-in's job.
 *
 * Rows are built from a version's metadata field for field as the v2
 * repository builds them (`catalogUpsert` in `unified_data_repository.ts`),
 * with the model type and id taken from the commit's partition key and the
 * namespace from the commit.
 * `integration/datastore_v3_read_model_v2_oracle_test.ts` compares them with
 * the rows v2 writes.
 *
 * @module
 */

import type { CatalogAction } from "../../domain/datastore_v3/catalog_projection.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import { Data } from "../../domain/data/data.ts";
import {
  type DataMetadata,
  garbageCollectionToColumn,
} from "../../domain/data/data_metadata.ts";
import { computeLatestFlags } from "../../domain/data/data_query_service.ts";
import { type CatalogRow, CatalogStore } from "../persistence/catalog_store.ts";

/** The catalog the read model writes. {@link V3Catalog} is the real one. */
export interface ReadModelCatalog {
  /**
   * The catalog's generation. It changes when the catalog is rebuilt empty
   * (a schema change) or invalidated.
   */
  generation(): number;
  /**
   * True once the read model has taken the catalog over at its generation.
   * A catalog file created afresh (deleted, or rebuilt) is not, though its
   * generation can equal the one the state recorded.
   */
  isPopulated(): boolean;
  /** Records that the read model owns the catalog at `generation`. */
  markPopulated(generation: number): void;
  /** Applies one commit's catalog actions, in order, on a model partition. */
  apply(
    namespace: string,
    partition: PartitionKey,
    actions: readonly CatalogAction[],
  ): void;
  close(): void;
}

/** The v3 catalog over {@link CatalogStore}. */
export class V3Catalog implements ReadModelCatalog {
  readonly #store: CatalogStore;

  constructor(store: CatalogStore) {
    this.#store = store;
  }

  /** Opens `_catalog_v3.db` at `path`, creating it when absent. */
  static open(path: string): V3Catalog {
    return new V3Catalog(new CatalogStore(path));
  }

  /** The underlying store, for reading rows back. */
  get store(): CatalogStore {
    return this.#store;
  }

  generation(): number {
    return this.#store.generation();
  }

  isPopulated(): boolean {
    return this.#store.isPopulated();
  }

  markPopulated(generation: number): void {
    this.#store.markPopulated(generation);
  }

  apply(
    namespace: string,
    partition: PartitionKey,
    actions: readonly CatalogAction[],
  ): void {
    if (actions.length === 0) return;
    const identity = partition.identity;
    if (identity.kind !== "model") {
      throw new Error(
        `Catalog actions need a model partition, not ${partition}`,
      );
    }
    const type = identity.type;
    const modelId = identity.id;
    for (const action of actions) {
      switch (action.kind) {
        case "upsert-version":
          this.#store.upsertNewVersion(
            catalogRow(namespace, type, modelId, action.metadata),
          );
          break;
        case "remove-version":
          this.#store.removeVersion(
            namespace,
            type,
            modelId,
            action.name,
            action.version,
            computeLatestFlags,
          );
          break;
        case "remove-name":
          this.#store.remove(namespace, type, modelId, action.name);
          break;
        case "forward":
          this.#store.recordRename({
            namespace,
            type_normalized: type,
            model_id: modelId,
            data_name: action.name,
            renamed_to: action.to,
          });
          break;
        case "end-forward":
          this.#store.removeRename(namespace, type, modelId, action.name);
          break;
      }
    }
  }

  close(): void {
    this.#store.close();
  }
}

/** A version's catalog row, as the v2 repository's `catalogUpsert` builds it. */
export function catalogRow(
  namespace: string,
  typeNormalized: string,
  modelId: string,
  metadata: DataMetadata,
): CatalogRow {
  const data = Data.fromData(metadata);
  return {
    namespace,
    type_normalized: typeNormalized,
    model_id: modelId,
    data_name: data.name,
    id: data.id,
    version: data.version,
    is_latest: 1,
    is_step_latest: 1,
    model_name: data.tags["modelName"] ?? "",
    spec_name: data.tags["specName"] ?? "",
    data_type: data.tags["type"] ?? "",
    content_type: data.contentType,
    lifetime: data.lifetime,
    garbage_collection: garbageCollectionToColumn(data.garbageCollection),
    owner_type: data.ownerDefinition.ownerType,
    streaming: data.streaming ? 1 : 0,
    size: data.size ?? 0,
    created_at: data.createdAt.toISOString(),
    tags: JSON.stringify(data.tags),
    owner_ref: data.ownerDefinition.ownerRef,
    workflow_run_id: data.ownerDefinition.workflowRunId ?? "",
    workflow_name: data.ownerDefinition.workflowName ?? "",
    job_name: data.ownerDefinition.jobName ?? "",
    step_name: data.ownerDefinition.stepName ?? "",
    source: data.ownerDefinition.source ?? "",
  };
}
