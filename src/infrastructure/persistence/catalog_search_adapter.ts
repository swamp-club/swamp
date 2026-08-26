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

import type { CatalogRow, CatalogStore } from "./catalog_store.ts";
import type { DataSearchItem } from "../../libswamp/mod.ts";
import type { DataQueryService } from "../../domain/data/data_query_service.ts";

function catalogRowToSearchItem(row: CatalogRow): DataSearchItem {
  let tags: Record<string, string> = {};
  try {
    tags = JSON.parse(row.tags) as Record<string, string>;
  } catch {
    // empty
  }
  return {
    id: row.id,
    name: row.data_name,
    version: row.version,
    contentType: row.content_type,
    type: row.data_type,
    lifetime: row.lifetime,
    ownerType: row.owner_type,
    ownerRef: row.owner_ref,
    modelId: row.model_id,
    modelName: row.model_name,
    modelType: row.type_normalized,
    streaming: row.streaming === 1,
    size: row.size,
    createdAt: row.created_at,
    tags,
    workflowTag: tags.workflow,
    jobTag: tags.job,
    stepTag: tags.step,
  };
}

export async function findLatestItemsFromCatalog(
  dataQueryService: DataQueryService,
  catalogStore: CatalogStore,
): Promise<DataSearchItem[]> {
  await dataQueryService.ensurePopulated();
  const items: DataSearchItem[] = [];
  for (const row of catalogStore.iterateFiltered("is_latest = ?", [1])) {
    items.push(catalogRowToSearchItem(row));
  }
  return items;
}
