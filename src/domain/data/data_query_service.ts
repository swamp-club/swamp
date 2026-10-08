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
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import { UserError } from "../errors.ts";
import type { RenameForward, UnifiedDataRepository } from "./repositories.ts";
import type { DataRecord } from "./data_record.ts";
import {
  type ASTNode,
  buildSpecNameFallback,
  collectLatestRunWorkflows,
  collectModelReferences,
  collectRootIdentifiers,
  extractModelCall,
  extractModelNameEquality,
  extractStringEquality,
  extractWorkflowRunIdLatestRun,
  HISTORY_OPT_IN_FIELDS,
  LATEST_RUN_FUNCTION,
  MODEL_FUNCTION,
  referencesAttributes,
  referencesContent,
  selectReadsContent,
  type SpecNameFallback,
  validateFieldReferences,
} from "./query_predicate.ts";
import { isTextContentType } from "./content_type.ts";
import { type ContentEncoding, encodeContent } from "./content_encoding.ts";
import { BinaryContentPredicateError } from "./binary_content_predicate_error.ts";
import { ModelType } from "../models/model_type.ts";
import type { Data } from "./data.ts";
import { fromRow } from "./data_record_mapper.ts";
import { garbageCollectionToColumn } from "./data_metadata.ts";

const logger = getLogger(["swamp", "domain", "data", "query"]);

function modelUnavailable(): UserError {
  return new UserError(
    `${MODEL_FUNCTION}() is only available in swamp data query; ` +
      `here, match the model with modelId and modelType, e.g. ` +
      `modelId == "<definition id>"`,
  );
}

/** Rename hops data query follows, as an unversioned repository read does. */
const MAX_RENAME_HOPS = 5;

function renameKey(namespace: string, type: string, modelId: string): string {
  return `${namespace}\0${type}\0${modelId}`;
}

/** Whether a select expression calls model() in any form. */
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
 * Sets `is_latest` and `is_step_latest` on each row to match the semantics
 * of `CatalogStore.upsertNewVersion`:
 *
 * - `is_latest`: exactly one row per (namespace, type, model, name) group,
 *   the highest version, whatever its step_name.
 * - `is_step_latest`: model-method rows (step_name = "") are demoted by ANY
 *   higher version (model-method or workflow-step), so they keep the flag
 *   only when they are the absolute highest version in the group.
 *   Workflow-step rows (step_name != "") are demoted by higher versions
 *   with the same step_name or by higher model-method versions. Above the
 *   highest model-method version, each step_name keeps its own latest.
 *
 * The highest row always gets both flags.
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

/**
 * Resolves the workflow named in a `latestRun("<workflow>")` query call to
 * the id of its most recent run, or null when it has no runs. Throws a
 * UserError when the workflow is unknown or the caller may not read it.
 */
export type LatestWorkflowRunResolver = (
  workflow: string,
) => Promise<string | null>;

/** The run each `latestRun` workflow resolved to for one query. */
type LatestRuns = ReadonlyMap<string, string | null>;

const NO_LATEST_RUNS: LatestRuns = new Map();

/** The definition data is stored under, as a `model()` call resolved it. */
export interface ResolvedModelReference {
  /** The definition's normalized model type, as the catalog stores it. */
  modelType: string;
  /** The definition id. */
  modelId: string;
}

/**
 * Resolves the model named in a `model("<name or id>")` query call to the
 * definition its data is stored under, as `swamp data get <model>` does.
 * Throws a UserError when the model is unknown or the caller may not read
 * it.
 */
export type ModelReferenceResolver = (
  idOrName: string,
) => Promise<ResolvedModelReference>;

/** The definition each `model()` reference resolved to for one query. */
type ResolvedModels = ReadonlyMap<string, ResolvedModelReference>;

const NO_MODELS: ResolvedModels = new Map();

export interface DataQueryOptions {
  limit?: number;
  /** CEL projection expression. When set, results are projected and returned as unknown[]. */
  select?: string;
  /** Force-load JSON attributes even when the predicate doesn't reference them. */
  loadAttributes?: boolean;
  /**
   * Replace the implicit latest-only filter with latest-per-step: when the
   * predicate does not open history, match each workflow step's latest
   * version of a data name (`is_step_latest`) instead of the single latest
   * (`is_latest`). Only the CEL collection helpers `findBySpec` and
   * `findByTag` set this, so every step's output stays visible
   * (swamp-club#1761). Records of an older step's latest report
   * `isLatest: false`.
   */
  latestPerStep?: boolean;
  /**
   * Populate each record's `path` with its local content path (default
   * false). Applied as each row's record is built, so predicates and select
   * projections see "" unless the caller opts in. Only the CEL data.*
   * namespace opts in; results that leave the process (serve, workers) must
   * not.
   */
  includeContentPath?: boolean;
  /**
   * Keeps only the matched records this accepts, before any projection, so
   * a projected result never carries a record the caller may not read.
   */
  include?: (record: DataRecord) => Promise<boolean>;
  /**
   * Stored model types whose records are never matched, whatever the
   * predicate says. They are compared as stored strings, so pass every form
   * a type can be stored under (bare and `@`-prefixed). The CEL data.*
   * namespace passes CONTROL_PLANE_STORED_TYPES so expressions can never read
   * control-plane records (swamp-club#2756).
   */
  excludeModelTypes?: readonly string[];
  /**
   * Resolves `latestRun("<workflow>")` calls in the predicate and select.
   * Passed per call, so each caller decides whose workflows may be resolved;
   * without it a query that calls latestRun fails (swamp-club#2957).
   */
  latestRunResolver?: LatestWorkflowRunResolver;
  /**
   * Resolves `model("<name or id>")` calls in the predicate. Passed per
   * call, so each caller decides whose models may be resolved; without it a
   * query that calls model fails (swamp-club#2960).
   */
  modelResolver?: ModelReferenceResolver;
}

/** Options for {@link DataQueryService.getLatestRecord}. */
export interface LatestRecordOptions {
  /** See {@link DataQueryOptions.includeContentPath}. */
  includeContentPath?: boolean;
  /** See {@link DataQueryOptions.excludeModelTypes}. */
  excludeModelTypes?: readonly string[];
}

/**
 * Domain service for querying data artifacts using CEL predicates.
 *
 * Queries iterate over a SQLite metadata catalog, evaluate a parsed CEL
 * predicate against each row, and optionally lazy-load JSON content for
 * predicates that reference `attributes`.
 */
/**
 * Callback for fetching content from a foreign namespace on-demand.
 * Returns raw bytes, or null if unavailable.
 */
export type ForeignContentFetcher = (
  namespace: string,
  relPath: string,
) => Promise<Uint8Array | null>;

/** What {@link DataQueryService} matched for a predicate, before projection. */
interface MatchResult {
  records: DataRecord[];
  selectParsed?: (ctx: Record<string, unknown>) => unknown;
  /** Whether the select expression reads the items' bytes. */
  selectReadsContent: boolean;
  /**
   * Rows whose predicate read `content` although their content type is not
   * text, as metadata-only records, in evaluation order. `matchesBefore`
   * counts the records matched before the row. They are never matches; the
   * caller raises {@link BinaryContentPredicateError} for one it may read.
   */
  violations: Array<{ record: DataRecord; matchesBefore: number }>;
  /** Whether matching stopped at the limit, so more rows may match. */
  hitLimit: boolean;
}

/** A record's content as a projection sees it; see `projectedContent`. */
interface ProjectedContent {
  content: unknown;
  contentEncoding: ContentEncoding | null;
}

/** Identifies one version of one data item in the catalog. */
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
}

export class DataQueryService {
  private readonly queryEnv: Environment;
  private foreignContentFetcher?: ForeignContentFetcher;
  private readonly foreignContentCache = new Map<string, Uint8Array | null>();
  private backfillPromise: Promise<void> | null = null;
  private readonly filterStaleRows: boolean;

  constructor(
    private readonly catalogStore: CatalogStore,
    private readonly dataRepo: UnifiedDataRepository,
    options?: DataQueryServiceOptions,
  ) {
    this.filterStaleRows = options?.filterStaleRows ?? false;
    this.queryEnv = new Environment({
      unlistedVariablesAreDyn: true,
      homogeneousAggregateLiterals: false,
    });
  }

  /**
   * Configures foreign content fetch for cross-namespace attribute access.
   * When set, query results from foreign namespaces that have no local
   * content will attempt to fetch it on-demand. Fetched content is cached
   * in-memory for the lifetime of this service instance (command duration).
   */
  setForeignContentFetcher(fetcher: ForeignContentFetcher): void {
    this.foreignContentFetcher = fetcher;
  }

  /**
   * Direct indexed lookup for the latest version of a specific data item.
   *
   * Uses a three-tier strategy to avoid a full catalog backfill:
   * 1. Try the indexed SQL lookup first — if the catalog is populated or the
   *    row exists from a write-through update, return immediately.
   * 2. If the catalog is not populated and the row exists but its content
   *    is gone (stale row after invalidate()), fall through. On a
   *    lazy-hydration datastore the content check downloads the raw file.
   * 3. If the catalog is not populated and no row exists (or row was stale),
   *    run a scoped backfill for just this (modelName, dataName) pair, then
   *    retry the indexed lookup.
   */
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

    // If a full backfill is already in-flight, await it — it will populate
    // everything including our target.
    if (!populated && this.backfillPromise) {
      await this.backfillPromise;
      return this.buildRecordFromRow(latestRow(), includePath);
    }

    // Tier 1: try the indexed SQL lookup.
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
        return this.buildRecordFromRow(row, includePath);
      }
      // Catalog not populated, so the row may predate a pull or another
      // repository's write. Prefer the version the on-disk latest marker
      // names (swamp-club#2858).
      const current = this.refreshFromLatestMarker(row);
      if (current) return this.buildRecordFromRow(current, includePath);
      // Verify the data still exists to guard against stale rows left
      // behind after invalidate().
      if (await this.rowHasContent(row)) {
        return this.buildRecordFromRow(row, includePath);
      }
      // Stale row — fall through to scoped backfill
    }

    if (populated) return null;

    // Tier 2: scoped backfill for just this (modelName, dataName) pair.
    await this.scopedBackfill(modelName, dataName);
    const freshRow = latestRow();
    if (!freshRow) return null;
    // Verify the row points to real data (it may be the same stale row
    // that triggered the scoped backfill).
    if (!(await this.rowHasContent(freshRow))) return null;
    return this.buildRecordFromRow(freshRow, includePath);
  }

  /**
   * When the on-disk latest marker names a newer (or older) version than
   * `row`, upserts that version into the catalog and returns its row.
   * Returns null when the row is current, when the data is gone or
   * tombstoned (the caller's content check handles that), or when the row
   * belongs to another namespace, whose data is not in this repository's
   * layout.
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
    if (!data || data.isDeleted || data.isRenamed) return null;
    // Rows above the marker whose version is gone from disk (another
    // repository deleted it) would otherwise outrank the marker's version in
    // upsertNewVersion, which orders by version (swamp-club#2520). A higher
    // promoted version still on disk means the marker lags — the catalog row
    // stands. An unpromoted deferred write does not count: it holds neither
    // flag, and the removal's recompute skips pending rows.
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
    // Read the flags after the removal: it recomputes them, which can flag a
    // higher row that is still on disk (swamp-club#2975).
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
   * Whether a catalog row's content still exists. Uses the async read so a
   * lazy-hydration datastore — which syncs metadata only — fetches the raw
   * file instead of the row being mistaken for a stale one (swamp-club#2288).
   * Without a hydrate hook this is the same local read as before, so a row
   * whose data was deleted, or whose write never finished, is still stale.
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
   * Throws when `specName` names several latest data items of a model.
   *
   * @param resolved - The type and id the caller found the record under.
   *   Rows with the same id under another type are what a retyped model left
   *   behind — data prune reclaims them as orphaned — so they are not peers
   *   (swamp-club#2501).
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

  /**
   * Data names of the latest records written under `specName` for a model,
   * newest first. Reads the same rows as {@link checkSpecNameAmbiguity}; used
   * to explain a `data.latest()` miss whose argument was a spec name rather
   * than a data name.
   */
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

  private buildRecordFromRow(
    row: CatalogRow | null,
    includeContentPath: boolean,
  ): DataRecord | null {
    if (!row) return null;
    return fromRow(row, this.dataRepo, true, true, includeContentPath);
  }

  private async scopedBackfill(
    modelName: string,
    dataName: string,
  ): Promise<void> {
    const items = await this.dataRepo.findByTaggedName(modelName, dataName);

    for (const { data: latest, modelType, modelId } of items) {
      if (latest.isRenamed || latest.isDeleted) continue;
      this.catalogStore.upsertNewVersion(
        this.toCatalogRow(latest, modelType, modelId, true),
      );
    }
  }

  /**
   * Ensures the catalog is populated, triggering a backfill if needed.
   * Reuses the same backfill-coalescing logic as query().
   */
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

  /**
   * Returns the spec-name counterpart of a predicate that matches one data
   * instance name exactly (see {@link buildSpecNameFallback}), or null when
   * the predicate has no such equality or does not parse. Callers run it to
   * tell a user who queried by spec name where their data is.
   */
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
   * Queries data artifacts matching a CEL predicate.
   * Triggers backfill if the catalog is not yet populated.
   * Attributes are returned as stored: vault references in sensitive fields
   * are never resolved here. Callers that need the secret resolve it
   * themselves, recording it in the run's RunSensitiveValues.
   */
  async query(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataRecord[] | unknown[]> {
    // Resolved before the catalog is touched, so a query that cannot
    // resolve its runs fails without a backfill.
    const latestRuns = await this.resolveLatestRuns(predicate, options);
    const models = await this.resolveModels(predicate, options);
    await this.ensurePopulated();
    let results: DataRecord[] | unknown[];
    // Apply the limit to returned records, so neither hidden records nor
    // stale catalog rows dropped during hydration shorten a page: match in
    // growing batches until the limit is met or the matches run out, never
    // the whole catalog when a limit is set. Without include, the first
    // batch is the limit itself, so a query with no stale rows takes one
    // pass, as it always has (swamp-club#2985).
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
      // Walk violations and matches in the order they were evaluated, and
      // stop where the accepted page fills, so a violation is raised only
      // where an unfiltered query with no stale rows would have reached it.
      // A violation the caller may not read is dropped like any other hidden
      // record, so the error never names, or reveals, an item outside the
      // caller's reach.
      const accepted: DataRecord[] = [];
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
        }
      }
      // Stale rows dropped during hydration can shorten a batch, so only
      // stopping short of the batch limit means the matches ran out. A wider
      // batch re-matches from the start; `tried` keeps it from downloading a
      // body twice, and the widening only happens when stale rows or include
      // shortened the page.
      if (
        accepted.length >= limit || batch === undefined || !matched.hitLimit
      ) {
        results = this.project(
          accepted,
          matched.selectParsed,
          await this.projectedContents(accepted, matched.selectReadsContent),
        );
        break;
      }
      batch *= 4;
    }

    // Hydrate foreign namespace records whose content isn't available locally.
    if (this.foreignContentFetcher && Array.isArray(results)) {
      const ownNamespace = this.dataRepo.namespace;
      for (const item of results) {
        if (
          typeof item === "object" && item !== null && "attributes" in item
        ) {
          const record = item as DataRecord;
          if (
            record.namespace !== ownNamespace &&
            record.namespace !== "" &&
            Object.keys(record.attributes).length === 0 &&
            record.contentType === "application/json"
          ) {
            const relPath =
              `data/${record.modelType}/${record.modelId}/${record.name}/${record.version}/raw`;
            const cacheKey = `${record.namespace}:${relPath}`;
            let bytes: Uint8Array | null;
            if (this.foreignContentCache.has(cacheKey)) {
              bytes = this.foreignContentCache.get(cacheKey)!;
            } else {
              try {
                bytes = await this.foreignContentFetcher(
                  record.namespace,
                  relPath,
                );
              } catch {
                bytes = null;
              }
              this.foreignContentCache.set(cacheKey, bytes);
            }
            if (bytes) {
              try {
                const text = new TextDecoder().decode(bytes);
                record.attributes = JSON.parse(text) as Record<
                  string,
                  unknown
                >;
              } catch {
                // Invalid JSON — leave attributes empty
              }
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Queries data artifacts matching a CEL predicate (sync version).
   * Used by CEL expression evaluation which must be synchronous.
   * Triggers sync backfill if the catalog is not yet populated.
   * Like query(), returns attributes as stored.
   */
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
    );
  }

  /**
   * Resolves each distinct workflow the predicate and select pass to
   * `latestRun`, once per query, through the caller's resolver.
   */
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

  /** The workflows `latestRun` is called with in a predicate and select. */
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
   * An environment where `latestRun` returns the runs resolved for this
   * query. A clone, so the shared environment — and every concurrent
   * query — never sees another query's runs.
   */
  private latestRunEnv(
    workflows: string[],
    latestRuns: LatestRuns,
  ): Environment {
    // Every call must have been resolved: an unregistered call would fail
    // on each row, and per-row failures are skipped, not reported.
    if (workflows.some((workflow) => !latestRuns.has(workflow))) {
      throw latestRunUnavailable();
    }
    return this.queryEnv.clone().registerFunction(
      `${LATEST_RUN_FUNCTION}(string): dyn`,
      (workflow: string) => latestRuns.get(workflow) ?? null,
    );
  }

  /**
   * Resolves each distinct model the predicate passes to `model`, once per
   * query, through the caller's resolver. Field references are validated
   * first, so an invalid predicate never costs a definition lookup.
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
    if (!resolver) throw modelUnavailable();
    const models = new Map<string, ResolvedModelReference>();
    for (const reference of references) {
      models.set(reference, await resolver(reference));
    }
    return models;
  }

  /**
   * Resolves the rename forwards a latest-only `name == "<old>"` predicate
   * follows: for each model the catalog records a forward from `dataName`
   * under, the name an unversioned repository read of `dataName` ends at,
   * keyed by namespace, type and model id. The catalog only nominates
   * models; each hop is decided by the name's rename marker on disk, exactly
   * as `data get` reads it, so a forward that a later write or delete
   * (here or on another machine) ended is never followed. A chain that loops
   * or runs past {@link MAX_RENAME_HOPS} resolves to nothing.
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

  /**
   * The name an unversioned read of `dataName` ends at by following its
   * rename markers on disk, or null when it has no marker, the chain loops,
   * or it runs past {@link MAX_RENAME_HOPS}. Throws when a marker cannot be
   * read.
   */
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
   * {@link executeMatch} for the async query path, with lazy content
   * hydrated. Matching is synchronous and reads bodies with getContentSync,
   * which cannot download, so a lazily-synced row would evaluate and return
   * with empty attributes where `data get` downloads its content. Each pass
   * collects the own-namespace rows whose needed body was missing, downloads
   * them through the async getContent, and matches again while a download
   * succeeded. Rows `include` rejects are never downloaded, so a caller
   * cannot make the server fetch content it may not read. A download error
   * fails the query, as it fails `data get`.
   *
   * A row that matched while empty can stop matching once downloaded, so a
   * later pass can reach rows a limit hid from an earlier one. Only then —
   * a pass after a download reaching rows not yet tried — is the limit it
   * collects under doubled, so a predicate like `!has(attributes.x)` takes
   * log(rows / limit) passes rather than one per limit window. Bodies
   * downloaded because their rows are returned leave the match set as it
   * was, so a metadata predicate downloads only the rows within the limit.
   * A pass that collected under a raised limit is followed by one at the
   * caller's limit. Each row is tried once, so the loop ends.
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

  /**
   * Matches and hydrates records for a predicate, and parses the select
   * expression — loading whatever it needs — without applying it. Own-
   * namespace rows whose needed body is not on local disk are added to
   * `missingContent` when given.
   */
  private executeMatch(
    predicate: string,
    options?: DataQueryOptions,
    missingContent?: Map<string, CatalogRow>,
    latestRuns: LatestRuns = NO_LATEST_RUNS,
    models: ResolvedModels = NO_MODELS,
  ): MatchResult {
    // No default limit — an unspecified limit returns every matching row.
    // Callers that need a cap pass one explicitly.
    const limit = options?.limit ?? Infinity;
    const includePath = options?.includeContentPath ?? false;
    const ownNamespace = this.dataRepo.namespace;
    const reportMissing = (row: CatalogRow) =>
      missingContent && row.namespace === ownNamespace
        ? () => missingContent.set(catalogRowKey(row), row)
        : undefined;

    // Parse and validate the caller's predicate first. Parsing on the raw
    // input means parse errors point at what the caller actually wrote.
    let userParsed = this.queryEnv.parse(predicate);
    const userAst = userParsed.ast as ASTNode;
    const rootIds = collectRootIdentifiers(userAst);
    validateFieldReferences(rootIds);

    // A query calling latestRun parses in an environment that has it.
    let env = this.queryEnv;
    const latestRunWorkflows = this.latestRunWorkflows(
      userAst,
      options?.select,
    );
    if (latestRunWorkflows.length > 0) {
      env = this.latestRunEnv(latestRunWorkflows, latestRuns);
      userParsed = env.parse(predicate);
    }

    // A query calling model parses in an environment where model() matches
    // the row being evaluated against its resolved definition. The row is
    // local to this call, so concurrent queries never see each other's.
    let currentRow: CatalogRow | null = null;
    const modelReferences = collectModelReferences(userAst);
    if (options?.select) {
      if (
        collectModelReferencesLenient(
          this.queryEnv.parse(options.select).ast as ASTNode,
        )
      ) {
        throw new UserError(
          `${MODEL_FUNCTION}() can only be used in the query predicate, ` +
            `not in --select`,
        );
      }
    }
    if (modelReferences.length > 0) {
      // Every call must have been resolved: an unregistered call would fail
      // on each row, and per-row failures are skipped, not reported.
      if (modelReferences.some((reference) => !models.has(reference))) {
        throw modelUnavailable();
      }
      env = (env === this.queryEnv ? env.clone() : env).registerFunction(
        `${MODEL_FUNCTION}(string): bool`,
        (reference: string) => {
          const target = models.get(reference);
          return !!currentRow && !!target &&
            currentRow.type_normalized === target.modelType &&
            currentRow.model_id === target.modelId;
        },
      );
      userParsed = env.parse(predicate);
    }

    // Implicit latest-only: unless the predicate references `version` or
    // `isLatest` at root, restrict results to rows where is_latest is true.
    // Callers opt into history by mentioning either field (e.g. `version ==
    // 2`, `version >= 0`, `isLatest == false`). String literals like
    // `name == "version-report"` do not trigger the opt-out because
    // collectRootIdentifiers walks the AST rather than the source text.
    // With latestPerStep the SQL pushdown below filters on is_step_latest
    // instead, and the CEL `isLatest == true` term is left out because an
    // older step's latest has isLatest false.
    const opensHistory = rootIds.some((id) => HISTORY_OPT_IN_FIELDS.has(id));
    const latestPerStep = options?.latestPerStep ?? false;
    const effectivePredicate = opensHistory || latestPerStep
      ? predicate
      : `(${predicate}) && isLatest == true`;
    const parsed = opensHistory || latestPerStep
      ? userParsed
      : env.parse(effectivePredicate);
    const filterAst = parsed.ast as ASTNode;

    // Parse select expression if provided
    let selectParsed: ((ctx: Record<string, unknown>) => unknown) | undefined;
    if (options?.select) {
      selectParsed = env.parse(options.select) as unknown as (
        ctx: Record<string, unknown>,
      ) => unknown;
    }

    // Detect attributes and content usage — union filter and select expression.
    // content is aliased to attributes for JSON records in the CEL context,
    // so referencing content also requires loading attributes. Only the
    // filter needs content loaded while matching: a select that reads it gets
    // the bytes in project(), after the caller's include has run.
    const needsContent = referencesContent(filterAst);
    let needsAttributes = options?.loadAttributes ??
      (referencesAttributes(filterAst) || needsContent);
    let readsContentInSelect = false;
    if (options?.select) {
      const selectAst = (selectParsed as unknown as { ast: ASTNode }).ast;
      readsContentInSelect = selectReadsContent(selectAst);
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
      // A workflow with no runs: no row can equal its latest run.
      if (runId === null) {
        return {
          records: [],
          selectParsed,
          selectReadsContent: readsContentInSelect,
          violations: [],
          hitLimit: false,
        };
      }
      whereClauses.push("workflow_run_id = ?");
      whereParams.push(runId);
    }

    const rows = whereClauses.length > 0
      ? this.catalogStore.iterateFiltered(
        whereClauses.join(" AND "),
        whereParams,
      )
      : this.catalogStore.iterate();

    // Iterate catalog rows and evaluate predicate.
    // CEL reserves "namespace" as an identifier, so we expose an "ns" alias
    // via a prototype-chain overlay — the record itself is not mutated.
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
      // attributes/content are read from disk only when evaluation touches
      // them or the row matches, so rows rejected by metadata terms never
      // read their body (swamp-club#2122). The load outcome — record or
      // error — is memoized per row; nothing is cached across queries.
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
      // `content` in a predicate is text; reading it on a binary item is an
      // error (swamp-club#2959). The check uses the catalog's content type, so
      // no bytes are read to make it.
      let readBinaryContent = false;
      const ctx = Object.create(
        record as unknown as Record<string, unknown>,
      ) as Record<string, unknown>;
      ctx["ns"] = record.namespace;
      if (
        nameLiteral !== null &&
        renameTargets.get(
            renameKey(row.namespace, row.type_normalized, row.model_id),
          ) === row.data_name
      ) {
        ctx["name"] = nameLiteral;
      }
      currentRow = row;
      Object.defineProperties(ctx, {
        attributes: { get: () => load().attributes },
        content: {
          get: () => {
            if (!isTextContentType(record.contentType)) {
              readBinaryContent = true;
              throw new Error("content of a non-text item");
            }
            const loaded = load();
            return loaded.contentType === "application/json"
              ? loaded.attributes
              : loaded.content;
          },
        },
      });
      try {
        const match = parsed(ctx);
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
          if (results.length >= limit) {
            hitLimit = true;
            break;
          }
        }
      } catch (error) {
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

    // Hydrate matched records with attributes when the predicate didn't
    // require them for filtering. Only applies to non-projected results —
    // projections handle attribute loading via AST analysis above.
    // When filterStaleRows is enabled, rows whose backing file is absent
    // are dropped during hydration — a stale catalog row with isLatest=true
    // and empty content is worse than a missing row because it wins [0]
    // selection (swamp-club#1737).
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
        writeIndex++;
      }
      keptBefore.push(writeIndex);
      for (const violation of violations) {
        violation.matchesBefore = keptBefore[violation.matchesBefore];
      }
      results.length = writeIndex;
    }

    return {
      records: results,
      selectParsed,
      selectReadsContent: readsContentInSelect,
      violations,
      hitLimit,
    };
  }

  /**
   * Applies a select projection to matched records.
   * Per-record errors (e.g. missing attribute keys) produce null instead of
   * failing the entire query, so partial results are still useful.
   */
  private project(
    results: DataRecord[],
    selectParsed: ((ctx: Record<string, unknown>) => unknown) | undefined,
    contents: Map<DataRecord, ProjectedContent> | undefined,
  ): DataRecord[] | unknown[] {
    // Apply projection if select expression provided.
    // Per-record errors (e.g. missing attribute keys) produce null instead of
    // failing the entire query, so partial results are still useful.
    // The ns alias must be available in select expressions too.
    if (selectParsed) {
      return results.map((r) => {
        try {
          const selectCtx = Object.create(
            r as unknown as Record<string, unknown>,
          ) as Record<string, unknown>;
          selectCtx["ns"] = r.namespace;
          const projected = contents?.get(r);
          if (projected) {
            selectCtx["content"] = projected.content;
            selectCtx["contentEncoding"] = projected.contentEncoding;
          } else if (r.contentType === "application/json") {
            selectCtx["content"] = r.attributes;
          }
          return coerceBigInts(selectParsed(selectCtx));
        } catch {
          return null;
        }
      });
    }

    return results;
  }

  /**
   * A record's content as a projection sees it (swamp-club#2959): JSON as its
   * parsed attributes, anything else as UTF-8 text when the bytes are valid
   * UTF-8 and base64 otherwise, the same representation `data get` returns
   * (a leading UTF-8 byte-order mark is dropped, as there). Content whose
   * bytes are not on this host — any item from another namespace in a shared
   * datastore, or a non-JSON item whose body cannot be read — is null, so it
   * is never mistaken for empty content. A row stamped with the empty
   * namespace (written before the repository set one) is this repository's
   * own, and is read like any other.
   *
   * Returns undefined when the answer needs the item's bytes.
   */
  private projectedContentWithoutBytes(
    record: DataRecord,
  ): ProjectedContent | undefined {
    if (
      record.namespace !== "" && record.namespace !== this.dataRepo.namespace
    ) {
      return { content: null, contentEncoding: null };
    }
    if (record.contentType === "application/json") {
      return { content: record.attributes, contentEncoding: "utf-8" };
    }
    return undefined;
  }

  /** Represents read bytes, or their absence, as projected content. */
  private encodeProjected(bytes: Uint8Array | null): ProjectedContent {
    return bytes
      ? encodeContent(bytes)
      : { content: null, contentEncoding: null };
  }

  /**
   * The projected content of `record`, read synchronously from local disk
   * (the querySync path, which cannot download lazily-synced bodies).
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
   * The projected content of each record a select that reads content will
   * see, for the async query path. Bodies are read with the async getContent,
   * which downloads a lazily-synced body the way `data get` does
   * (swamp-club#2962). Only records that passed the caller's include reach
   * here, so no body is read or downloaded for one the caller may not read.
   * A download error fails the query, as it fails `data get`.
   */
  private async projectedContents(
    records: DataRecord[],
    readsContent: boolean,
  ): Promise<Map<DataRecord, ProjectedContent> | undefined> {
    if (!readsContent) return undefined;
    const contents = new Map<DataRecord, ProjectedContent>();
    for (const record of records) {
      const known = this.projectedContentWithoutBytes(record);
      contents.set(
        record,
        known ?? this.encodeProjected(
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
    // Read before walking the disk; see CatalogStore.markPopulated.
    // The walk is in name order at every level (see
    // FileSystemUnifiedDataRepository.findAllGlobal), so the rows below get
    // the same rowids on every filesystem (swamp-club#3066).
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

    // Gather every row we want to write, THEN commit them to SQLite in one
    // batch. Historical metadata.yaml reads are async and slow; interleaving
    // them with individual SQLite writes would hold the database in a
    // partially-populated state across many fsyncs and, on large repos,
    // produces "database is locked" under contention.
    const rows: CatalogRow[] = [];
    for (const [, items] of byType) {
      for (const { data: latest, modelType, modelId } of items) {
        if (latest.isRenamed || latest.isDeleted) continue;
        const versions = await this.dataRepo.listVersions(
          modelType,
          modelId,
          latest.name,
        );
        if (versions.length === 0) continue;
        for (const version of versions) {
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
            if (data.isRenamed || data.isDeleted) continue;
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
    // Read before walking the disk; see CatalogStore.markPopulated.
    // The walk is in name order at every level (see
    // FileSystemUnifiedDataRepository.findAllGlobal), so the rows below get
    // the same rowids on every filesystem (swamp-club#3066).
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
        if (latest.isRenamed || latest.isDeleted) continue;
        const versions = this.dataRepo.listVersionsSync(
          modelType,
          modelId,
          latest.name,
        );
        if (versions.length === 0) continue;
        for (const version of versions) {
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
            if (data.isRenamed || data.isDeleted) continue;
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

  /** Merges the rename markers a backfill walk found into the catalog. */
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
