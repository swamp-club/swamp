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

import { getLogger } from "@logtape/logtape";
import { Environment } from "cel-js";
import { coerceBigInts } from "../../infrastructure/cel/cel_evaluator.ts";
import type {
  CatalogRow,
  CatalogSortOrder,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import { UserError } from "../errors.ts";
import {
  type QueryCursorPosition,
  type QuerySort,
  querySortTagKey,
} from "./query_sort.ts";
import { isUnreadableContentError } from "../datastore/unreadable_content.ts";
import {
  type ContentAvailability,
  type ForeignContentFetcher,
  isForeignNamespace,
  type RenameForward,
  type UnifiedDataRepository,
} from "./repositories.ts";

export type { ForeignContentFetcher };
import type { DataRecord } from "./data_record.ts";
import {
  type ASTNode,
  buildSpecNameFallback,
  calledModelFunctions,
  collectLatestRunWorkflows,
  collectModelReferences,
  collectRootIdentifiers,
  extractModelCall,
  extractModelNameEquality,
  extractStringEquality,
  extractTypeTagEquality,
  extractWorkflowRunIdLatestRun,
  HISTORY_OPT_IN_FIELDS,
  LATEST_RUN_FUNCTION,
  MODEL_FUNCTION,
  MODEL_FUNCTIONS,
  referencesAttributes,
  referencesContent,
  selectReadsContent,
  type SpecNameFallback,
  validateFieldReferences,
} from "./query_predicate.ts";
import { isJsonMediaType, isTextContentType } from "./content_type.ts";
import {
  type QueryProgram,
  type QueryView,
  QueryViewRefusal,
} from "./query_view.ts";
import { type ContentEncoding, encodeContent } from "./content_encoding.ts";
import { BinaryContentPredicateError } from "./binary_content_predicate_error.ts";
import { ModelType } from "../models/model_type.ts";
import type { Data } from "./data.ts";
import { fromRow } from "./data_record_mapper.ts";
import { garbageCollectionToColumn } from "./data_metadata.ts";

export { type QueryProgram, type QueryView, QueryViewRefusal };

const logger = getLogger(["swamp", "domain", "data", "query"]);

function modelUnavailable(ast: ASTNode): UserError {
  const fn = modelFunctionAsTyped(ast);
  const noun = fn === MODEL_FUNCTION ? "model" : "behavior";
  return new UserError(
    `${fn}() is only available in swamp data query; ` +
      `here, match the ${noun} with modelId and modelType, e.g. ` +
      `modelId == "<definition id>"`,
  );
}

function modelFunctionAsTyped(ast: ASTNode): string {
  const called = calledModelFunctions(ast);
  return called.length === 1 ? called[0] : MODEL_FUNCTION;
}

const MAX_RENAME_HOPS = 5;

function renameKey(namespace: string, type: string, modelId: string): string {
  return `${namespace}\0${type}\0${modelId}`;
}

function collectModelReferencesLenient(selectAst: ASTNode): boolean {
  try {
    return collectModelReferences(selectAst).length > 0;
  } catch {
    // A malformed model() call is still a model() call.
    return true;
  }
}

function latestRunUnavailable(): UserError {
  return new UserError(
    `${LATEST_RUN_FUNCTION}() is only available in swamp data query; ` +
      `here, compare workflowRunId with the run id as a string, e.g. ` +
      `workflowRunId == "<run-id>"`,
  );
}

/**
 * mirrors CatalogStore.upsertNewVersion: is_latest is the highest version per
 * group; model-method rows keep is_step_latest only at the top, step rows per
 * step_name above the top model-method version
 */
export function computeLatestFlags(rows: CatalogRow[]): void {
  const groups = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const key =
      `${row.namespace}\0${row.type_normalized}\0${row.model_id}\0${row.data_name}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(row);
  }

  for (const group of groups.values()) {
    let overallMax = -1;
    let globalMax = -1;
    for (const row of group) {
      if (row.version > overallMax) overallMax = row.version;
      if (row.step_name === "" && row.version > globalMax) {
        globalMax = row.version;
      }
    }

    const maxVersionPerStep = new Map<string, number>();
    for (const row of group) {
      if (row.step_name !== "" && row.version < globalMax) continue;
      if (row.step_name !== "") {
        const cur = maxVersionPerStep.get(row.step_name);
        if (cur === undefined || row.version > cur) {
          maxVersionPerStep.set(row.step_name, row.version);
        }
      }
    }

    for (const row of group) {
      row.is_latest = row.version === overallMax ? 1 : 0;
      if (row.step_name === "") {
        row.is_step_latest = row.version === overallMax ? 1 : 0;
      } else if (row.version < globalMax) {
        row.is_step_latest = 0;
      } else {
        const maxForStep = maxVersionPerStep.get(row.step_name);
        row.is_step_latest = row.version === maxForStep ? 1 : 0;
      }
    }
  }
}

export type LatestWorkflowRunResolver = (
  workflow: string,
) => Promise<string | null>;

type LatestRuns = ReadonlyMap<string, string | null>;

const NO_LATEST_RUNS: LatestRuns = new Map();

export interface ResolvedModelReference {
  modelType: string;
  modelId: string;
}

export type ModelReferenceResolver = (
  idOrName: string,
) => Promise<ResolvedModelReference>;

type ResolvedModels = ReadonlyMap<string, ResolvedModelReference>;

const NO_MODELS: ResolvedModels = new Map();

export interface DataQueryOptions {
  limit?: number;
  select?: string;
  loadAttributes?: boolean;
  /**
   * only findBySpec and findByTag set this, so every step's output stays
   * visible; records of an older step's latest report isLatest: false
   */
  latestPerStep?: boolean;
  /**
   * off by default so predicates and projections see an empty path; only the
   * CEL data.* namespace opts in, never results that leave the process (serve,
   * workers)
   */
  includeContentPath?: boolean;
  /**
   * Keeps only the matched records this accepts, before any projection, so
   * a projected result never carries a record the caller may not read.
   */
  include?: (record: DataRecord) => Promise<boolean>;
  /**
   * compared as stored strings, so pass every stored form (bare and
   * @-prefixed); the CEL data.* namespace passes control-plane types so
   * expressions can never read those records
   */
  excludeModelTypes?: readonly string[];
  /**
   * passed per call so each caller decides whose workflows may be resolved;
   * without it a query that calls latestRun fails
   */
  latestRunResolver?: LatestWorkflowRunResolver;
  /**
   * passed per call so each caller decides whose models may be resolved;
   * without it a query that calls model fails
   */
  modelResolver?: ModelReferenceResolver;
  /**
   * expression-facing view: tagged sensitive fields read as Secrets and a
   * refusal propagates as QueryViewRefusal; absent on every other path, which
   * reads records as stored
   */
  view?: QueryView;
  sort?: QuerySort;
  after?: QueryCursorPosition;
}

export interface DataQueryPage {
  results: DataRecord[] | unknown[];
  last?: QueryCursorPosition;
}

export interface LatestRecordOptions {
  includeContentPath?: boolean;
  excludeModelTypes?: readonly string[];
}

/**
 * Most foreign bodies a service keeps. A serve process keeps one service for
 * its lifetime, so the cache must not grow with every record ever read.
 */
const FOREIGN_CONTENT_CACHE_ENTRIES = 256;

interface MatchResult {
  records: DataRecord[];
  selectParsed?: (ctx: Record<string, unknown>) => unknown;
  selectReadsContent: boolean;
  selectReadsAttributes: boolean;
  /**
   * rows whose predicate read content of a non-text type; never matches, the
   * caller raises BinaryContentPredicateError for one it may read
   */
  violations: Array<{ record: DataRecord; matchesBefore: number }>;
  hitLimit: boolean;
  positions: QueryCursorPosition[];
}

interface ProjectedContent {
  content: unknown;
  contentEncoding: ContentEncoding | null;
}

function isSafePathSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== ".." &&
    !/[/\\\0]/.test(segment);
}

function catalogRowKey(row: CatalogRow): string {
  return [
    row.namespace,
    row.type_normalized,
    row.model_id,
    row.data_name,
    row.version,
  ].join("\0");
}

export interface DataQueryServiceOptions {
  filterStaleRows?: boolean;
  /**
   * false for a v3 repository context: its catalog is the read model's, which
   * the context catches up and marks populated before any query
   */
  backfill?: boolean;
}

export function createQueryEnvironment(): Environment {
  return new Environment({
    unlistedVariablesAreDyn: true,
    homogeneousAggregateLiterals: false,
  });
}

export class DataQueryService {
  private readonly queryEnv: Environment;
  private readonly foreignContentCache = new Map<string, Uint8Array>();
  private backfillPromise: Promise<void> | null = null;
  private readonly filterStaleRows: boolean;
  private readonly backfill: boolean;

  constructor(
    private readonly catalogStore: CatalogStore,
    private readonly dataRepo: UnifiedDataRepository,
    options?: DataQueryServiceOptions,
  ) {
    this.filterStaleRows = options?.filterStaleRows ?? false;
    this.backfill = options?.backfill ?? true;
    this.queryEnv = createQueryEnvironment();
  }

  async getLatestRecord(
    modelName: string,
    dataName: string,
    namespace?: string,
    options?: LatestRecordOptions,
  ): Promise<DataRecord | null> {
    const includePath = options?.includeContentPath ?? false;
    const populated = this.catalogStore.isPopulated();
    // Every lookup below goes through this one query, so excluded types are
    // dropped in SQL on every path and never shadow another type's row.
    const latestRow = () =>
      this.catalogStore.findLatestRow(
        modelName,
        dataName,
        namespace,
        options?.excludeModelTypes,
      );

    if (!populated && this.backfillPromise) {
      await this.backfillPromise;
      return await this.buildRecordFromRow(latestRow(), includePath);
    }

    const row = latestRow();
    if (row) {
      if (populated) {
        if (dataName === row.spec_name) {
          this.checkSpecNameAmbiguity(
            row.spec_name,
            modelName,
            namespace,
            options?.excludeModelTypes,
          );
        }
        return await this.buildRecordFromRow(row, includePath);
      }
      // catalog not populated, so the row may predate a pull or another
      // repository's write; prefer the version the on-disk latest marker names
      const current = this.refreshFromLatestMarker(row);
      if (current) return await this.buildRecordFromRow(current, includePath);
      // guards against stale rows left behind after invalidate()
      if (await this.rowHasContent(row)) {
        return await this.buildRecordFromRow(row, includePath);
      }
    }

    if (populated) return null;

    await this.scopedBackfill(modelName, dataName);
    const freshRow = latestRow();
    if (!freshRow) return null;
    if (!(await this.rowHasContent(freshRow))) return null;
    return await this.buildRecordFromRow(freshRow, includePath);
  }

  /**
   * returns null when the row is current, the data is gone, the marker names a
   * rename marker, or the row is another namespace's; a deletion marker is
   * served like any other version
   */
  private refreshFromLatestMarker(row: CatalogRow): CatalogRow | null {
    if (row.namespace !== this.dataRepo.namespace) return null;
    const type = ModelType.create(row.type_normalized);
    const latest = this.dataRepo.getLatestVersionSync(
      type,
      row.model_id,
      row.data_name,
    );
    if (latest === null || latest === row.version) return null;
    const data = this.dataRepo.findByNameSync(
      type,
      row.model_id,
      row.data_name,
      latest,
    );
    if (!data || data.isRenamed) return null;
    // rows above the marker gone from disk would outrank its version in
    // upsertNewVersion; a higher promoted version still on disk means the
    // marker lags, so the row stands. Unpromoted deferred writes do not count
    const higherWhere =
      "namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND version > ?";
    const higherParams = [
      row.namespace,
      row.type_normalized,
      row.model_id,
      row.data_name,
      latest,
    ];
    // A pending row (an in-flight deferred write) may have no metadata on
    // disk yet; it is not stale.
    const gone = [
      ...this.catalogStore.iterateFiltered(
        `${higherWhere} AND is_pending = 0`,
        higherParams,
      ),
    ]
      .filter((stale) =>
        !this.dataRepo.findByNameSync(
          type,
          row.model_id,
          row.data_name,
          stale.version,
        )
      )
      .map((stale) => stale.version);
    this.catalogStore.bulkRemoveVersions(
      row.namespace,
      row.type_normalized,
      row.model_id,
      row.data_name,
      gone,
      computeLatestFlags,
    );
    // read the flags after the removal: it recomputes them, which can flag a
    // higher row that is still on disk
    const higherOnDisk = [
      ...this.catalogStore.iterateFiltered(
        `${higherWhere} AND (is_latest = 1 OR is_step_latest = 1)`,
        higherParams,
      ),
    ].length > 0;
    if (higherOnDisk) return null;
    const current = this.toCatalogRow(data, type, row.model_id, true);
    this.catalogStore.upsertNewVersion(current);
    return current;
  }

  /**
   * uses the async read so a lazy-hydration datastore, which syncs metadata
   * only, fetches the raw file instead of the row being mistaken for stale
   */
  private async rowHasContent(row: CatalogRow): Promise<boolean> {
    const content = await this.dataRepo.getContent(
      ModelType.create(row.type_normalized),
      row.model_id,
      row.data_name,
      row.version,
    );
    return content !== null;
  }

  /**
   * rows with the same id under another type are left by a retyped model (data
   * prune reclaims them as orphaned), so they are not peers
   */
  checkSpecNameAmbiguity(
    specName: string,
    modelName: string,
    namespace?: string,
    excludeModelTypes: readonly string[] = [],
    resolved?: { modelType: ModelType; modelId: string },
  ): void {
    if (!specName) return;
    if (!this.catalogStore.isPopulated()) {
      this.backfillSync();
    }
    // Excluded rows are neither peers nor named in the error.
    const peers = this.catalogStore.findLatestRowsBySpecName(
      modelName,
      specName,
      namespace,
    ).filter((r) =>
      !excludeModelTypes.includes(r.type_normalized) &&
      (!resolved || r.model_id !== resolved.modelId ||
        r.type_normalized === resolved.modelType.normalized)
    );
    if (peers.length > 1) {
      const names = peers.map((r) => r.data_name).sort();
      throw new UserError(
        `Ambiguous data.latest() match: specName "${specName}" ` +
          `resolves to ${peers.length} data items ` +
          `(${names.join(", ")}). Use the specific data name instead.`,
      );
    }
  }

  latestDataNamesForSpec(
    modelName: string,
    specName: string,
    namespace?: string,
    excludeModelTypes: readonly string[] = [],
  ): string[] {
    if (!specName) return [];
    if (!this.catalogStore.isPopulated()) {
      this.backfillSync();
    }
    return this.catalogStore
      .findLatestRowsBySpecName(modelName, specName, namespace)
      .filter((r) => !excludeModelTypes.includes(r.type_normalized))
      .sort((a, b) =>
        a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
      )
      .map((r) => r.data_name);
  }

  /**
   * makes content local and current first: fromRow reads synchronously, so an
   * absent or stale body would read as empty or old attributes. Other
   * namespaces get attributes from the remote
   */
  private async buildRecordFromRow(
    row: CatalogRow | null,
    includeContentPath: boolean,
  ): Promise<DataRecord | null> {
    if (!row) return null;
    // As the full context's data.latest() does, a failed download never
    // fails a lookup that would otherwise succeed.
    try {
      await this.ensureRowContent(row);
    } catch (error) {
      // a record the v3 datastore could not materialise fails the lookup with
      // its code instead of reading as empty
      if (isUnreadableContentError(error)) throw error;
      logger
        .debug`Could not hydrate ${row.model_name}/${row.data_name}@v${row.version}: ${
        String(error)
      }`;
    }
    const record = fromRow(row, this.dataRepo, true, true, includeContentPath);
    await this.hydrateForeignRecord(record);
    return record;
  }

  /**
   * a missing body or failed fetch leaves attributes empty and is retried on
   * the next read, so one transient failure never empties a record for the
   * process life; an unmaterialisable record fails the read
   */
  private async hydrateForeignRecord(record: DataRecord): Promise<void> {
    if (
      record.contentType !== "application/json" ||
      Object.keys(record.attributes).length > 0
    ) return;
    const bytes = await this.foreignContent(record);
    if (!bytes) return;
    try {
      record.attributes = JSON.parse(
        new TextDecoder().decode(bytes),
      ) as Record<string, unknown>;
    } catch {
      // Invalid JSON — leave attributes empty
    }
  }

  /**
   * a body is fetched once per service; a fetch that finds the record
   * unreadable is rethrown rather than read as absent
   */
  private async foreignContent(
    record: DataRecord,
  ): Promise<Uint8Array | null> {
    const fetcher = this.dataRepo.fetchForeignContent;
    if (!fetcher || !isForeignNamespace(record.namespace, this.dataRepo)) {
      return null;
    }
    // the row is another namespace's to write, so no field may step out of that
    // namespace's data tree; the solo namespace is the empty segment, reached
    // only by a fetcher that reads it
    if (
      (record.namespace !== "" && !isSafePathSegment(record.namespace)) ||
      !record.modelType.split("/").every(isSafePathSegment) ||
      !isSafePathSegment(record.modelId) ||
      !isSafePathSegment(record.name) ||
      !Number.isSafeInteger(record.version) || record.version < 0
    ) {
      logger
        .debug`Not fetching ${record.namespace}:${record.modelName}/${record.name}@v${record.version}: its catalog row does not name a path inside that namespace`;
      return null;
    }
    const relPath =
      `data/${record.modelType}/${record.modelId}/${record.name}/${record.version}/raw`;
    const cacheKey = `${record.namespace}:${relPath}`;
    const cached = this.foreignContentCache.get(cacheKey);
    if (cached) return cached;
    let bytes: Uint8Array | null;
    try {
      bytes = await fetcher(record.namespace, relPath);
    } catch (error) {
      // a record the datastore could not materialise fails the read with its
      // code instead of reading as empty
      if (isUnreadableContentError(error)) throw error;
      logger
        .debug`Could not fetch ${record.namespace}:${record.modelName}/${record.name}@v${record.version}: ${
        String(error)
      }`;
      return null;
    }
    if (!bytes) return null;
    if (this.foreignContentCache.size >= FOREIGN_CONTENT_CACHE_ENTRIES) {
      // Maps iterate in insertion order, so this drops the oldest body.
      for (const oldest of this.foreignContentCache.keys()) {
        this.foreignContentCache.delete(oldest);
        break;
      }
    }
    this.foreignContentCache.set(cacheKey, bytes);
    return bytes;
  }

  private async ensureRowContent(
    row: CatalogRow,
  ): Promise<ContentAvailability | undefined> {
    return await this.ensureContentOf({
      namespace: row.namespace,
      modelType: row.type_normalized,
      modelId: row.model_id,
      name: row.data_name,
      version: row.version,
      size: row.size,
    });
  }

  private async ensureContentOf(item: {
    namespace: string;
    modelType: string;
    modelId: string;
    name: string;
    version: number;
    size: number;
  }): Promise<ContentAvailability | undefined> {
    if (
      item.namespace !== this.dataRepo.namespace ||
      typeof this.dataRepo.ensureContentLocal !== "function"
    ) return undefined;
    return await this.dataRepo.ensureContentLocal(
      ModelType.create(item.modelType),
      item.modelId,
      item.name,
      item.version,
      item.size,
    );
  }

  private async scopedBackfill(
    modelName: string,
    dataName: string,
  ): Promise<void> {
    const items = await this.dataRepo.findByTaggedName(modelName, dataName);

    for (const { data: latest, modelType, modelId } of items) {
      // A deletion marker is the name's latest row, as in a full backfill.
      if (latest.isRenamed) continue;
      this.catalogStore.upsertNewVersion(
        this.toCatalogRow(latest, modelType, modelId, true),
      );
    }
  }

  async ensurePopulated(): Promise<void> {
    if (this.catalogStore.isPopulated()) return;
    if (this.backfillPromise) {
      await this.backfillPromise;
      return;
    }
    const promise = this.backfillAsync();
    this.backfillPromise = promise;
    try {
      await promise;
    } finally {
      this.backfillPromise = null;
    }
  }

  specNameFallback(predicate: string): SpecNameFallback | null {
    try {
      return buildSpecNameFallback(
        this.queryEnv.parse(predicate).ast as ASTNode,
      );
    } catch {
      return null;
    }
  }

  /**
   * attributes are returned as stored: vault references in sensitive fields are
   * never resolved here; callers needing the secret resolve it and record it in
   * RunSensitiveValues
   */
  async query(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataRecord[] | unknown[]> {
    return (await this.runQuery(predicate, options)).results;
  }

  queryPage(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataQueryPage> {
    return this.runQuery(predicate, options);
  }

  private async runQuery(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataQueryPage> {
    // Resolved before the catalog is touched, so a query that cannot
    // resolve its runs fails without a backfill.
    const latestRuns = await this.resolveLatestRuns(predicate, options);
    const models = await this.resolveModels(predicate, options);
    await this.ensurePopulated();
    let results: DataRecord[] | unknown[];
    let last: QueryCursorPosition | undefined;
    // limit applies to returned records so hidden or stale rows never shorten a
    // page: match in growing batches until met, never the whole catalog;
    // without include the first batch is the limit
    const include = options?.include;
    const limit = options?.limit ?? Infinity;
    let batch = Number.isFinite(limit)
      ? (include ? limit * 4 : limit)
      : undefined;
    // Shared across batches, so a row is downloaded at most once.
    const tried = new Set<string>();
    while (true) {
      const matched = await this.matchWithHydration(
        predicate,
        {
          ...options,
          limit: batch,
        },
        latestRuns,
        tried,
        models,
      );
      // walk violations and matches in evaluation order and stop where the page
      // fills; a violation the caller may not read is dropped so the error
      // never names an item outside their reach
      const accepted: DataRecord[] = [];
      let lastAccepted: QueryCursorPosition | undefined;
      let nextViolation = 0;
      for (
        let i = 0;
        i <= matched.records.length && accepted.length < limit;
        i++
      ) {
        for (
          ;
          nextViolation < matched.violations.length &&
          matched.violations[nextViolation].matchesBefore <= i;
          nextViolation++
        ) {
          const { record } = matched.violations[nextViolation];
          if (!include || await include(record)) {
            throw new BinaryContentPredicateError(record);
          }
        }
        const record = matched.records[i];
        if (record && (!include || await include(record))) {
          accepted.push(record);
          lastAccepted = matched.positions[i];
        }
      }
      // stale rows dropped during hydration can shorten a batch, so only
      // stopping short of the batch limit means matches ran out; a wider batch
      // re-matches from the start and tried prevents re-downloads
      if (
        accepted.length >= limit || batch === undefined || !matched.hitLimit
      ) {
        // before projection so a select that reads attributes sees them, after
        // include so a record the caller may not read is never fetched
        if (!matched.selectParsed || matched.selectReadsAttributes) {
          for (const record of accepted) {
            await this.hydrateForeignRecord(record);
          }
        }
        results = this.project(
          accepted,
          matched.selectParsed,
          await this.projectedContents(accepted, matched.selectReadsContent),
          options,
        );
        last = lastAccepted;
        break;
      }
      batch *= 4;
    }

    return last ? { results, last } : { results };
  }

  querySync(
    predicate: string,
    options?: DataQueryOptions,
  ): DataRecord[] | unknown[] {
    if (!this.catalogStore.isPopulated()) {
      this.backfillSync();
    }
    return this.executeQuery(predicate, options);
  }

  private executeQuery(
    predicate: string,
    options?: DataQueryOptions,
  ): DataRecord[] | unknown[] {
    const matched = this.executeMatch(predicate, options);
    if (matched.violations.length > 0) {
      throw new BinaryContentPredicateError(matched.violations[0].record);
    }
    return this.project(
      matched.records,
      matched.selectParsed,
      matched.selectReadsContent
        ? new Map(matched.records.map((r) => [r, this.projectedContent(r)]))
        : undefined,
      options,
    );
  }

  private async resolveLatestRuns(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<LatestRuns> {
    const workflows = this.latestRunWorkflows(
      this.queryEnv.parse(predicate).ast as ASTNode,
      options?.select,
    );
    if (workflows.length === 0) return NO_LATEST_RUNS;
    const resolver = options?.latestRunResolver;
    if (!resolver) throw latestRunUnavailable();
    const latestRuns = new Map<string, string | null>();
    for (const workflow of workflows) {
      latestRuns.set(workflow, await resolver(workflow));
    }
    return latestRuns;
  }

  private latestRunWorkflows(predicateAst: ASTNode, select?: string): string[] {
    const workflows = new Set(collectLatestRunWorkflows(predicateAst));
    if (select) {
      const selectAst = this.queryEnv.parse(select).ast as ASTNode;
      for (const workflow of collectLatestRunWorkflows(selectAst)) {
        workflows.add(workflow);
      }
    }
    return [...workflows];
  }

  /**
   * a clone, so the shared environment and concurrent queries never see another
   * query's runs
   */
  private latestRunEnv(
    workflows: string[],
    latestRuns: LatestRuns,
    base: Environment = this.queryEnv,
  ): Environment {
    // Every call must have been resolved: an unregistered call would fail
    // on each row, and per-row failures are skipped, not reported.
    if (workflows.some((workflow) => !latestRuns.has(workflow))) {
      throw latestRunUnavailable();
    }
    return base.clone().registerFunction(
      `${LATEST_RUN_FUNCTION}(string): dyn`,
      (workflow: string) => latestRuns.get(workflow) ?? null,
    );
  }

  /**
   * field references are validated first, so an invalid predicate never costs a
   * definition lookup
   */
  private async resolveModels(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<ResolvedModels> {
    const ast = this.queryEnv.parse(predicate).ast as ASTNode;
    validateFieldReferences(collectRootIdentifiers(ast));
    const references = collectModelReferences(ast);
    if (references.length === 0) return NO_MODELS;
    const resolver = options?.modelResolver;
    if (!resolver) throw modelUnavailable(ast);
    const models = new Map<string, ResolvedModelReference>();
    for (const reference of references) {
      models.set(reference, await resolver(reference));
    }
    return models;
  }

  /**
   * the catalog only nominates models; each hop is decided by the rename marker
   * on disk as data get reads it, so a forward that a later write or delete
   * ended is never followed. Loops resolve to nothing
   */
  private resolveRenameForwards(
    dataName: string,
    onlyModel?: ResolvedModelReference,
  ): Map<string, string> {
    const targets = new Map<string, string>();
    const ownNamespace = this.dataRepo.namespace;
    for (const forward of this.catalogStore.findRenamesFrom(dataName)) {
      const { namespace, type_normalized: type, model_id: modelId } = forward;
      // A top-level model() already limits the rows to one model.
      if (
        onlyModel &&
        (type !== onlyModel.modelType || modelId !== onlyModel.modelId)
      ) continue;
      // Forwards are recorded only for this repository's namespace, whose
      // markers are on local disk.
      if (namespace !== ownNamespace) continue;
      let target: string | null;
      try {
        target = this.followRenameMarkers(
          ModelType.create(type),
          modelId,
          dataName,
        );
      } catch (error) {
        // An unreadable marker skips this one model rather than failing a
        // query that matches other models' data.
        logger
          .debug`Not following rename forwards from ${dataName} under ${type}/${modelId}: ${error}`;
        continue;
      }
      if (target !== null) {
        targets.set(renameKey(namespace, type, modelId), target);
      }
    }
    return targets;
  }

  private followRenameMarkers(
    modelType: ModelType,
    modelId: string,
    dataName: string,
  ): string | null {
    const renamedTo = (name: string): string | null => {
      const latest = this.dataRepo.getLatestVersionSync(
        modelType,
        modelId,
        name,
      );
      if (latest === null) return null;
      const data = this.dataRepo.findByNameSync(
        modelType,
        modelId,
        name,
        latest,
      );
      return data?.isRenamed && data.renamedTo ? data.renamedTo : null;
    };
    const seen = new Set([dataName]);
    let target = renamedTo(dataName);
    for (let hop = 1; target !== null; hop++) {
      if (seen.has(target) || hop > MAX_RENAME_HOPS) return null;
      seen.add(target);
      const next = renamedTo(target);
      if (next === null) break;
      target = next;
    }
    return target;
  }

  /**
   * sync matching cannot download, so lazy rows would return empty attributes;
   * download missing bodies of rows include accepts, rematch, and double the
   * limit only when a pass reaches untried rows
   */
  private async matchWithHydration(
    predicate: string,
    options: DataQueryOptions | undefined,
    latestRuns: LatestRuns,
    tried = new Set<string>(),
    models: ResolvedModels = NO_MODELS,
  ): Promise<MatchResult> {
    let collectLimit = options?.limit;
    let downloadedBefore = false;
    while (true) {
      const missing = new Map<string, CatalogRow>();
      const matched = this.executeMatch(
        predicate,
        { ...options, limit: collectLimit },
        missing,
        latestRuns,
        models,
      );
      let hydrated = false;
      for (const [key, row] of missing) {
        if (tried.has(key)) continue;
        tried.add(key);
        if (
          options?.include &&
          !(await options.include(this.rowToRecord(row, false, false, false)))
        ) continue;
        // the row's own size catches a local body a metadata-only pull left
        // shorter than the row
        if ((await this.ensureRowContent(row)) === "missing") continue;
        if (await this.rowHasContent(row)) hydrated = true;
      }
      if (!hydrated) {
        return collectLimit === options?.limit ? matched : this.executeMatch(
          predicate,
          options,
          undefined,
          latestRuns,
          models,
        );
      }
      // This pass reached rows a previous download had not: the rows that
      // download synced stopped matching, so widen the window.
      if (downloadedBefore && collectLimit !== undefined) {
        collectLimit = Math.max(collectLimit, 1) * 2;
      }
      downloadedBefore = true;
    }
  }

  private executeMatch(
    predicate: string,
    options?: DataQueryOptions,
    missingContent?: Map<string, CatalogRow>,
    latestRuns: LatestRuns = NO_LATEST_RUNS,
    models: ResolvedModels = NO_MODELS,
  ): MatchResult {
    if (options?.after && !options.sort) {
      throw new UserError("A query cursor needs the sort it was made with");
    }
    // No default limit — an unspecified limit returns every matching row.
    // Callers that need a cap pass one explicitly.
    const limit = options?.limit ?? Infinity;
    const includePath = options?.includeContentPath ?? false;
    const ownNamespace = this.dataRepo.namespace;
    const reportMissing = (row: CatalogRow) =>
      missingContent && row.namespace === ownNamespace
        ? () => missingContent.set(catalogRowKey(row), row)
        : undefined;

    // an expression-facing query evaluates in its view's environment, where a
    // tagged field is a Secret with its refusals; every parse uses that base,
    // including the first, which decides whether history opens
    const view = options?.view;
    const base = view ? view.environment(this.queryEnv) : this.queryEnv;

    // Parse and validate the caller's predicate first. Parsing on the raw
    // input means parse errors point at what the caller actually wrote.
    let userParsed = base.parse(predicate);
    const userAst = userParsed.ast as ASTNode;
    const rootIds = collectRootIdentifiers(userAst);
    validateFieldReferences(rootIds);

    let env = base;
    const latestRunWorkflows = this.latestRunWorkflows(
      userAst,
      options?.select,
    );
    if (latestRunWorkflows.length > 0) {
      env = this.latestRunEnv(latestRunWorkflows, latestRuns, base);
      userParsed = env.parse(predicate);
    }

    // model() matches the row being evaluated against its resolved definition;
    // the row is local to this call, so concurrent queries never see each
    // other's
    let currentRow: CatalogRow | null = null;
    const modelReferences = collectModelReferences(userAst);
    if (options?.select) {
      const selectAst = base.parse(options.select).ast as ASTNode;
      if (collectModelReferencesLenient(selectAst)) {
        throw new UserError(
          `${modelFunctionAsTyped(selectAst)}() can only be used in the ` +
            `query predicate, not in --select`,
        );
      }
    }
    if (modelReferences.length > 0) {
      // Every call must have been resolved: an unregistered call would fail
      // on each row, and per-row failures are skipped, not reported.
      if (modelReferences.some((reference) => !models.has(reference))) {
        throw modelUnavailable(userAst);
      }
      const matchesModel = (reference: string) => {
        const target = models.get(reference);
        return !!currentRow && !!target &&
          currentRow.type_normalized === target.modelType &&
          currentRow.model_id === target.modelId;
      };
      // model() and behavior() are one function under two names
      env = env === base ? env.clone() : env;
      for (const fn of MODEL_FUNCTIONS) {
        env = env.registerFunction(`${fn}(string): bool`, matchesModel);
      }
      userParsed = env.parse(predicate);
    }

    // unless the predicate references version or isLatest at root, restrict to
    // latest rows; the AST walk means string literals do not opt out.
    // latestPerStep filters on is_step_latest and omits isLatest == true
    const opensHistory = rootIds.some((id) => HISTORY_OPT_IN_FIELDS.has(id));
    const latestPerStep = options?.latestPerStep ?? false;
    const effectivePredicate = opensHistory || latestPerStep
      ? predicate
      : `(${predicate}) && isLatest == true`;
    const parsed = opensHistory || latestPerStep
      ? userParsed
      : env.parse(effectivePredicate);
    const filterAst = parsed.ast as ASTNode;

    let selectParsed: ((ctx: Record<string, unknown>) => unknown) | undefined;
    if (options?.select) {
      selectParsed = env.parse(options.select) as unknown as (
        ctx: Record<string, unknown>,
      ) => unknown;
    }

    // content is aliased to attributes for JSON records, so referencing content
    // also loads attributes; only the filter needs content while matching, a
    // select reads it in project() after include
    const needsContent = referencesContent(filterAst);
    let needsAttributes = options?.loadAttributes ??
      (referencesAttributes(filterAst) || needsContent);
    let readsContentInSelect = false;
    let readsAttributesInSelect = false;
    if (options?.select) {
      const selectAst = (selectParsed as unknown as { ast: ASTNode }).ast;
      readsContentInSelect = selectReadsContent(selectAst);
      readsAttributesInSelect = referencesAttributes(selectAst);
      if (!needsAttributes) {
        needsAttributes = referencesAttributes(selectAst) ||
          readsContentInSelect;
      }
    }

    // SQL pushdown: pre-filter rows in SQLite before CEL evaluation.
    // Only trivially correct translations are pushed down; the full CEL
    // predicate still evaluates on every row returned by SQL.
    const whereClauses: string[] = [];
    const whereParams: (string | number)[] = [];

    if (!opensHistory) {
      whereClauses.push(latestPerStep ? "is_step_latest = ?" : "is_latest = ?");
      whereParams.push(1);
    }

    // Excluded types are dropped in SQL, before the predicate, the limit or
    // a projection sees them, so no predicate can reach them and no
    // projected value can carry one out.
    const excludedTypes = options?.excludeModelTypes ?? [];
    if (excludedTypes.length > 0) {
      whereClauses.push(
        `type_normalized NOT IN (${excludedTypes.map(() => "?").join(", ")})`,
      );
      for (const type of excludedTypes) whereParams.push(type);
    }

    const modelNameLiteral = extractModelNameEquality(userAst);
    if (modelNameLiteral !== null) {
      whereClauses.push("model_name = ?");
      whereParams.push(modelNameLiteral);
    }

    const specNameLiteral = extractStringEquality(userAst, "specName");
    if (specNameLiteral !== null) {
      whereClauses.push("spec_name = ?");
      whereParams.push(specNameLiteral);
    }

    // modelType and modelId map straight to these columns
    // (data_record_mapper.ts), so a literal equality pushes down exactly.
    const modelTypeLiteral = extractStringEquality(userAst, "modelType");
    if (modelTypeLiteral !== null) {
      whereClauses.push("type_normalized = ?");
      whereParams.push(modelTypeLiteral);
    }
    const modelIdLiteral = extractStringEquality(userAst, "modelId");
    if (modelIdLiteral !== null) {
      whereClauses.push("model_id = ?");
      whereParams.push(modelIdLiteral);
    }
    // Every write path stores Data.lifecycle and catalog pull stores only
    // "active", "deleted" or "", so the column equals the record's field.
    const lifecycleLiteral = extractStringEquality(userAst, "lifecycle");
    if (lifecycleLiteral !== null) {
      whereClauses.push("lifecycle = ?");
      whereParams.push(lifecycleLiteral);
    }

    // data_type is the type tag or "" on every catalog writer, so an
    // equality with a non-empty literal pushes down exactly.
    const typeTagLiteral = extractTypeTagEquality(userAst);
    if (typeTagLiteral !== null) {
      whereClauses.push("data_type = ?");
      whereParams.push(typeTagLiteral);
    }

    const modelCall = extractModelCall(userAst);
    const modelTarget = modelCall === null ? undefined : models.get(modelCall);
    if (modelTarget) {
      whereClauses.push("type_normalized = ?", "model_id = ?");
      whereParams.push(modelTarget.modelType, modelTarget.modelId);
    }

    // A latest-only read by exact name follows rename forwards, as an
    // unversioned `data get` does: rows the old name forwards to are
    // evaluated as if they still carried it.
    const nameLiteral = opensHistory
      ? null
      : extractStringEquality(userAst, "name");
    const renameTargets = nameLiteral === null
      ? new Map<string, string>()
      : this.resolveRenameForwards(nameLiteral, modelTarget);

    const latestRunWorkflow = extractWorkflowRunIdLatestRun(userAst);
    if (latestRunWorkflow !== null) {
      const runId = latestRuns.get(latestRunWorkflow) ?? null;
      if (runId === null) {
        return {
          records: [],
          selectParsed,
          selectReadsContent: readsContentInSelect,
          selectReadsAttributes: readsAttributesInSelect,
          violations: [],
          hitLimit: false,
          positions: [],
        };
      }
      whereClauses.push("workflow_run_id = ?");
      whereParams.push(runId);
    }

    const sort = options?.sort;
    const sortKeys = new WeakMap<CatalogRow, string>();
    const sortedRows = (order: CatalogSortOrder) => {
      const sorted = this.catalogStore.iterateSorted(
        whereClauses.join(" AND "),
        whereParams,
        order,
      );
      return (function* () {
        for (const { row, sortKey } of sorted) {
          sortKeys.set(row, sortKey);
          yield row;
        }
      })();
    };
    const rows = sort
      ? sortedRows({
        tagKey: querySortTagKey(sort),
        direction: sort.direction,
        after: options?.after,
      })
      : whereClauses.length > 0
      ? this.catalogStore.iterateFiltered(
        whereClauses.join(" AND "),
        whereParams,
      )
      : this.catalogStore.iterate();
    const positions: QueryCursorPosition[] = [];
    const positionOf = (row: CatalogRow): QueryCursorPosition => ({
      key: sortKeys.get(row) ?? "",
      id: [
        row.namespace,
        row.type_normalized,
        row.model_id,
        row.data_name,
        row.version,
      ],
    });

    // CEL reserves namespace as an identifier, so an ns alias is exposed
    // through a prototype-chain overlay; the record itself is not mutated
    const results: DataRecord[] = [];
    const violations: Array<{ record: DataRecord; matchesBefore: number }> = [];
    let hitLimit = false;
    const needsHydration = !needsAttributes && !selectParsed;
    const matchedRows: CatalogRow[] = [];
    for (const row of rows) {
      // The old name's latest version is a confirmed rename marker, so a row
      // still under that name (left by a sync or a failed catalog write) is
      // not its latest version: data get reads the forwarded item instead.
      if (
        nameLiteral !== null && row.data_name === nameLiteral &&
        renameTargets.has(
          renameKey(row.namespace, row.type_normalized, row.model_id),
        )
      ) continue;
      const record = this.rowToRecord(row, false, false, includePath);
      // attributes and content are read from disk only when evaluation touches
      // them or the row matches; the load outcome is memoized per row, nothing
      // is cached across queries
      let full: DataRecord | undefined;
      let loadFailed = false;
      let loadError: unknown;
      const load = (): DataRecord => {
        if (loadFailed) throw loadError;
        if (!full) {
          try {
            full = this.rowToRecord(
              row,
              needsAttributes,
              needsContent,
              includePath,
              reportMissing(row),
            );
          } catch (error) {
            loadFailed = true;
            loadError = error;
            throw error;
          }
        }
        return full;
      };
      // content in a predicate is text; reading it on a binary item is an
      // error, checked by catalog content type so no bytes are read
      let readBinaryContent = false;
      const ctx = Object.create(
        record as unknown as Record<string, unknown>,
      ) as Record<string, unknown>;
      ctx["ns"] = record.namespace;
      // the behavior spelling of modelName; not a DataRecord field, so output
      // never carries it
      ctx["behaviorName"] = record.modelName;
      if (
        nameLiteral !== null &&
        renameTargets.get(
            renameKey(row.namespace, row.type_normalized, row.model_id),
          ) === row.data_name
      ) {
        ctx["name"] = nameLiteral;
      }
      currentRow = row;
      // Under a view the record is viewed once per row, on first read, so
      // the predicate's attributes and JSON content are one view.
      let viewed: DataRecord | undefined;
      const loadViewed = (): DataRecord => {
        if (!viewed) viewed = view!.record(load());
        return viewed;
      };
      Object.defineProperties(ctx, {
        attributes: {
          get: () => view ? loadViewed().attributes : load().attributes,
        },
        content: {
          get: () => {
            if (!isTextContentType(record.contentType)) {
              readBinaryContent = true;
              throw new Error("content of a non-text item");
            }
            const loaded = load();
            if (
              view &&
              (isJsonMediaType(loaded.contentType) ||
                loaded.content === loaded.attributes)
            ) {
              // a view-adapted record's JSON content reads the view; a record
              // the view answers as stored (another namespace's or untagged)
              // keeps the raw content
              const viewed = loadViewed();
              if (viewed !== loaded) return viewed.attributes;
            }
            return loaded.contentType === "application/json"
              ? loaded.attributes
              : loaded.content;
          },
        },
      });
      try {
        const match = view
          ? view.predicate(predicate, parsed as unknown as QueryProgram, ctx)
          : parsed(ctx);
        // Also when CEL absorbed the read, as in `content == "x" || true`.
        if (readBinaryContent) {
          violations.push({ record, matchesBefore: results.length });
          continue;
        }
        if (match === true) {
          // Materialize as a plain record; a read error absorbed by CEL
          // (e.g. `<read error> || true`) resurfaces here.
          results.push(needsHydration ? record : load());
          if (needsHydration) matchedRows.push(row);
          if (sort) positions.push(positionOf(row));
          if (results.length >= limit) {
            hitLimit = true;
            break;
          }
        }
      } catch (error) {
        // A refusal or a malformed reference the view raised fails the
        // query: never a skipped row, and never a violation in its place.
        if (error instanceof QueryViewRefusal) throw error;
        // Required body reads must fail the query, not skip the row.
        if (loadFailed) throw loadError;
        if (readBinaryContent) {
          violations.push({ record, matchesBefore: results.length });
          continue;
        }
        logger
          .debug`Query predicate skipped row ${row.model_name}/${row.data_name}: ${
          String(error)
        }`;
      }
    }

    // hydrate matched records when the predicate did not need attributes; with
    // filterStaleRows, rows whose backing file is absent are dropped, since a
    // stale isLatest row with empty content would win [0] selection
    if (needsHydration) {
      let writeIndex = 0;
      // keptBefore[i] counts the records kept before results[i], so a
      // violation's position survives the stale rows dropped here.
      const keptBefore: number[] = [];
      for (let i = 0; i < results.length; i++) {
        keptBefore.push(writeIndex);
        const row = matchedRows[i];
        if (this.filterStaleRows && row.namespace === ownNamespace) {
          const contentPath = this.dataRepo.getContentPath(
            ModelType.create(row.type_normalized),
            row.model_id,
            row.data_name,
            row.version,
          );
          try {
            Deno.statSync(contentPath);
          } catch {
            // the async path ensures it, which fails loudly when the v3
            // datastore could not materialise it; absent content stays dropped
            reportMissing(row)?.();
            logger
              .debug`Skipping stale catalog row ${row.model_name}/${row.data_name}@v${row.version}: backing file absent`;
            continue;
          }
        }
        results[writeIndex] = this.rowToRecord(
          row,
          true,
          needsContent,
          includePath,
          reportMissing(row),
        );
        if (sort) positions[writeIndex] = positions[i];
        writeIndex++;
      }
      keptBefore.push(writeIndex);
      for (const violation of violations) {
        violation.matchesBefore = keptBefore[violation.matchesBefore];
      }
      results.length = writeIndex;
      if (sort) positions.length = writeIndex;
    }

    return {
      records: results,
      selectParsed,
      selectReadsContent: readsContentInSelect,
      selectReadsAttributes: readsAttributesInSelect,
      violations,
      hitLimit,
      positions,
    };
  }

  private project(
    results: DataRecord[],
    selectParsed: ((ctx: Record<string, unknown>) => unknown) | undefined,
    contents: Map<DataRecord, ProjectedContent> | undefined,
    options?: DataQueryOptions,
  ): DataRecord[] | unknown[] {
    // per-record errors produce null instead of failing the whole query; the ns
    // alias must be available in select expressions too
    if (selectParsed) {
      const view = options?.view;
      const select = options?.select ?? "";
      return results.map((r) => {
        try {
          const selectCtx = Object.create(
            r as unknown as Record<string, unknown>,
          ) as Record<string, unknown>;
          selectCtx["ns"] = r.namespace;
          selectCtx["behaviorName"] = r.modelName;
          const projected = contents?.get(r);
          if (view) {
            // Every projection runs through the view, viewing the record on
            // first read after hydration; a record the view answers as stored
            // reads raw.
            let viewed: DataRecord | undefined;
            const loadViewed = (): DataRecord => {
              if (!viewed) viewed = view.record(r);
              return viewed;
            };
            const rawContent = (): unknown =>
              projected
                ? projected.content
                : r.contentType === "application/json"
                ? r.attributes
                : r.content;
            Object.defineProperties(selectCtx, {
              attributes: {
                get: () => loadViewed().attributes,
                enumerable: true,
                configurable: true,
              },
              content: {
                get: () => {
                  const aliased = projected
                    ? projected.content === r.attributes
                    : r.content === r.attributes;
                  if (isJsonMediaType(r.contentType) || aliased) {
                    const record = loadViewed();
                    if (record !== r) return record.attributes;
                  }
                  return rawContent();
                },
                enumerable: true,
                configurable: true,
              },
            });
            if (projected) {
              selectCtx["contentEncoding"] = projected.contentEncoding;
            }
            return view.projection(
              select,
              selectParsed as unknown as QueryProgram,
              selectCtx,
            );
          }
          if (projected) {
            selectCtx["content"] = projected.content;
            selectCtx["contentEncoding"] = projected.contentEncoding;
          } else if (r.contentType === "application/json") {
            selectCtx["content"] = r.attributes;
          }
          return coerceBigInts(selectParsed(selectCtx));
        } catch (error) {
          // A refusal the view raised fails the query, never a null.
          if (error instanceof QueryViewRefusal) throw error;
          return null;
        }
      });
    }

    return results;
  }

  /**
   * JSON as parsed attributes, else UTF-8 text or base64 as data get returns;
   * content not on this host is null, never mistaken for empty. Undefined when
   * the answer needs the bytes
   */
  private projectedContentWithoutBytes(
    record: DataRecord,
  ): ProjectedContent | undefined {
    if (isForeignNamespace(record.namespace, this.dataRepo)) {
      return { content: null, contentEncoding: null };
    }
    if (record.contentType === "application/json") {
      return { content: record.attributes, contentEncoding: "utf-8" };
    }
    return undefined;
  }

  private encodeProjected(bytes: Uint8Array | null): ProjectedContent {
    return bytes
      ? encodeContent(bytes)
      : { content: null, contentEncoding: null };
  }

  /**
   * read synchronously from local disk; the querySync path cannot download
   * lazily-synced bodies
   */
  private projectedContent(record: DataRecord): ProjectedContent {
    const known = this.projectedContentWithoutBytes(record);
    if (known) return known;
    let bytes: Uint8Array | null = null;
    try {
      bytes = this.dataRepo.getContentSync(
        ModelType.create(record.modelType),
        record.modelId,
        record.name,
        record.version,
      );
    } catch (error) {
      logger
        .debug`Projection could not read content of ${record.modelName}/${record.name}@v${record.version}: ${
        String(error)
      }`;
    }
    return this.encodeProjected(bytes);
  }

  /**
   * bodies are read with async getContent, which downloads a lazily-synced body
   * as data get does; only records that passed include reach here, so nothing
   * is read for one the caller may not read
   */
  private async projectedContents(
    records: DataRecord[],
    readsContent: boolean,
  ): Promise<Map<DataRecord, ProjectedContent> | undefined> {
    if (!readsContent) return undefined;
    const contents = new Map<DataRecord, ProjectedContent>();
    for (const record of records) {
      // Only a v3 checkout reads another namespace's body from local disk;
      // a v2 sync fetcher would download it, so its rows stay null below.
      if (
        this.dataRepo.fetchForeignContent?.readsSoloNamespace === true &&
        isForeignNamespace(record.namespace, this.dataRepo)
      ) {
        contents.set(record, await this.projectedForeignContent(record));
        continue;
      }
      const known = this.projectedContentWithoutBytes(record);
      if (known) {
        contents.set(record, known);
        continue;
      }
      await this.ensureContentOf({
        namespace: record.namespace,
        modelType: record.modelType,
        modelId: record.modelId,
        name: record.name,
        version: record.version,
        size: record.size,
      });
      contents.set(
        record,
        this.encodeProjected(
          await this.dataRepo.getContent(
            ModelType.create(record.modelType),
            record.modelId,
            record.name,
            record.version,
          ),
        ),
      );
    }
    return contents;
  }

  private async projectedForeignContent(
    record: DataRecord,
  ): Promise<ProjectedContent> {
    if (
      record.contentType === "application/json" &&
      Object.keys(record.attributes).length > 0
    ) {
      return { content: record.attributes, contentEncoding: "utf-8" };
    }
    const bytes = await this.foreignContent(record);
    if (bytes && record.contentType === "application/json") {
      try {
        return {
          content: JSON.parse(new TextDecoder().decode(bytes)),
          contentEncoding: "utf-8",
        };
      } catch {
        return { content: {}, contentEncoding: "utf-8" };
      }
    }
    return this.encodeProjected(bytes);
  }

  private rowToRecord(
    row: CatalogRow,
    loadAttributes: boolean,
    loadContent: boolean,
    includeContentPath: boolean,
    onMissingContent?: () => void,
  ): DataRecord {
    return fromRow(
      row,
      this.dataRepo,
      loadAttributes,
      loadContent,
      includeContentPath,
      onMissingContent,
    );
  }

  private async backfillAsync(): Promise<void> {
    if (!this.backfill) return;
    // generation is read before walking the disk; the walk is in name order at
    // every level so rows get the same rowids on every filesystem
    const generation = this.catalogStore.generation();
    const renames: RenameForward[] = [];
    const allData = await this.dataRepo.findAllGlobal({ renames });

    // Group by model type so we can yield to the event loop between types,
    // giving V8 GC a chance to reclaim intermediate YAML/Zod allocations.
    const byType = new Map<
      string,
      Array<{ data: Data; modelType: ModelType; modelId: string }>
    >();
    for (const item of allData) {
      const key = item.modelType.normalized;
      let group = byType.get(key);
      if (!group) {
        group = [];
        byType.set(key, group);
      }
      group.push(item);
    }

    // gather all rows, then commit to SQLite in one batch; interleaving slow
    // async metadata reads with single writes leaves the database partly
    // populated and hits 'database is locked' under contention
    const rows: CatalogRow[] = [];
    for (const [, items] of byType) {
      for (const { data: latest, modelType, modelId } of items) {
        // rows mirror write-through: a deletion marker is a version like any
        // other, while a rename marker goes into catalog_renames, never a row
        if (latest.isRenamed) continue;
        const versions = await this.dataRepo.listVersions(
          modelType,
          modelId,
          latest.name,
        );
        if (versions.length === 0) continue;
        for (const version of versions) {
          // a version above the one the latest marker names was never published
          // (a save that died, or a write in flight that publishes its own
          // row), so a rebuilt catalog agrees with reads through the marker
          if (version > latest.version) continue;
          try {
            const data = version === latest.version
              ? latest
              : await this.dataRepo.findByName(
                modelType,
                modelId,
                latest.name,
                version,
              );
            if (!data) continue;
            if (data.isRenamed) continue;
            rows.push(
              this.toCatalogRow(
                data,
                modelType,
                modelId,
                false,
              ),
            );
          } catch (error) {
            logger
              .debug`Skipping ${modelType.normalized}/${modelId}/${latest.name}@${version} during backfill: ${
              String(error)
            }`;
          }
        }
      }
      // Yield to the event loop between model types so V8 can run a major
      // GC cycle and reclaim intermediate objects from metadata parsing.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // Flags are derived inside bulkUpsert's transaction, without versions the
    // catalog holds as pending (in-flight deferred writes).
    this.catalogStore.bulkUpsert(rows, computeLatestFlags);
    this.catalogStore.enforceUniqueLatest(computeLatestFlags);
    this.recordRenameForwards(renames);
    this.catalogStore.markPopulated(generation);
  }

  private backfillSync(): void {
    if (!this.backfill) return;
    // generation is read before walking the disk; the walk is in name order at
    // every level so rows get the same rowids on every filesystem
    const generation = this.catalogStore.generation();
    const renames: RenameForward[] = [];
    const allData = this.dataRepo.findAllGlobalSync({ renames });

    const byType = new Map<
      string,
      Array<{ data: Data; modelType: ModelType; modelId: string }>
    >();
    for (const item of allData) {
      const key = item.modelType.normalized;
      let group = byType.get(key);
      if (!group) {
        group = [];
        byType.set(key, group);
      }
      group.push(item);
    }

    const rows: CatalogRow[] = [];
    for (const [, items] of byType) {
      for (const { data: latest, modelType, modelId } of items) {
        if (latest.isRenamed) continue;
        const versions = this.dataRepo.listVersionsSync(
          modelType,
          modelId,
          latest.name,
        );
        if (versions.length === 0) continue;
        for (const version of versions) {
          if (version > latest.version) continue;
          try {
            const data = version === latest.version
              ? latest
              : this.dataRepo.findByNameSync(
                modelType,
                modelId,
                latest.name,
                version,
              );
            if (!data) continue;
            if (data.isRenamed) continue;
            rows.push(
              this.toCatalogRow(
                data,
                modelType,
                modelId,
                false,
              ),
            );
          } catch (error) {
            logger
              .debug`Skipping ${modelType.normalized}/${modelId}/${latest.name}@${version} during backfill: ${
              String(error)
            }`;
          }
        }
      }
    }
    this.catalogStore.bulkUpsert(rows, computeLatestFlags);
    this.catalogStore.enforceUniqueLatest(computeLatestFlags);
    this.recordRenameForwards(renames);
    this.catalogStore.markPopulated(generation);
  }

  private recordRenameForwards(renames: readonly RenameForward[]): void {
    const namespace = this.dataRepo.namespace;
    this.catalogStore.mergeRenames(
      renames.map((rename) => ({
        namespace,
        type_normalized: rename.modelType.normalized,
        model_id: rename.modelId,
        data_name: rename.dataName,
        renamed_to: rename.renamedTo,
      })),
    );
  }

  private toCatalogRow(
    data: Data,
    modelType: ModelType,
    modelId: string,
    isLatest: boolean,
  ): CatalogRow {
    return {
      namespace: this.dataRepo.namespace,
      type_normalized: modelType.normalized,
      model_id: modelId,
      data_name: data.name,
      id: data.id,
      version: data.version,
      is_latest: isLatest ? 1 : 0,
      is_step_latest: isLatest ? 1 : 0,
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
}
