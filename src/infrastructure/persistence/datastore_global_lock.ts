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

import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import {
  type CustomDatastoreConfig,
  isCustomDatastoreConfig,
  resolveLockTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { withSpan } from "../tracing/tracer.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type {
  DistributedLock,
  LockOptions,
} from "../../domain/datastore/distributed_lock.ts";
import { UserError } from "../../domain/errors.ts";
import { lockingConfigOf } from "./datastore_lock_target.ts";
import { FileLock } from "./file_lock.ts";

export async function resolveCustomProvider(
  config: CustomDatastoreConfig,
): Promise<DatastoreProvider> {
  // named because a fresh checkout loads or installs the extension here
  await withSpan(
    "swamp.datastore.extensions.load",
    {},
    () => datastoreTypeRegistry.ensureLoaded(),
  );
  await withSpan(
    "swamp.datastore.extension.type_load",
    { "swamp.datastore.type": config.type },
    () => datastoreTypeRegistry.ensureTypeLoaded(config.type),
  );
  const typeInfo = datastoreTypeRegistry.get(config.type);
  if (!typeInfo?.createProvider) {
    throw new UserError(
      `Datastore type "${config.type}" is not registered or has no provider.`,
    );
  }
  return typeInfo.createProvider(config.config);
}

/**
 * every construction of the global datastore lock must pass these options so
 * all agree on the same namespaced key; a mismatch makes the drain inspect a
 * different lock than the one held
 */
export function datastoreGlobalLockOptions(
  config: DatastoreConfig,
): LockOptions | undefined {
  const namespace = config.namespace ?? "";
  if (namespace.length === 0) return undefined;
  return { lockKey: ".datastore.lock", namespace };
}

export async function createDatastoreLock(
  datastoreConfig: DatastoreConfig,
): Promise<DistributedLock> {
  // a v3 bucket datastore locks as a filesystem one
  const config = lockingConfigOf(datastoreConfig);
  const maxWaitMs = resolveLockTimeoutMs();
  const options = datastoreGlobalLockOptions(config);
  const merged = { ...options, maxWaitMs };
  if (isCustomDatastoreConfig(config)) {
    const provider = await resolveCustomProvider(config);
    return provider.createLock(config.datastorePath, merged);
  }
  return new FileLock(config.path, merged);
}

/**
 * created on first acquire so holding the handle costs nothing until used; each
 * acquire takes a fresh lock instance and release releases the last one
 * acquired
 */
export function datastoreGlobalLock(
  config: DatastoreConfig,
): Pick<DistributedLock, "acquire" | "release"> {
  let held: DistributedLock | undefined;
  return {
    acquire: async () => {
      const lock = await createDatastoreLock(config);
      await lock.acquire();
      held = lock;
    },
    release: async () => {
      const lock = held;
      held = undefined;
      await lock?.release();
    },
  };
}
