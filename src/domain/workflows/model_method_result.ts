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

import { fromData } from "../data/data_record_mapper.ts";
import type { DataRecord } from "../data/data_record.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import type { ModelType } from "../models/model_type.ts";

/**
 * The latest record `modelName` wrote under `specName`, read as stored for
 * the typed evaluator to adapt (design/enablers/typed-secrets.md Section 4.5
 * item 4, typed-secrets 3.5): its tagged fields keep their reference text and
 * no vault is read. Null when nothing was written under the spec, or when
 * the content is not a JSON document, which keeps the parsed-content shape
 * `model.method` returns with the option off.
 */
export async function storedResourceRecord(
  dataRepo: UnifiedDataRepository,
  type: ModelType,
  modelId: string,
  specName: string,
  modelName: string,
): Promise<DataRecord | null> {
  const data = await dataRepo.findByName(type, modelId, specName);
  if (!data || data.contentType !== "application/json") return null;
  // The mapper reads the content through getContent; make it local and
  // current first, as the data.latest accessor does. A failed download never
  // fails a lookup that would otherwise succeed.
  try {
    await dataRepo.ensureContentLocal(type, modelId, specName, data.version);
  } catch {
    // The read below answers with what is local.
  }
  return await fromData(data, type, modelId, dataRepo, {
    isLatest: true,
    modelName,
    dataName: specName,
  });
}

/**
 * What `model.method` answers for the latest resource `modelName` wrote
 * under `specName`. A typed consuming evaluator is handed the stored record,
 * which it adapts so each tagged field is a `Secret` (Section 4.5 item 4);
 * any other evaluator receives what it always has, the parsed JSON content
 * or the text. Undefined when nothing was written, so the caller falls back
 * to the method's raw result.
 */
export async function modelMethodResourceResult(
  dataRepo: UnifiedDataRepository,
  type: ModelType,
  modelId: string,
  specName: string,
  modelName: string,
  typedConsumer: boolean,
): Promise<unknown> {
  if (typedConsumer) {
    const stored = await storedResourceRecord(
      dataRepo,
      type,
      modelId,
      specName,
      modelName,
    );
    if (stored) return stored;
  }
  const raw = await dataRepo.getContent(type, modelId, specName);
  if (!raw) return undefined;
  const text = new TextDecoder().decode(raw);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
