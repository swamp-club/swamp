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
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { DataRecord } from "./data_record.ts";
import { ModelType } from "../models/model_type.ts";
import {
  type ASTNode,
  collectRootIdentifiers,
  referencesAttributes,
  referencesContent,
  validateFieldReferences,
} from "./query_predicate.ts";
import { isTextContentType } from "./content_type.ts";

const logger = getLogger(["swamp", "domain", "data", "query"]);

export interface DataQueryOptions {
  limit?: number;
  /** CEL projection expression. When set, results are projected and returned as unknown[]. */
  select?: string;
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

  constructor(
    private readonly catalogStore: CatalogStore,
    private readonly dataRepo: UnifiedDataRepository,
  ) {
    this.queryEnv = new Environment({
      unlistedVariablesAreDyn: true,
      homogeneousAggregateLiterals: false,
    });
  }

  /**
   * Queries data artifacts matching a CEL predicate (async version).
   * Triggers backfill if the catalog is not yet populated.
   */
  async query(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataRecord[] | unknown[]> {
    if (!this.catalogStore.isPopulated()) {
      await this.backfillAsync();
    }
    return this.executeQuery(predicate, options);
  }

  /**
   * Queries data artifacts matching a CEL predicate (sync version).
   * Used by CEL expression evaluation which must be synchronous.
   * Triggers sync backfill if the catalog is not yet populated.
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
    const limit = options?.limit ?? 100;

    // Parse and get callable evaluator
    const parsed = this.queryEnv.parse(predicate);
    const filterAst = parsed.ast as ASTNode;

    // Validate field references in the filter predicate
    const rootIds = collectRootIdentifiers(filterAst);
    validateFieldReferences(rootIds);

    // Parse select expression if provided
    let selectParsed: ((ctx: Record<string, unknown>) => unknown) | undefined;
    if (options?.select) {
      selectParsed = this.queryEnv.parse(options.select) as unknown as (
        ctx: Record<string, unknown>,
      ) => unknown;
    }

    // Detect attributes and content usage — union filter and select expression
    let needsAttributes = referencesAttributes(filterAst);
    let needsContent = referencesContent(filterAst);
    if (options?.select) {
      const selectAst = (selectParsed as unknown as { ast: ASTNode }).ast;
      if (!needsAttributes) needsAttributes = referencesAttributes(selectAst);
      if (!needsContent) needsContent = referencesContent(selectAst);
    }

    // Iterate catalog rows and evaluate predicate
    const results: DataRecord[] = [];
    for (const row of this.catalogStore.iterate()) {
      const record = this.rowToRecord(row, needsAttributes, needsContent);
      try {
        const match = parsed(record as unknown as Record<string, unknown>);
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

    // Apply projection if select expression provided
    if (selectParsed) {
      return results.map((r) =>
        selectParsed(r as unknown as Record<string, unknown>)
      );
    }

    return results;
  }

  private rowToRecord(
    row: CatalogRow,
    loadAttributes: boolean,
    loadContent: boolean,
  ): DataRecord {
    let attributes: Record<string, unknown> = {};
    let textContent = "";

    // Load raw bytes if either attributes or content needs them
    const needsBytes = (loadAttributes &&
      row.content_type === "application/json") ||
      (loadContent && isTextContentType(row.content_type));

    if (needsBytes) {
      const rawBytes = this.dataRepo.getContentSync(
        ModelType.create(row.type_normalized),
        row.model_id,
        row.data_name,
      );
      if (rawBytes) {
        const decoded = new TextDecoder().decode(rawBytes);
        if (loadContent && isTextContentType(row.content_type)) {
          textContent = decoded;
        }
        if (
          loadAttributes && row.content_type === "application/json"
        ) {
          try {
            attributes = JSON.parse(decoded) as Record<string, unknown>;
          } catch {
            // Not valid JSON, use empty attributes
          }
        }
      }
    }

    let tags: Record<string, string> = {};
    try {
      tags = JSON.parse(row.tags) as Record<string, string>;
    } catch {
      // Invalid tags JSON, use empty
    }

    return {
      id: row.id,
      name: row.data_name,
      version: row.version,
      createdAt: row.created_at,
      attributes,
      tags,
      modelName: row.model_name,
      modelType: row.type_normalized,
      specName: row.spec_name,
      dataType: row.data_type,
      contentType: row.content_type,
      lifetime: row.lifetime,
      ownerType: row.owner_type,
      streaming: row.streaming === 1,
      size: row.size,
      content: textContent,
    };
  }

  private async backfillAsync(): Promise<void> {
    const allData = await this.dataRepo.findAllGlobal();
    for (const { data, modelType, modelId } of allData) {
      if (data.isRenamed || data.isDeleted) continue;
      this.catalogStore.upsert({
        type_normalized: modelType.normalized,
        model_id: modelId,
        data_name: data.name,
        id: data.id,
        version: data.version,
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
      });
    }
    this.catalogStore.markPopulated();
  }

  private backfillSync(): void {
    const allData = this.dataRepo.findAllGlobalSync();
    for (const { data, modelType, modelId } of allData) {
      if (data.isRenamed || data.isDeleted) continue;
      this.catalogStore.upsert({
        type_normalized: modelType.normalized,
        model_id: modelId,
        data_name: data.name,
        id: data.id,
        version: data.version,
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
      });
    }
    this.catalogStore.markPopulated();
  }
}
