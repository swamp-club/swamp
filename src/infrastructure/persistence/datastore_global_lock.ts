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
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import type {
  DistributedLock,
  LockOptions,
} from "../../domain/datastore/distributed_lock.ts";
import { UserError } from "../../domain/errors.ts";
import { FileLock } from "./file_lock.ts";

// The datastore global lock, shared by the CLI and `swamp serve`.

/**
 * Resolves a DatastoreProvider for a custom datastore config.
 * Ensures the datastore extension registry is loaded before lookup.
 */
export async function resolveCustomProvider(
  config: CustomDatastoreConfig,
): Promise<DatastoreProvider> {
  await datastoreTypeRegistry.ensureLoaded();
  await datastoreTypeRegistry.ensureTypeLoaded(config.type);
  const typeInfo = datastoreTypeRegistry.get(config.type);
  if (!typeInfo?.createProvider) {
    throw new UserError(
      `Datastore type "${config.type}" is not registered or has no provider.`,
    );
  }
  return typeInfo.createProvider(config.config);
}

/**
 * Lock options selecting the global datastore lock for a config's namespace
 * (giga-swamp Phase 3).
 *
 * Solo mode (no namespace) returns `undefined`, so the lock falls back to the
 * single shared `.datastore.lock` — byte-identical to before. When a namespace
 * is configured, returns `{ lockKey: ".datastore.lock", namespace }` so the
 * lock provider places the key at `{namespace}/.datastore.lock`, keeping it
 * within the namespace prefix for IAM-scoped credentials. Repos sharing a
 * datastore with different namespaces never contend on structural commands.
 *
 * Every construction of the GLOBAL datastore lock — the structural-command
 * acquire, the `acquireModelLocks` drain-coordination inspect, the per-model
 * flush push lock, and the breakglass status/release commands — must pass
 * these options so they all agree on the same namespaced key. A mismatch
 * would make the symmetric drain silently inspect a different lock than the
 * one held.
 */
export function datastoreGlobalLockOptions(
  config: DatastoreConfig,
): LockOptions | undefined {
  const namespace = config.namespace ?? "";
  if (namespace.length === 0) return undefined;
  return { lockKey: ".datastore.lock", namespace };
}

/**
 * Creates the appropriate distributed lock for a datastore configuration.
 *
 * Used by the lock breakglass commands to inspect/release locks without
 * going through the full sync coordinator lifecycle, and by managed lockfile
 * transactions, in the CLI and in `swamp serve` (swamp-club#2838).
 */
export async function createDatastoreLock(
  config: DatastoreConfig,
): Promise<DistributedLock> {
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
 * The datastore global lock for `config`, created on the first acquire so
 * holding the handle costs nothing until it is used. Each acquire takes a
 * fresh lock instance; release releases the one last acquired.
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
