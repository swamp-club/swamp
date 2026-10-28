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
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { inferMethodKind, isMutatingKind } from "../../domain/models/model.ts";
import { isV2CustomDatastore } from "../../infrastructure/persistence/datastore_format_guard.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";

/**
 * How a model method run holds its model's lock (swamp-club#3934).
 *
 * - `"run"`: for the whole run. The lock's pull comes first and its push
 *   publishes what the run wrote.
 * - `"publish"`: a read or list run on a v2 extension datastore. It pulls
 *   without the lock, runs without it, and takes it only to publish what it
 *   wrote (`pull: false`, `refuseForeignVersions`), so it never waits on a
 *   writer's lock while it runs (swamp-club#1992).
 * - `"none"`: a read or list run on a filesystem or v3 datastore, which
 *   needs no lock to publish.
 */
export type MethodRunLockMode = "run" | "publish" | "none";

/**
 * Whether a method mutates its model, by its declared or name-inferred kind
 * (swamp-club#1992). A type or method that cannot be resolved counts as
 * mutating.
 */
export async function isMethodMutating(
  modelType: string,
  methodName: string,
): Promise<boolean> {
  try {
    const modelDef = await resolveModelType(modelType, getAutoResolver());
    if (!modelDef) return true;
    const method = modelDef.methods[methodName];
    return isMutatingKind(inferMethodKind(methodName, method));
  } catch {
    return true;
  }
}

/** The lock mode of a run of `methodName` on `modelType`; see {@link MethodRunLockMode}. */
export async function methodRunLockMode(options: {
  modelType: string;
  methodName: string;
  config: DatastoreConfig;
  syncService: DatastoreSyncService | undefined;
  repoContext: Pick<RepositoryContext, "commitLog">;
}): Promise<MethodRunLockMode> {
  if (await isMethodMutating(options.modelType, options.methodName)) {
    return "run";
  }
  const { config } = options;
  // Only a v2 extension datastore publishes a run's writes through the
  // model lock: a filesystem datastore has no push, and a v3 root commits
  // through its commit log whatever the locks.
  if (
    !isCustomDatastoreConfig(config) || !isV2CustomDatastore(config) ||
    !config.cachePath || options.repoContext.commitLog !== undefined
  ) {
    return "none";
  }
  // A publish that cannot read the datastore cannot tell its own version
  // from another clone's, so the run holds the lock throughout instead.
  return options.syncService?.fetchContent ? "publish" : "run";
}
