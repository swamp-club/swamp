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
import type { UnifiedDataRepository } from "./repositories.ts";
import type { DataRecord } from "./data_record.ts";
import {
  type ASTNode,
  collectRootIdentifiers,
  extractModelNameEquality,
  HISTORY_OPT_IN_FIELDS,
  referencesAttributes,
  referencesContent,
  validateFieldReferences,
} from "./query_predicate.ts";
import { ModelType } from "../models/model_type.ts";
import type { Data } from "./data.ts";
import { fromRow } from "./data_record_mapper.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";
import { resolveVaultRefsInData } from "../models/data_writer.ts";

const logger = getLogger(["swamp", "domain", "data", "query"]);

export interface DataQueryOptions {
  limit?: number;
  /** CEL projection expression. When set, results are projected and returned as unknown[]. */
  select?: string;
  /** Force-load JSON attributes even when the predicate doesn't reference them. */
  loadAttributes?: boolean;
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

export class DataQueryService {
  private readonly queryEnv: Environment;
  private vaultService?: VaultService;
  private redactor?: SecretRedactor;
  private foreignContentFetcher?: ForeignContentFetcher;
  private readonly foreignContentCache = new Map<string, Uint8Array | null>();
  private backfillPromise: Promise<void> | null = null;

  constructor(
    private readonly catalogStore: CatalogStore,
    private readonly dataRepo: UnifiedDataRepository,
  ) {
    this.queryEnv = new Environment({
      unlistedVariablesAreDyn: true,
      homogeneousAggregateLiterals: false,
    });
  }

  /** Configures vault resolution for query results. */
  setVaultService(
    vaultService: VaultService,
    redactor?: SecretRedactor,
  ): void {
    this.vaultService = vaultService;
    this.redactor = redactor;
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
   * 2. If the catalog is not populated and the row exists but the on-disk
   *    data is gone (stale row after invalidate()), fall through.
   * 3. If the catalog is not populated and no row exists (or row was stale),
   *    run a scoped backfill for just this (modelName, dataName) pair, then
   *    retry the indexed lookup.
   */
  async getLatestRecord(
    modelName: string,
    dataName: string,
    namespace?: string,
  ): Promise<DataRecord | null> {
    const populated = this.catalogStore.isPopulated();

    // If a full backfill is already in-flight, await it — it will populate
    // everything including our target.
    if (!populated && this.backfillPromise) {
      await this.backfillPromise;
      return this.buildRecordFromRow(modelName, dataName, namespace);
    }

    // Tier 1: try the indexed SQL lookup.
    const row = this.catalogStore.findLatestRow(modelName, dataName, namespace);
    if (row) {
      if (populated) {
        return this.buildRecordFromRow(modelName, dataName, namespace, row);
      }
      // Catalog not populated — verify the data still exists on disk to
      // guard against stale rows left behind after invalidate().
      const content = this.dataRepo.getContentSync(
        ModelType.create(row.type_normalized),
        row.model_id,
        row.data_name,
        row.version,
      );
      if (content !== null) {
        return this.buildRecordFromRow(modelName, dataName, namespace, row);
      }
      // Stale row — fall through to scoped backfill
    }

    if (populated) return null;

    // Tier 2: scoped backfill for just this (modelName, dataName) pair.
    await this.scopedBackfill(modelName, dataName);
    const freshRow = this.catalogStore.findLatestRow(
      modelName,
      dataName,
      namespace,
    );
    if (!freshRow) return null;
    // Verify the row points to real on-disk data (it may be the same
    // stale row that triggered the scoped backfill).
    const freshContent = this.dataRepo.getContentSync(
      ModelType.create(freshRow.type_normalized),
      freshRow.model_id,
      freshRow.data_name,
      freshRow.version,
    );
    if (freshContent === null) return null;
    return this.buildRecordFromRow(modelName, dataName, namespace, freshRow);
  }

  private async buildRecordFromRow(
    modelName: string,
    dataName: string,
    namespace: string | undefined,
    row?: CatalogRow | null,
  ): Promise<DataRecord | null> {
    const r = row ?? this.catalogStore.findLatestRow(
      modelName,
      dataName,
      namespace,
    );
    if (!r) return null;
    const record = fromRow(r, this.dataRepo, true, false);
    if (this.vaultService && Object.keys(record.attributes).length > 0) {
      try {
        await resolveVaultRefsInData(
          record.attributes,
          this.vaultService,
          this.redactor,
        );
      } catch {
        // Leave unresolved
      }
    }
    return record;
  }

  private async scopedBackfill(
    modelName: string,
    dataName: string,
  ): Promise<void> {
    const items = await this.dataRepo.findByTaggedName(modelName, dataName);

    for (const { data: latest, modelType, modelId } of items) {
      if (latest.isRenamed || latest.isDeleted) continue;
      this.catalogStore.upsert(
        this.toCatalogRow(latest, modelType, modelId, true),
      );
    }
  }

  /**
   * Queries data artifacts matching a CEL predicate.
   * Triggers backfill if the catalog is not yet populated.
   * Vault references in JSON attributes are resolved when a VaultService
   * is configured. Individual resolution failures leave refs unresolved.
   */
  async query(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataRecord[] | unknown[]> {
    if (!this.catalogStore.isPopulated()) {
      if (this.backfillPromise) {
        await this.backfillPromise;
      } else {
        const promise = this.backfillAsync();
        this.backfillPromise = promise;
        try {
          await promise;
        } finally {
          this.backfillPromise = null;
        }
      }
    }
    const results = this.executeQuery(predicate, options);

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

    // Resolve vault references in result attributes
    if (this.vaultService && Array.isArray(results)) {
      for (const item of results) {
        if (
          typeof item === "object" && item !== null && "attributes" in item
        ) {
          const record = item as DataRecord;
          if (Object.keys(record.attributes).length > 0) {
            try {
              await resolveVaultRefsInData(
                record.attributes,
                this.vaultService,
                this.redactor,
              );
            } catch {
              // Leave unresolved — vault unavailable or key missing
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
   * NOTE: Vault resolution does NOT happen in the sync path.
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
    // No default limit — an unspecified limit returns every matching row.
    // Callers that need a cap pass one explicitly.
    const limit = options?.limit ?? Infinity;

    // Parse and validate the caller's predicate first. Parsing on the raw
    // input means parse errors point at what the caller actually wrote.
    const userParsed = this.queryEnv.parse(predicate);
    const userAst = userParsed.ast as ASTNode;
    const rootIds = collectRootIdentifiers(userAst);
    validateFieldReferences(rootIds);

    // Implicit latest-only: unless the predicate references `version` or
    // `isLatest` at root, restrict results to rows where is_latest is true.
    // Callers opt into history by mentioning either field (e.g. `version ==
    // 2`, `version >= 0`, `isLatest == false`). String literals like
    // `name == "version-report"` do not trigger the opt-out because
    // collectRootIdentifiers walks the AST rather than the source text.
    const opensHistory = rootIds.some((id) => HISTORY_OPT_IN_FIELDS.has(id));
    const effectivePredicate = opensHistory
      ? predicate
      : `(${predicate}) && isLatest == true`;
    const parsed = opensHistory
      ? userParsed
      : this.queryEnv.parse(effectivePredicate);
    const filterAst = parsed.ast as ASTNode;

    // Parse select expression if provided
    let selectParsed: ((ctx: Record<string, unknown>) => unknown) | undefined;
    if (options?.select) {
      selectParsed = this.queryEnv.parse(options.select) as unknown as (
        ctx: Record<string, unknown>,
      ) => unknown;
    }

    // Detect attributes and content usage — union filter and select expression
    let needsAttributes = options?.loadAttributes ??
      referencesAttributes(filterAst);
    let needsContent = referencesContent(filterAst);
    if (options?.select) {
      const selectAst = (selectParsed as unknown as { ast: ASTNode }).ast;
      if (!needsAttributes) needsAttributes = referencesAttributes(selectAst);
      if (!needsContent) needsContent = referencesContent(selectAst);
    }

    // SQL pushdown: pre-filter rows in SQLite before CEL evaluation.
    // Only trivially correct translations are pushed down; the full CEL
    // predicate still evaluates on every row returned by SQL.
    const whereClauses: string[] = [];
    const whereParams: (string | number)[] = [];

    if (!opensHistory) {
      whereClauses.push("is_latest = ?");
      whereParams.push(1);
    }

    const modelNameLiteral = extractModelNameEquality(userAst);
    if (modelNameLiteral !== null) {
      whereClauses.push("model_name = ?");
      whereParams.push(modelNameLiteral);
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
    const needsHydration = !needsAttributes && !selectParsed;
    const matchedRows: CatalogRow[] = [];
    for (const row of rows) {
      const record = this.rowToRecord(row, needsAttributes, needsContent);
      const ctx = Object.create(
        record as unknown as Record<string, unknown>,
      ) as Record<string, unknown>;
      ctx["ns"] = record.namespace;
      try {
        const match = parsed(ctx);
        if (match === true) {
          results.push(record);
          if (needsHydration) matchedRows.push(row);
          if (results.length >= limit) break;
        }
      } catch (error) {
        logger
          .debug`Query predicate skipped row ${row.model_name}/${row.data_name}: ${
          String(error)
        }`;
      }
    }

    // Hydrate matched records with attributes when the predicate didn't
    // require them for filtering. Only applies to non-projected results —
    // projections handle attribute loading via AST analysis above.
    if (needsHydration) {
      for (let i = 0; i < results.length; i++) {
        results[i] = this.rowToRecord(matchedRows[i], true, needsContent);
      }
    }

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
          return coerceBigInts(selectParsed(selectCtx));
        } catch {
          return null;
        }
      });
    }

    return results;
  }

  private rowToRecord(
    row: CatalogRow,
    loadAttributes: boolean,
    loadContent: boolean,
  ): DataRecord {
    return fromRow(row, this.dataRepo, loadAttributes, loadContent);
  }

  private async backfillAsync(): Promise<void> {
    const allData = await this.dataRepo.findAllGlobal();

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
        const maxVersion = Math.max(...versions);
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
                version === maxVersion,
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

    const ns = this.dataRepo.namespace;
    if (ns && ns.length > 0) {
      this.catalogStore.bulkReplaceNamespace(ns, rows);
    } else {
      this.catalogStore.bulkReplaceAll(rows);
    }
    this.catalogStore.markPopulated();
  }

  private backfillSync(): void {
    const allData = this.dataRepo.findAllGlobalSync();

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
        const maxVersion = Math.max(...versions);
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
                version === maxVersion,
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
    const syncNs = this.dataRepo.namespace;
    if (syncNs && syncNs.length > 0) {
      this.catalogStore.bulkReplaceNamespace(syncNs, rows);
    } else {
      this.catalogStore.bulkReplaceAll(rows);
    }
    this.catalogStore.markPopulated();
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
      model_name: data.tags["modelName"] ?? "",
      spec_name: data.tags["specName"] ?? "",
      data_type: data.tags["type"] ?? "",
      content_type: data.contentType,
      lifetime: data.lifetime,
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
