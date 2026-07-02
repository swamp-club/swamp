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
  DataQueryService,
  type ForeignContentFetcher,
} from "./data_query_service.ts";
import type { VaultService } from "../vaults/vault_service.ts";
import type { SecretRedactor } from "../secrets/mod.ts";

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
    persistentQueryService: DataQueryService,
    ephemeralQueryService: DataQueryService,
  ) {
    // Inherit the persistent query service's catalog and repo via accessing
    // its internal state is not possible, so we use a delegation pattern.
    // We extend DataQueryService but override query/querySync to merge.
    // The super constructor is called but we won't use its catalog — we
    // delegate all calls to the two backing services.
    //
    // NOTE: We need access to the persistent service's catalog and repo for
    // the super() call. Since DataQueryService doesn't expose these, we use
    // the persistent service directly and override the query methods.
    super(
      // deno-lint-ignore no-explicit-any
      (persistentQueryService as any).catalogStore,
      // deno-lint-ignore no-explicit-any
      (persistentQueryService as any).dataRepo,
    );
    this.ephemeralQueryService = ephemeralQueryService;
  }

  override setVaultService(
    vaultService: VaultService,
    redactor?: SecretRedactor,
  ): void {
    super.setVaultService(vaultService, redactor);
    this.ephemeralQueryService.setVaultService(vaultService, redactor);
  }

  override setForeignContentFetcher(fetcher: ForeignContentFetcher): void {
    super.setForeignContentFetcher(fetcher);
    this.ephemeralQueryService.setForeignContentFetcher(fetcher);
  }

  override async query(
    predicate: string,
    options?: DataQueryOptions,
  ): Promise<DataRecord[] | unknown[]> {
    const [persistentResults, ephemeralResults] = await Promise.all([
      super.query(predicate, options),
      this.ephemeralQueryService.query(predicate, options),
    ]);

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

  override querySync(
    predicate: string,
    options?: DataQueryOptions,
  ): DataRecord[] | unknown[] {
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
