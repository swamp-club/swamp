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

import { isJsonMediaType } from "../data/content_type.ts";
import { fromData } from "../data/data_record_mapper.ts";
import type { DataRecord } from "../data/data_record.ts";
import type { Data } from "../data/data.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { resourceLoadGuardOf } from "../data/resource_load_guard.ts";
import type { ModelType } from "../models/model_type.ts";

/**
 * the latest record modelName wrote as dataName, read as stored for the typed
 * evaluator to adapt: tagged fields keep their reference text and no vault is
 * read; null when nothing was written or content is not JSON
 */
export async function storedResourceRecord(
  dataRepo: UnifiedDataRepository,
  type: ModelType,
  modelId: string,
  dataName: string,
  modelName: string,
): Promise<DataRecord | null> {
  return (await readStoredResource(
    dataRepo,
    type,
    modelId,
    dataName,
    modelName,
  )).record;
}

async function readStoredResource(
  dataRepo: UnifiedDataRepository,
  type: ModelType,
  modelId: string,
  dataName: string,
  modelName: string,
): Promise<{ data: Data | null; record: DataRecord | null }> {
  const data = await dataRepo.findByName(type, modelId, dataName);
  // the media type is matched as a media type, parameters and case aside, not
  // as the exact string
  if (!data || !isJsonMediaType(data.contentType)) {
    return { data, record: null };
  }
  // The mapper reads the content through getContent; make it local and
  // current first, as the data.latest accessor does. A failed download never
  // fails a lookup that would otherwise succeed.
  try {
    await dataRepo.ensureContentLocal(type, modelId, dataName, data.version);
  } catch {
    // The read below answers with what is local.
  }
  const record = await fromData(data, type, modelId, dataRepo, {
    isLatest: true,
    modelName,
    dataName,
  });
  return { data, record };
}

/**
 * a typed consuming evaluator is handed the stored record to adapt so each
 * tagged field is a Secret; any other gets the parsed JSON or text; undefined
 * when nothing was written, so the caller uses the raw result
 */
export async function modelMethodResourceResult(
  dataRepo: UnifiedDataRepository,
  type: ModelType,
  modelId: string,
  dataName: string,
  modelName: string,
): Promise<unknown> {
  const { data, record } = await readStoredResource(
    dataRepo,
    type,
    modelId,
    dataName,
    modelName,
  );
  if (record) return record;
  const guard = resourceLoadGuardOf(dataRepo);
  const item = {
    modelType: type.normalized,
    modelName,
    dataName,
    version: data?.version,
  };
  guard.assertLoadable(item, data?.size ?? 0);
  const raw = await dataRepo.getContent(type, modelId, dataName, data?.version);
  if (!raw) return undefined;
  // any content type is tried as JSON below, so the parse is always priced
  guard.assertParsable(item, raw);
  const text = new TextDecoder().decode(raw);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
