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
import type { CatalogRow, CatalogStore } from "./catalog_store.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type {
  StoredReportData,
  StoredReportOwner,
} from "../../domain/reports/stored_report_data.ts";
import {
  mapBounded,
  SEARCH_SCAN_SHARE,
  withScanPermit,
} from "./scan_permits.ts";

const logger = getLogger(["swamp", "persistence", "catalog-reports"]);

export interface FindLatestReportDataOptions {
  /** The one owner whose reports to return; omitted, every owner's. */
  owner?: StoredReportOwner;
  /** A serve request's; once it aborts, no further read starts. */
  signal?: AbortSignal;
}

/**
 * The latest version of every stored report markdown in this repository's
 * namespace, or of one owner's (swamp-club#4075). Candidates come from the
 * catalog by tag, so only report items' metadata is read, through the search
 * share of the process-wide scan permits; the cost grows with reports, not
 * with all data. A missing catalog is backfilled first, and one being rebuilt
 * is waited for.
 *
 * Callers keep their own report-markdown check: the catalog narrows the
 * candidates, the read metadata decides. A rename marker is skipped, since the
 * name it points to has its own row, and each data name is returned once, as
 * the full walk does. A row whose version is not on disk, or whose read fails
 * (empty, unparsable, outside the model's directory), is left out with a
 * warning naming the report and its owner rather than failing the search,
 * unless `signal` has aborted, whose reason is then raised.
 */
export async function findLatestReportData(
  dataQueryService: Pick<DataQueryService, "ensurePopulated">,
  catalogStore: Pick<CatalogStore, "iterateFiltered">,
  dataRepo: Pick<UnifiedDataRepository, "namespace" | "findByName">,
  options: FindLatestReportDataOptions = {},
): Promise<StoredReportData[]> {
  const { owner, signal } = options;
  await dataQueryService.ensurePopulated();
  signal?.throwIfAborted();

  const clauses = [
    "namespace = ?",
    "data_type = ?",
    "content_type = ?",
    "is_latest = 1",
    "is_pending = 0",
  ];
  const params: string[] = [dataRepo.namespace, "report", "text/markdown"];
  if (owner) {
    clauses.push("type_normalized = ?", "model_id = ?");
    params.push(owner.type.normalized, owner.modelId);
  }
  const rows = [
    ...catalogStore.iterateFiltered(clauses.join(" AND "), params),
  ];

  const read = await mapBounded(
    rows,
    SEARCH_SCAN_SHARE,
    (row) => readRow(row, dataRepo, signal),
    signal,
  );

  const seen = new Set<string>();
  const items: StoredReportData[] = [];
  for (const item of read) {
    if (!item) continue;
    const key =
      `${item.modelType.normalized}\0${item.modelId}\0${item.data.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

async function readRow(
  row: CatalogRow,
  dataRepo: Pick<UnifiedDataRepository, "findByName">,
  signal?: AbortSignal,
): Promise<StoredReportData | null> {
  try {
    const modelType = ModelType.create(row.type_normalized);
    const data = await withScanPermit(
      "search",
      () =>
        dataRepo.findByName(
          modelType,
          row.model_id,
          row.data_name,
          row.version,
        ),
      signal,
    );
    if (!data) {
      logger
        .warn`Left report ${row.data_name} of ${row.model_name} (${row.type_normalized}) out of the results: version ${row.version}, which the data catalog lists as latest, is missing or empty on disk. The catalog may be out of date; run swamp doctor datastores to check it.`;
      return null;
    }
    if (data.isRenamed) return null;
    return { data, modelType, modelId: row.model_id };
  } catch (error) {
    signal?.throwIfAborted();
    logger
      .warn`Left report ${row.data_name} of ${row.model_name} (${row.type_normalized}) out of the results: version ${row.version} could not be read: ${error}`;
    return null;
  }
}
