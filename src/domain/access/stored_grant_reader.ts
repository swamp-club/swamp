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

/**
 * for serve's boot reconcilers of file and admin grants, which run before the
 * policy snapshot is first built
 */

import type { Data } from "../data/data.ts";
import type {
  UnifiedDataRepository,
  UnreadableModelRecord,
} from "../data/repositories.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
  GrantSchema,
} from "../models/access/grant_model.ts";
import { ModelType } from "../models/model_type.ts";
import {
  failedAccessData,
  type FailedRecord,
  UnreadableAccessRecordsError,
} from "./unreadable_access_records.ts";

const GRANT_ACCESS_DATA_NAME = "grant-main";

export interface StoredGrant {
  grant: Grant;
  data: Data;
  modelType: ModelType;
  modelId: string;
}

/**
 * a reconciler working without a grant it could not load could duplicate or
 * orphan it, so any unreadable, corrupt or invalid grant makes the whole read
 * throw before anything is written; mid-write versions are skipped
 */
export async function readStoredGrants(
  dataRepo: UnifiedDataRepository,
): Promise<StoredGrant[]> {
  const skipped: UnreadableModelRecord[] = [];
  const orphanedType = ModelType.create(`@${GRANT_MODEL_TYPE.normalized}`);
  const [canonical, orphaned] = await Promise.all([
    dataRepo.findAllForType(GRANT_MODEL_TYPE, { unreadable: skipped }),
    dataRepo.findAllForType(orphanedType, { unreadable: skipped }).catch(
      (error) => {
        if (error instanceof Deno.errors.NotFound) return [];
        throw error;
      },
    ),
  ]);
  const failed: FailedRecord[] = failedAccessData(
    skipped,
    GRANT_ACCESS_DATA_NAME,
  ).filter((failure) => !(failure.error instanceof Deno.errors.NotFound));

  const grants: StoredGrant[] = [];
  for (const { data, modelType, modelId } of [...canonical, ...orphaned]) {
    if (data.name !== GRANT_ACCESS_DATA_NAME) continue;
    let content: Uint8Array | null;
    try {
      content = await dataRepo.getContent(modelType, modelId, data.name);
    } catch (error) {
      failed.push({ modelType, modelId, error, cause: "unreadable" });
      continue;
    }
    if (!content) continue;
    let attrs: unknown;
    try {
      attrs = JSON.parse(new TextDecoder().decode(content));
    } catch (error) {
      failed.push({ modelType, modelId, error, cause: "corrupt" });
      continue;
    }
    const parsed = GrantSchema.safeParse(attrs);
    if (!parsed.success) {
      failed.push({
        modelType,
        modelId,
        error: parsed.error,
        cause: "unrecognised",
      });
      continue;
    }
    grants.push({ grant: parsed.data, data, modelType, modelId });
  }
  if (failed.length > 0) {
    throw UnreadableAccessRecordsError.forFailures("grant", failed);
  }
  return grants;
}
