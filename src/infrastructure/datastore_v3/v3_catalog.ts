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
  /**
   * forgets every dirty name but those `pins` hold or held and did not land,
   * and every touched scope but those of `keepUnits`
   */
  releaseDirty(
    pins: readonly DirtyNamePin[],
    landed: readonly { readonly partition: string; readonly txnId: string }[],
    keepUnits?: readonly string[],
    instance?: string,
  ): void;
  ensureTouchedTracking(now: number): void;
  /** undefined when the table is missing */
  touchedTrackingSince(): number | undefined;
  touchedScopes(): TouchedScope[];
  forgetTouched(ids: readonly number[]): void;
}

/** a path a unit recorded before writing under it, as a record key */
export interface TouchedScope {
  readonly id: number;
  readonly unitId: string;
  readonly namespace: string;
  readonly scope: string;
  /** the writer's token; empty for an older swamp's rows */
  readonly instance: string;
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
  /** clear in several transactions, awaiting between before each after the first */
  clearInSlices?(
    admits: (key: string) => boolean,
    between: () => Promise<void>,
    sliceMs: number,
  ): Promise<number>;
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
  /**
   * commitBatch in several transactions, awaiting between before each after
   * the first; each name's rows change in one of them, and a crash part way
   * leaves the names dirty for the next recovery
   */
  commitBatchInSlices?(
    between: () => Promise<void>,
    sliceMs: number,
  ): Promise<void>;
  rollbackBatch(): void;
  close(): void;
  /** undefined for a catalog that keeps no record of uncommitted rows */
  dirtyTracking?(): CatalogDirtyTracking | undefined;
}

/** past this many version rows a reconcile is split by name across transactions */
export const RECONCILE_ROWS_PER_TRANSACTION = 1_000;

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

export interface V3CatalogOptions {
  readonly reconcileRowsPerTransaction?: number;
  readonly clearRowsPerPage?: number;
}

export class V3Catalog implements ReadModelCatalog, CatalogDirtyTracking {
  readonly #store: CatalogStore;
  readonly #rowsPerTransaction: number;
  readonly #clearRowsPerPage: number | undefined;
  #held: HeldStep[] | undefined;

  constructor(store: CatalogStore, options: V3CatalogOptions = {}) {
    this.#store = store;
    this.#rowsPerTransaction = options.reconcileRowsPerTransaction ??
      RECONCILE_ROWS_PER_TRANSACTION;
    this.#clearRowsPerPage = options.clearRowsPerPage;
  }

  static open(path: string, options: V3CatalogOptions = {}): V3Catalog {
    return new V3Catalog(new CatalogStore(path), options);
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

  clearInSlices(
    admits: (key: string) => boolean,
    between: () => Promise<void>,
    sliceMs: number,
  ): Promise<number> {
    return this.#store.clearRowsInSlices(
      (row) => admits(catalogRowRecordKey(row)),
      between,
      sliceMs,
      this.#clearRowsPerPage,
    );
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
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        if (step.kind === "clear-names") {
          const replays = replaysOf(steps, index + 1, step.names);
          if (replays.length > 0) {
            writer.reconcileNames(
              step.names.map(catalogDataName),
              (row) => step.admits(catalogRowRecordKey(row)),
              (scratch) => {
                for (const replay of replays) {
                  applyActions(
                    scratch,
                    replay.namespace,
                    replay.partition,
                    replay.actions,
                  );
                }
              },
            );
            index += replays.length;
            continue;
          }
        }
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
    keepUnits: readonly string[] = [],
    instance?: string,
  ): void {
    this.#store.releaseDirty(
      pins.map((pin): CatalogDirtyPin => ({
        ...catalogDataName(pin),
        partition: pin.partition,
        txn_id: pin.txnId,
      })),
      landed.map((l) => ({ partition: l.partition, txn_id: l.txnId })),
      keepUnits,
      instance,
    );
  }

  ensureTouchedTracking(now: number): void {
    this.#store.ensureTouchedTracking(now);
  }

  touchedTrackingSince(): number | undefined {
    return this.#store.touchedTrackingSince();
  }

  touchedScopes(): TouchedScope[] {
    return this.#store.touchedScopes().map((row) => ({
      id: row.id,
      unitId: row.unit_id,
      namespace: row.namespace,
      scope: row.scope,
      instance: row.instance,
    }));
  }

  forgetTouched(ids: readonly number[]): void {
    this.#store.forgetTouched(ids);
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

  async commitBatchInSlices(
    between: () => Promise<void>,
    sliceMs: number,
  ): Promise<void> {
    const held = this.#held;
    if (held === undefined) throw new Error("No catalog batch is open");
    this.#held = undefined;
    if (held.length === 0) return;
    const writes = this.#writes(held);
    let next = 0;
    while (next < writes.length) {
      if (next > 0) await between();
      this.#store.applyInTransaction((writer) => {
        const until = performance.now() + sliceMs;
        do {
          writes[next++](writer);
        } while (next < writes.length && performance.now() < until);
      }, { committed: true });
    }
  }

  /**
   * the steps in order, a reconcile split into bounded groups of names; each
   * write lands whole in one transaction
   */
  #writes(
    steps: readonly HeldStep[],
  ): ((writer: CatalogWriter) => void)[] {
    const writes: ((writer: CatalogWriter) => void)[] = [];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (step.kind === "clear-names") {
        const replays = replaysOf(steps, index + 1, step.names);
        if (replays.length > 0) {
          const admits = (row: CatalogRowKey) =>
            step.admits(catalogRowRecordKey(row));
          const held = this.#store.versionRowCounts(
            step.names.map(catalogDataName),
          );
          const replayed = replayedPerName(replays);
          // a group holds the larger of what its names hold and what they replay
          const counts = step.names.map((name, at) =>
            Math.max(held[at], replayed.get(nameIdentity(name)) ?? 0)
          );
          for (
            const group of groupsOf(
              step.names,
              counts,
              this.#rowsPerTransaction,
            )
          ) {
            const kept = new Set(group.names.map(nameIdentity));
            writes.push((writer) =>
              writer.reconcileNames(
                group.names.map(catalogDataName),
                admits,
                (scratch) => {
                  for (const replay of replays) {
                    applyActions(
                      scratch,
                      replay.namespace,
                      replay.partition,
                      actionsOf(replay, kept),
                    );
                  }
                },
              )
            );
          }
          index += replays.length;
          continue;
        }
      }
      switch (step.kind) {
        case "actions":
          writes.push(
            (writer) =>
              applyActions(
                writer,
                step.namespace,
                step.partition,
                step.actions,
              ),
          );
          break;
        case "clear-names":
          writes.push(
            (writer) =>
              writer.clearNames(
                step.names.map(catalogDataName),
                (row) => step.admits(catalogRowRecordKey(row)),
              ),
          );
          break;
        case "forget-dirty":
          writes.push(
            (writer) => writer.forgetDirty(step.names.map(catalogDataName)),
          );
          break;
      }
    }
    return writes;
  }

  rollbackBatch(): void {
    this.#held = undefined;
  }

  close(): void {
    this.#store.close();
  }
}

/** names in order, grouped up to the row bound; a bigger name stands alone */
function groupsOf(
  names: readonly CatalogNameKey[],
  counts: readonly number[],
  bound: number,
): { names: CatalogNameKey[]; rows: number }[] {
  const groups: { names: CatalogNameKey[]; rows: number }[] = [];
  let current: { names: CatalogNameKey[]; rows: number } | undefined;
  for (const [index, name] of names.entries()) {
    const rows = Math.max(1, counts[index]);
    if (
      current === undefined ||
      current.rows + rows > bound
    ) {
      current = { names: [], rows: 0 };
      groups.push(current);
    }
    current.names.push(name);
    current.rows += rows;
  }
  return groups;
}

function replayedPerName(replays: readonly ActionsStep[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const replay of replays) {
    const identity = replay.partition.identity;
    if (identity.kind !== "model") continue;
    for (const action of replay.actions) {
      const name = nameIdentity({
        namespace: replay.namespace,
        type: identity.type,
        modelId: identity.id,
        name: action.kind === "upsert-version"
          ? action.metadata.name
          : action.name,
      });
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

function actionsOf(
  replay: ActionsStep,
  kept: ReadonlySet<string>,
): CatalogAction[] {
  const identity = replay.partition.identity;
  if (identity.kind !== "model") return [];
  return replay.actions.filter((action) =>
    kept.has(nameIdentity({
      namespace: replay.namespace,
      type: identity.type,
      modelId: identity.id,
      name: action.kind === "upsert-version"
        ? action.metadata.name
        : action.name,
    }))
  );
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

type ActionsStep = Extract<HeldStep, { kind: "actions" }>;

/** the actions steps right after a clear that touch only the names it clears */
function replaysOf(
  steps: readonly HeldStep[],
  from: number,
  names: readonly CatalogNameKey[],
): ActionsStep[] {
  const cleared = new Set(names.map(nameIdentity));
  const replays: ActionsStep[] = [];
  for (let index = from; index < steps.length; index++) {
    const step = steps[index];
    if (step.kind !== "actions") break;
    const identity = step.partition.identity;
    if (identity.kind !== "model") return [];
    for (const action of step.actions) {
      const name = action.kind === "upsert-version"
        ? action.metadata.name
        : action.name;
      const key = nameIdentity({
        namespace: step.namespace,
        type: identity.type,
        modelId: identity.id,
        name,
      });
      if (!cleared.has(key)) return [];
    }
    replays.push(step);
  }
  return replays;
}

function nameIdentity(name: CatalogNameKey): string {
  return [name.namespace, name.type, name.modelId, name.name].join(
    "\0",
  );
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
  // names this apply removed and has written no row of since
  const emptied = new Set<string>();
  for (let at = 0; at < actions.length; at++) {
    const action = actions[at];
    switch (action.kind) {
      case "upsert-version": {
        const name = action.metadata.name;
        if (!emptied.delete(name)) {
          writer.upsertNewVersion(
            catalogRow(namespace, type, modelId, action.metadata),
          );
          break;
        }
        const rows = [catalogRow(namespace, type, modelId, action.metadata)];
        for (;;) {
          const next = actions[at + 1];
          if (next?.kind !== "upsert-version" || next.metadata.name !== name) {
            break;
          }
          rows.push(catalogRow(namespace, type, modelId, next.metadata));
          at++;
        }
        writer.insertNameRows(rows, computeLatestFlags);
        break;
      }
      case "remove-version":
        emptied.delete(action.name);
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
        emptied.add(action.name);
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

  clearInSlices(
    admits: (key: string) => boolean,
    between: () => Promise<void>,
    sliceMs: number,
  ): Promise<number> {
    if (this.#inner.clearInSlices === undefined) {
      return Promise.resolve(this.#inner.clear(admits));
    }
    return this.#inner.clearInSlices(admits, between, sliceMs);
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

  commitBatchInSlices(
    between: () => Promise<void>,
    sliceMs: number,
  ): Promise<void> {
    if (this.#inner.commitBatchInSlices === undefined) {
      this.#inner.commitBatch();
      return Promise.resolve();
    }
    return this.#inner.commitBatchInSlices(between, sliceMs);
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
