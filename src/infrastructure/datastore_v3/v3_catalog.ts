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
 * kept apart from _catalog.db so no v2 code changes; rows are built field for
 * field as v2's catalogUpsert builds them, and an integration oracle test
 * compares them with the rows v2 writes
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
  type CatalogWriter,
} from "../persistence/catalog_store.ts";

export interface PendingCatalogName {
  readonly namespace: string;
  readonly type: string;
  readonly id: string;
  readonly name: string;
}

export interface ReadModelCatalog {
  generation(): number;
  /**
   * true once the read model has taken the catalog over at its generation; a
   * catalog file created afresh is not, though its generation can equal the one
   * the state recorded
   */
  isPopulated(): boolean;
  markPopulated(generation: number): void;
  /**
   * deletes the rows of data whose keys admits admits (commits carry them, a
   * replay rebuilds them) and advances the generation, keeping the populated
   * mark and the rows of data the datastore keeps local
   */
  clear(admits: (key: string) => boolean): number;
  /**
   * the data names with a pending row: a streaming write registers one before
   * any file reaches disk, so a killed writer can leave a row with no file
   */
  pendingNames?(): PendingCatalogName[] | undefined;
  apply(
    namespace: string,
    partition: PartitionKey,
    actions: readonly CatalogAction[],
  ): void;
  /**
   * the actions of every apply until commitBatch land in one transaction, which
   * the read model commits with a page's state once the page's files are
   * written
   */
  beginBatch(): void;
  commitBatch(): void;
  rollbackBatch(): void;
  close(): void;
}

interface HeldActions {
  readonly namespace: string;
  readonly partition: PartitionKey;
  readonly actions: readonly CatalogAction[];
}

export class V3Catalog implements ReadModelCatalog {
  readonly #store: CatalogStore;
  #held: HeldActions[] | undefined;

  constructor(store: CatalogStore) {
    this.#store = store;
  }

  static open(path: string): V3Catalog {
    return new V3Catalog(new CatalogStore(path));
  }

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

  pendingNames(): PendingCatalogName[] {
    const names = new Map<string, PendingCatalogName>();
    for (const row of this.#store.iterateFiltered("is_pending = 1", [])) {
      names.set(
        JSON.stringify([
          row.namespace,
          row.type_normalized,
          row.model_id,
          row.data_name,
        ]),
        {
          namespace: row.namespace,
          type: row.type_normalized,
          id: row.model_id,
          name: row.data_name,
        },
      );
    }
    return [...names.values()];
  }

  apply(
    namespace: string,
    partition: PartitionKey,
    actions: readonly CatalogAction[],
  ): void {
    if (actions.length === 0) return;
    if (partition.identity.kind !== "model") {
      throw new Error(
        `Catalog actions need a model partition, not ${partition}`,
      );
    }
    if (this.#held !== undefined) {
      this.#held.push({ namespace, partition, actions });
      return;
    }
    applyActions(this.#store, namespace, partition, actions);
  }

  beginBatch(): void {
    if (this.#held !== undefined) {
      throw new Error("A catalog batch is open");
    }
    this.#held = [];
  }

  commitBatch(): void {
    const held = this.#held;
    if (held === undefined) throw new Error("No catalog batch is open");
    this.#held = undefined;
    if (held.length === 0) return;
    this.#store.applyInTransaction((writer) => {
      for (const { namespace, partition, actions } of held) {
        applyActions(writer, namespace, partition, actions);
      }
    });
  }

  rollbackBatch(): void {
    this.#held = undefined;
  }

  close(): void {
    this.#store.close();
  }
}

function applyActions(
  writer: CatalogWriter,
  namespace: string,
  partition: PartitionKey,
  actions: readonly CatalogAction[],
): void {
  const identity = partition.identity;
  if (identity.kind !== "model") {
    throw new Error(`Catalog actions need a model partition, not ${partition}`);
  }
  const type = identity.type;
  const modelId = identity.id;
  for (const action of actions) {
    switch (action.kind) {
      case "upsert-version":
        writer.upsertNewVersion(
          catalogRow(namespace, type, modelId, action.metadata),
        );
        break;
      case "remove-version":
        writer.removeVersion(
          namespace,
          type,
          modelId,
          action.name,
          action.version,
          computeLatestFlags,
        );
        break;
      case "remove-name":
        writer.remove(namespace, type, modelId, action.name);
        break;
      case "forward":
        writer.recordRename({
          namespace,
          type_normalized: type,
          model_id: modelId,
          data_name: action.name,
          renamed_to: action.to,
        });
        break;
      case "end-forward":
        writer.removeRename(namespace, type, modelId, action.name);
        break;
    }
  }
}

/**
 * drops actions on data the checkout never projects, judged for every kind, so
 * another checkout's commit can neither add, change nor remove a row this
 * checkout keeps for itself
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

  pendingNames(): PendingCatalogName[] | undefined {
    return this.#inner.pendingNames?.();
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

  beginBatch(): void {
    this.#inner.beginBatch();
  }

  commitBatch(): void {
    this.#inner.commitBatch();
  }

  rollbackBatch(): void {
    this.#inner.rollbackBatch();
  }

  close(): void {
    this.#inner.close();
  }
}

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

export function catalogRowRecordKey(row: CatalogRowKey): string {
  const name = `data/${row.type_normalized}/${row.model_id}/${row.data_name}`;
  return row.version === undefined
    ? `${name}/latest`
    : `${name}/${row.version}/metadata.yaml`;
}
