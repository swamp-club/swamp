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

import { getLogger } from "@logtape/logtape";
import { Environment } from "cel-js";
import type {
  CatalogRow,
  CatalogStore,
} from "../../infrastructure/persistence/catalog_store.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { DataRecord } from "./data_record.ts";
import {
  type ASTNode,
  collectRootIdentifiers,
  HISTORY_OPT_IN_FIELDS,
  referencesAttributes,
  referencesContent,
  validateFieldReferences,
} from "./query_predicate.ts";
import type { ModelType } from "../models/model_type.ts";
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
export class DataQueryService {
  private readonly queryEnv: Environment;
  private vaultService?: VaultService;
  private redactor?: SecretRedactor;

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
      await this.backfillAsync();
    }
    const results = this.executeQuery(predicate, options);

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

    // Iterate catalog rows and evaluate predicate.
    // CEL reserves "namespace" as an identifier, so we expose an "ns" alias
    // via a prototype-chain overlay — the record itself is not mutated.
    const results: DataRecord[] = [];
    for (const row of this.catalogStore.iterate()) {
      const record = this.rowToRecord(row, needsAttributes, needsContent);
      const ctx = Object.create(
        record as unknown as Record<string, unknown>,
      ) as Record<string, unknown>;
      ctx["ns"] = record.namespace;
      try {
        const match = parsed(ctx);
        if (match === true) {
          results.push(record);
          if (results.length >= limit) break;
        }
      } catch (error) {
        logger
          .debug`Query predicate skipped row ${row.model_name}/${row.data_name}: ${
          String(error)
        }`;
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
          return selectParsed(selectCtx);
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
    // Gather every (row, isLatest) we want to write, THEN commit them to
    // SQLite in one batch. Historical metadata.yaml reads are async and
    // slow; interleaving them with individual SQLite writes would hold the
    // database in a partially-populated state across many fsyncs and, on
    // large repos, produces "database is locked" under contention.
    const rows: CatalogRow[] = [];
    for (const { data: latest, modelType, modelId } of allData) {
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
            this.toCatalogRow(data, modelType, modelId, version === maxVersion),
          );
        } catch (error) {
          // Skip individual corrupted versions rather than abort the entire
          // backfill — a half-populated catalog left behind would force
          // every subsequent query to retry from scratch.
          logger
            .debug`Skipping ${modelType.normalized}/${modelId}/${latest.name}@${version} during backfill: ${
            String(error)
          }`;
        }
      }
    }
    this.catalogStore.bulkReplaceAll(rows);
    this.catalogStore.markPopulated();
  }

  private backfillSync(): void {
    const allData = this.dataRepo.findAllGlobalSync();
    const rows: CatalogRow[] = [];
    for (const { data: latest, modelType, modelId } of allData) {
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
            this.toCatalogRow(data, modelType, modelId, version === maxVersion),
          );
        } catch (error) {
          logger
            .debug`Skipping ${modelType.normalized}/${modelId}/${latest.name}@${version} during backfill: ${
            String(error)
          }`;
        }
      }
    }
    this.catalogStore.bulkReplaceAll(rows);
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
