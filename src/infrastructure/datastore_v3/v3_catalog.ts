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
import type { CatalogNameKey } from "../../domain/datastore_v3/recovery_scope.ts";
import { v3CatalogPath } from "./record_path_guard.ts";
import {
  type CatalogDataName,
  type CatalogDirtyPin,
  type CatalogRow,
  type CatalogRowKey,
  CatalogStore,
  type CatalogWriter,
} from "../persistence/catalog_store.ts";

/** a dirty name a commit not known to have landed holds */
export interface DirtyNamePin extends CatalogNameKey {
  readonly partition: string;
  readonly txnId: string;
}

/**
 * which catalog names a writer changed outside committed work, kept by
 * triggers; clearNames and forgetDirty join an open batch
 */
export interface CatalogDirtyTracking {
  ensureDirtyTracking(now: number): void;
  /** undefined when the triggers are missing */
  dirtyTrackingSince(): number | undefined;
  fullRecoveryRequired(): boolean;
  dirtyNames(): CatalogNameKey[];
  dirtyPins(): DirtyNamePin[];
  clearNames(
    names: readonly CatalogNameKey[],
    admits: (key: string) => boolean,
  ): void;
  forgetDirty(names: readonly CatalogNameKey[]): void;
  forgetAllDirty(): void;
  /** forgets every dirty name but those `pins` hold or held and did not land */
  releaseDirty(
    pins: readonly DirtyNamePin[],
    landed: readonly { readonly partition: string; readonly txnId: string }[],
  ): void;
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
  /** undefined for a catalog that keeps no record of uncommitted rows */
  dirtyTracking?(): CatalogDirtyTracking | undefined;
}

type HeldStep =
  | {
    readonly kind: "actions";
    readonly namespace: string;
    readonly partition: PartitionKey;
    readonly actions: readonly CatalogAction[];
  }
  | {
    readonly kind: "clear-names";
    readonly names: readonly CatalogNameKey[];
    readonly admits: (key: string) => boolean;
  }
  | {
    readonly kind: "forget-dirty";
    readonly names: readonly CatalogNameKey[];
  };

export class V3Catalog implements ReadModelCatalog, CatalogDirtyTracking {
  readonly #store: CatalogStore;
  #held: HeldStep[] | undefined;

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
    this.#hold({ kind: "actions", namespace, partition, actions });
  }

  #hold(step: HeldStep): void {
    if (this.#held !== undefined) {
      this.#held.push(step);
      return;
    }
    this.#applySteps([step]);
  }

  #applySteps(steps: readonly HeldStep[]): void {
    this.#store.applyInTransaction((writer) => {
      for (const step of steps) {
        switch (step.kind) {
          case "actions":
            applyActions(writer, step.namespace, step.partition, step.actions);
            break;
          case "clear-names":
            writer.clearNames(
              step.names.map(catalogDataName),
              (row) => step.admits(catalogRowRecordKey(row)),
            );
            break;
          case "forget-dirty":
            writer.forgetDirty(step.names.map(catalogDataName));
            break;
        }
      }
    }, { committed: true });
  }

  dirtyTracking(): CatalogDirtyTracking {
    return this;
  }

  ensureDirtyTracking(now: number): void {
    this.#store.ensureDirtyTracking(now);
  }

  dirtyTrackingSince(): number | undefined {
    return this.#store.dirtyTrackingSince();
  }

  fullRecoveryRequired(): boolean {
    return this.#store.fullRecoveryRequired();
  }

  dirtyNames(): CatalogNameKey[] {
    return this.#store.dirtyNames().map(catalogNameKey);
  }

  dirtyPins(): DirtyNamePin[] {
    return this.#store.dirtyPins().map((pin) => ({
      ...catalogNameKey(pin),
      partition: pin.partition,
      txnId: pin.txn_id,
    }));
  }

  clearNames(
    names: readonly CatalogNameKey[],
    admits: (key: string) => boolean,
  ): void {
    if (names.length === 0) return;
    this.#hold({ kind: "clear-names", names, admits });
  }

  forgetDirty(names: readonly CatalogNameKey[]): void {
    if (names.length === 0) return;
    this.#hold({ kind: "forget-dirty", names });
  }

  forgetAllDirty(): void {
    this.#store.forgetAllDirty();
  }

  releaseDirty(
    pins: readonly DirtyNamePin[],
    landed: readonly { readonly partition: string; readonly txnId: string }[],
  ): void {
    this.#store.releaseDirty(
      pins.map((pin): CatalogDirtyPin => ({
        ...catalogDataName(pin),
        partition: pin.partition,
        txn_id: pin.txnId,
      })),
      landed.map((l) => ({ partition: l.partition, txn_id: l.txnId })),
    );
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
    this.#applySteps(held);
  }

  rollbackBatch(): void {
    this.#held = undefined;
  }

  close(): void {
    this.#store.close();
  }
}

function catalogDataName(name: CatalogNameKey): CatalogDataName {
  return {
    namespace: name.namespace,
    type_normalized: name.type,
    model_id: name.modelId,
    data_name: name.name,
  };
}

function catalogNameKey(name: CatalogDataName): CatalogNameKey {
  return {
    namespace: name.namespace,
    type: name.type_normalized,
    modelId: name.model_id,
    name: name.data_name,
  };
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

  dirtyTracking(): CatalogDirtyTracking | undefined {
    return this.#inner.dirtyTracking?.();
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

/**
 * a merge or rename keeps file times, so the checkout's next recovery cannot
 * tell moved files from old ones and must replay every commit
 */
export function requireFullV3Recovery(repoDir: string): void {
  const path = v3CatalogPath(repoDir);
  try {
    Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  const catalog = V3Catalog.open(path);
  try {
    catalog.store.markFullRecoveryRequired();
  } finally {
    catalog.close();
  }
}
