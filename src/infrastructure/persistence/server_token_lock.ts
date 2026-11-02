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
  resolveLockTimeoutMs,
} from "../../domain/datastore/datastore_config.ts";
import {
  type DistributedLock,
  LockTimeoutError,
} from "../../domain/datastore/distributed_lock.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../../domain/models/access/server_token_model.ts";
import { resolveCustomProvider } from "./datastore_global_lock.ts";
import { lockingConfigOf } from "./datastore_lock_target.ts";
import { FileLock } from "./file_lock.ts";

/**
 * held for one short read, write and push like a per-model lock, so it uses
 * that lock's retry values
 */
export const SERVER_TOKEN_LOCK_RETRY_INTERVAL_MS = 25;
export const SERVER_TOKEN_LOCK_MAX_BACKOFF_MS = 250;

/**
 * keyed by a digest of the token name, never the name, which comes from a
 * client and may be unvalidated on a first mint; outside data/ and named .lock,
 * which datastore sync never transfers
 */
export async function serverTokenLockKey(
  namespace: string | undefined,
  tokenName: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(tokenName),
  );
  const hex = Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const base = `server-token-locks/${hex}/.lock`;
  return namespace ? `${namespace}/${base}` : base;
}

/**
 * every writer of a token's record or secret holds it across pull, write and
 * push; keyed by name so a first mint is covered. Take it before any per-model
 * lock
 */
export async function createServerTokenLock(
  datastoreConfig: DatastoreConfig,
  tokenName: string,
): Promise<DistributedLock> {
  // a v3 bucket datastore locks as a filesystem one
  const config = lockingConfigOf(datastoreConfig);
  const lockKey = await serverTokenLockKey(config.namespace, tokenName);
  const maxWaitMs = resolveLockTimeoutMs();
  if (isCustomDatastoreConfig(config)) {
    const provider = await resolveCustomProvider(config);
    return provider.createLock(config.datastorePath, { lockKey, maxWaitMs });
  }
  return new FileLock(config.path, {
    lockKey,
    maxWaitMs,
    retryIntervalMs: SERVER_TOKEN_LOCK_RETRY_INTERVAL_MS,
    maxBackoffMs: SERVER_TOKEN_LOCK_MAX_BACKOFF_MS,
  });
}

/**
 * a timeout names the token, because the lock key is a digest that tells an
 * operator nothing
 */
export async function withServerTokenLock<T>(
  config: DatastoreConfig,
  tokenName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await createServerTokenLock(config, tokenName);
  try {
    await lock.acquire();
  } catch (error) {
    if (!(error instanceof LockTimeoutError)) throw error;
    const holder = error.holder
      ? ` (held by ${error.holder.holder}, pid ${error.holder.pid})`
      : "";
    throw new LockTimeoutError(error.lockKey, error.holder, error.waitedMs, {
      message:
        `Server token '${tokenName}' is being changed by another operation` +
        `${holder} — timed out after ${error.waitedMs}ms; try again`,
      cause: error,
    });
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * every writer of a token must take the same lock, so a definition id resolves
 * to its name; an unknown identifier is returned as given and reported missing
 */
export async function serverTokenLockName(
  definitionRepo: DefinitionRepository,
  idOrName: string,
): Promise<string> {
  const found = await findDefinitionByIdOrName(definitionRepo, idOrName);
  if (
    found === null ||
    found.type.normalized !== SERVER_TOKEN_MODEL_TYPE.normalized
  ) {
    return idOrName;
  }
  return found.definition.name;
}
