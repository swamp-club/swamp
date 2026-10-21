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
import {
  type CatalogRow,
  type CatalogRowKey,
  CatalogStore,
} from "../persistence/catalog_store.ts";

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
  /**
   * Deletes the rows of the data whose record keys `admits` admits, which
   * commits carry and a replay rebuilds, and advances the generation,
   * keeping the populated mark and the rows of data the datastore keeps
   * local; resolves with the new generation (swamp-club#3299).
   */
  clear(admits: (key: string) => boolean): number;
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

  clear(admits: (key: string) => boolean): number {
    return this.#store.clearRows((row) => admits(catalogRowRecordKey(row)));
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

/**
 * The read model's catalog with the actions on data it never projects
 * dropped (swamp-club#3691): `skips(namespace, recordKey)` names them, by
 * the record key each action's row maps to ({@link catalogRowRecordKey}; a
 * name-wide action maps to the name's latest marker). Every kind of action
 * is judged, so another checkout's commit can neither add, change nor
 * remove a row this checkout keeps for itself. One wrapper covers both the
 * commits the read model applies and the compacted base it loads.
 */
export class ProjectedCatalog implements ReadModelCatalog {
  readonly #inner: ReadModelCatalog;
  readonly #skips: (namespace: string, recordKey: string) => boolean;

  constructor(
    inner: ReadModelCatalog,
    skips: (namespace: string, recordKey: string) => boolean,
  ) {
    this.#inner = inner;
    this.#skips = skips;
  }

  generation(): number {
    return this.#inner.generation();
  }

  isPopulated(): boolean {
    return this.#inner.isPopulated();
  }

  markPopulated(generation: number): void {
    this.#inner.markPopulated(generation);
  }

  clear(admits: (key: string) => boolean): number {
    return this.#inner.clear(admits);
  }

  apply(
    namespace: string,
    partition: PartitionKey,
    actions: readonly CatalogAction[],
  ): void {
    const identity = partition.identity;
    // The inner catalog refuses actions on any other partition.
    if (identity.kind !== "model") {
      this.#inner.apply(namespace, partition, actions);
      return;
    }
    this.#inner.apply(
      namespace,
      partition,
      actions.filter((action) =>
        !this.#skips(
          namespace,
          catalogRowRecordKey(
            catalogActionRowKey(namespace, identity.type, identity.id, action),
          ),
        )
      ),
    );
  }

  close(): void {
    this.#inner.close();
  }
}

/** The catalog row, or rows of a name, a catalog action changes. */
function catalogActionRowKey(
  namespace: string,
  typeNormalized: string,
  modelId: string,
  action: CatalogAction,
): CatalogRowKey {
  const row = { namespace, type_normalized: typeNormalized, model_id: modelId };
  switch (action.kind) {
    case "upsert-version":
      return {
        ...row,
        data_name: action.metadata.name,
        version: action.metadata.version,
      };
    case "remove-version":
      return { ...row, data_name: action.name, version: action.version };
    case "remove-name":
    case "forward":
    case "end-forward":
      return { ...row, data_name: action.name };
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
    lifecycle: data.lifecycle,
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

/**
 * The record key a catalog row's data lives under: its version's metadata,
 * or for a rename row (no version), the name's latest marker.
 */
export function catalogRowRecordKey(row: CatalogRowKey): string {
  const name = `data/${row.type_normalized}/${row.model_id}/${row.data_name}`;
  return row.version === undefined
    ? `${name}/latest`
    : `${name}/${row.version}/metadata.yaml`;
}
