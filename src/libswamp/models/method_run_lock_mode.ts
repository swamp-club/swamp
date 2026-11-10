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
import {
  inferMethodKind,
  isMutatingKind,
  type MethodKind,
} from "../../domain/models/model.ts";
import { isV2CustomDatastore } from "../../infrastructure/persistence/datastore_format_guard.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";

/**
 * run holds the lock for the whole run; publish (read or list on a v2 extension
 * datastore) pulls and runs unlocked and only tries the lock to publish,
 * deferring if busy; none needs no lock or has no sync service
 */
export type MethodRunLockMode = "run" | "publish" | "none";

/** a type or method that cannot be resolved counts as mutating */
export async function isMethodMutating(
  modelType: string,
  methodName: string,
): Promise<boolean> {
  return isMutatingKind(await methodKindOf(modelType, methodName));
}

export async function methodKindOf(
  modelType: string,
  methodName: string,
): Promise<MethodKind | undefined> {
  try {
    const modelDef = await resolveModelType(modelType, getAutoResolver());
    if (!modelDef) return undefined;
    return inferMethodKind(methodName, modelDef.methods[methodName]);
  } catch {
    return undefined;
  }
}

export async function methodRunLockMode(options: {
  modelType: string;
  methodName: string;
  config: DatastoreConfig;
  syncService: DatastoreSyncService | undefined;
  repoContext: Pick<RepositoryContext, "commitLog">;
  /**
   * a checkout writing through serve, or serve on its own v3 datastore:
   * other writers hold the behavior's lease there, so a lockless save would be
   * refused under it or take the version it allocated
   */
  teamMode?: boolean;
}): Promise<MethodRunLockMode> {
  if (await isMethodMutating(options.modelType, options.methodName)) {
    return "run";
  }
  const { config } = options;
  if (
    options.teamMode === true && options.repoContext.commitLog !== undefined
  ) {
    return "run";
  }
  // Only a v2 extension datastore publishes a run's writes through the
  // model lock: a filesystem datastore has no push, and a v3 root commits
  // through its commit log whatever the locks.
  if (
    !isCustomDatastoreConfig(config) || !isV2CustomDatastore(config) ||
    !config.cachePath || options.repoContext.commitLog !== undefined
  ) {
    return "none";
  }
  // without a sync service there is nothing to pull or publish through, so a
  // lock would only make the read wait behind a writer
  return options.syncService ? "publish" : "none";
}
