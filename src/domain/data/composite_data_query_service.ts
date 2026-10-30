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

import type { DataRecord } from "./data_record.ts";
import {
  type DataQueryOptions,
  type DataQueryPage,
  DataQueryService,
  type LatestRecordOptions,
} from "./data_query_service.ts";
import { UserError } from "../errors.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import type { UnifiedDataRepository } from "./repositories.ts";

function deduplicateRecords(
  ephemeral: DataRecord[],
  persistent: DataRecord[],
): DataRecord[] {
  const seen = new Set<string>();
  const results: DataRecord[] = [];

  for (const r of ephemeral) {
    const key = `${r.modelType}:${r.modelId}:${r.name}:${r.version}`;
    seen.add(key);
    results.push(r);
  }
  for (const r of persistent) {
    const key = `${r.modelType}:${r.modelId}:${r.name}:${r.version}`;
    if (!seen.has(key)) results.push(r);
  }

  return results;
}

export class CompositeDataQueryService extends DataQueryService {
  private readonly ephemeralQueryService: DataQueryService;

  constructor(
    persistentCatalog: CatalogStore,
    persistentRepo: UnifiedDataRepository,
    ephemeralQueryService: DataQueryService,
  ) {
    super(persistentCatalog, persistentRepo);
    this.ephemeralQueryService = ephemeralQueryService;
  }

  // Ephemeral wins, matching the precedence deduplicateRecords gives query().
  override async getLatestRecord(
    modelName: string,
    dataName: string,
    namespace?: string,
    options?: LatestRecordOptions,
  ): Promise<DataRecord | null> {
    return await this.ephemeralQueryService.getLatestRecord(
      modelName,
      dataName,
      namespace,
      options,
    ) ?? await super.getLatestRecord(modelName, dataName, namespace, options);
  }

  // Ephemeral names first: they belong to the run in progress, so they are
  // newer than anything in the persistent catalog.
  override latestDataNamesForSpec(
    modelName: string,
    specName: string,
    namespace?: string,
  ): string[] {
    return [
      ...new Set([
        ...this.ephemeralQueryService.latestDataNamesForSpec(
          modelName,
          specName,
          namespace,
        ),
        ...super.latestDataNamesForSpec(modelName, specName, namespace),
      ]),
    ];
  }

  override async query(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataRecord[] | unknown[]> {
    // Merging two sorted streams into one keyset order is not supported
    // (swamp-club#4177).
    if (options?.sort || options?.after) {
      throw new UserError(
        "Sorted and cursor-paged queries are not supported during a " +
          "workflow run",
      );
    }
    const [persistentResults, ephemeralResults] = await Promise.all([
      super.query(predicate, options),
      this.ephemeralQueryService.query(predicate, options),
    ]);

    // Projections (select) return opaque values — dedup is not possible
    if (options?.select) {
      return [
        ...(ephemeralResults as unknown[]),
        ...(persistentResults as unknown[]),
      ];
    }

    return deduplicateRecords(
      ephemeralResults as DataRecord[],
      persistentResults as DataRecord[],
    );
  }

  override async queryPage(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataQueryPage> {
    return { results: await this.query(predicate, options) };
  }

  override querySync(
    predicate: string,
    options?: DataQueryOptions,
  ): DataRecord[] | unknown[] {
    if (options?.sort || options?.after) {
      throw new UserError(
        "Sorted and cursor-paged queries are not supported during a " +
          "workflow run",
      );
    }
    const persistentResults = super.querySync(predicate, options);
    const ephemeralResults = this.ephemeralQueryService.querySync(
      predicate,
      options,
    );

    if (options?.select) {
      return [
        ...(ephemeralResults as unknown[]),
        ...(persistentResults as unknown[]),
      ];
    }

    return deduplicateRecords(
      ephemeralResults as DataRecord[],
      persistentResults as DataRecord[],
    );
  }
}
