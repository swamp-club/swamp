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

import type { Data } from "../data/data.ts";
import type { DataHandle } from "../models/model.ts";
import type { ModelType } from "../models/model_type.ts";

/**
 * Narrow interface for the data repository dependency.
 * Avoids importing the infrastructure layer directly.
 */
interface DataRepository {
  findAllForModel(type: ModelType, modelId: string): Promise<Data[]>;
}

/**
 * Builds DataHandle[] from persisted data for a given model.
 *
 * This is the single source of truth for report data handles across all
 * invocation paths (model run, standalone report, workflow post-run).
 * By reading from the data repository, reports get full metadata
 * (contentType, lifetime, etc.) rather than hollow reconstructions.
 */
export async function buildReportDataHandles(
  dataRepo: DataRepository,
  modelType: ModelType,
  modelId: string,
): Promise<DataHandle[]> {
  const allData = await dataRepo.findAllForModel(modelType, modelId);
  return allData
    .filter((d) => d.lifecycle === "active")
    .map((d) => ({
      name: d.name,
      specName: d.tags["specName"] ?? d.name,
      kind: (d.tags["type"] === "file" ? "file" : "resource") as
        | "resource"
        | "file",
      dataId: d.id,
      version: d.version,
      size: d.size ?? 0,
      tags: d.tags,
      metadata: {
        contentType: d.contentType,
        lifetime: d.lifetime,
        garbageCollection: d.garbageCollection,
        streaming: d.streaming,
        tags: d.tags,
        ownerDefinition: d.ownerDefinition,
      } as DataHandle["metadata"],
    }));
}
