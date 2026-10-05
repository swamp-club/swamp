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
import { FileLock } from "./file_lock.ts";

// The lock that serialises the writers of one server token, shared by the CLI
// and `swamp serve` (swamp-club#2482).

/**
 * Retry settings for a filesystem datastore. The lock is held for one short
 * read, write and push, like a per-model lock, so it uses that lock's values
 * (`MODEL_LOCK_RETRY_INTERVAL_MS` and `MODEL_LOCK_MAX_BACKOFF_MS`).
 */
export const SERVER_TOKEN_LOCK_RETRY_INTERVAL_MS = 25;
export const SERVER_TOKEN_LOCK_MAX_BACKOFF_MS = 250;

/**
 * Constructs the lock key that serialises every write of one server token's
 * record and secret (swamp-club#2482), optionally scoped under a namespace.
 * The key is built from a digest of the token name, never the name itself:
 * the name arrives from a client and a first mint has no definition to have
 * validated it. Like the workflow run claim key it sits outside `data/`, so
 * the per-model lock scan does not see it, and the file is named `.lock`,
 * the one name datastore sync never transfers.
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
 * Creates the distributed lock that serialises writes of one server token.
 *
 * Every writer that rewrites a token's record or secret (mint, rotate, revoke,
 * the secret migration) holds it across its pull, its writes and its push, so
 * one mint's record is never left beside another's secret. It is keyed by
 * token name, not model id, so it covers a first mint, which has no
 * definition yet. Take it before any per-model lock.
 */
export async function createServerTokenLock(
  config: DatastoreConfig,
  tokenName: string,
): Promise<DistributedLock> {
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
 * Runs `fn` holding the server token lock for `tokenName`.
 *
 * An error thrown before `fn` starts is the lock's. A timeout among them
 * names the token: the lock key is a digest, which tells an operator nothing.
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
 * The token name to lock for an identifier a caller gave. Rotate and revoke
 * accept a definition id as well as a name, and every writer of one token has
 * to take the same lock, so an id is resolved to its definition's name. An
 * identifier that names no server token is returned as given: the operation
 * will report it missing, under a lock nothing else contends for.
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
