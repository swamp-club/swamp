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

import {
  findMixedKindNames,
  type MixedKindDataName,
} from "../../domain/data/mixed_kind_data_name.ts";
import type { CatalogStore } from "./catalog_store.ts";

/**
 * read-only over the catalog, so it sees every datastore without reading
 * version files, and runs no data query, so no backfill hides what it measures
 */
export function scanMixedKindNames(
  catalogStore: CatalogStore,
  namespace: string,
): MixedKindDataName[] {
  return findMixedKindNames(
    catalogStore.versionKinds(namespace).map((row) => ({
      modelType: row.type_normalized,
      modelId: row.model_id,
      modelName: row.model_name,
      dataName: row.data_name,
      version: row.version,
      dataType: row.data_type,
      recordKind: row.record_kind,
      specName: row.spec_name,
      lifecycle: row.lifecycle,
    })),
  );
}
