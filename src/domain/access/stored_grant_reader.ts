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
 * Reads every stored grant for serve's boot reconcilers of file and admin
 * grants, which run before the policy snapshot is first built.
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

/** The access data a grant model keeps. */
const GRANT_ACCESS_DATA_NAME = "grant-main";

/** A stored grant, with the data and model it was read from. */
export interface StoredGrant {
  grant: Grant;
  data: Data;
  modelType: ModelType;
  modelId: string;
}

/**
 * Every stored grant, canonical and orphaned, read from its `grant-main`.
 *
 * A reconciler that worked without a grant it could not load could write a
 * duplicate of it or orphan it, so any grant that cannot be read, is
 * corrupt, or fails this build's validation makes the whole read throw
 * {@link UnreadableAccessRecordsError}, naming each with its fix, before
 * anything is written (swamp-club#3386). Other data a grant model keeps,
 * such as a method-summary report, is not read. A version whose metadata is
 * missing is mid-write and skipped, as is a grant with no content.
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
