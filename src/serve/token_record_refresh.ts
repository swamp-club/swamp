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

import { dirname, isAbsolute, join, relative, SEPARATOR } from "@std/path";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  ServerTokenSchema,
  TOKEN_DATA_NAME,
  verifyServerTokenSecret,
} from "../domain/models/access/server_token_model.ts";
import { markErrorPaths } from "../domain/errors.ts";
import { atomicWriteFile } from "../infrastructure/persistence/atomic_write.ts";
import { commitsThroughCommitLog } from "../infrastructure/persistence/repo_unit_of_work.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ServerTokenRecordRefresh } from "./token_auth.ts";

const logger = getSwampLogger(["serve", "token-record-refresh"]);

export const TOKEN_RECORD_FETCH_TIMEOUT_MS = 10_000;

/**
 * two writers can publish the same version of a token record, and the cache
 * that wrote first never downloads the other's; the datastore's copy is adopted
 * only when it pairs with the secret, byte for byte so nothing is pushed back
 */
export function serverTokenRecordRefreshOver(
  config: DatastoreConfig,
  syncService: DatastoreSyncService | undefined,
  repoContext: Pick<
    RepositoryContext,
    | "definitionRepo"
    | "unifiedDataRepo"
    | "catalogStore"
    | "markDirty"
    | "commitLog"
  >,
): ServerTokenRecordRefresh | undefined {
  if (!isCustomDatastoreConfig(config) || !config.cachePath) return undefined;
  const fetchContent = syncService?.fetchContent?.bind(syncService);
  // a commit-log engine has one writer, so no peer publishes the same version
  if (!fetchContent || commitsThroughCommitLog(repoContext)) return undefined;
  const cachePath = config.cachePath;
  const namespace = config.namespace;
  const fetch = (absPath: string) => {
    const rel = relative(cachePath, absPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw markErrorPaths(
        new Error(`Token record ${absPath} is outside the datastore cache`),
        [absPath],
      );
    }
    return fetchContent(
      SEPARATOR === "/" ? rel : rel.split(SEPARATOR).join("/"),
      {
        namespace,
        signal: AbortSignal.timeout(TOKEN_RECORD_FETCH_TIMEOUT_MS),
      },
    );
  };
  return async (name, secret) => {
    const definition = await repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      name,
    );
    if (definition === null) return false;
    const repo = repoContext.unifiedDataRepo;
    const latestPath = join(
      repo.getDataNameDir(
        SERVER_TOKEN_MODEL_TYPE,
        definition.id,
        TOKEN_DATA_NAME,
      ),
      "latest",
    );
    const marker = await fetch(latestPath);
    if (marker === null) return false;
    const version = Number.parseInt(
      new TextDecoder().decode(marker).trim(),
      10,
    );
    if (!Number.isInteger(version) || version < 1) return false;
    const rawPath = repo.getContentPath(
      SERVER_TOKEN_MODEL_TYPE,
      definition.id,
      TOKEN_DATA_NAME,
      version,
    );
    const metadataPath = repo.getMetadataPath(
      SERVER_TOKEN_MODEL_TYPE,
      definition.id,
      TOKEN_DATA_NAME,
      version,
    );
    const [raw, metadata] = await Promise.all([
      fetch(rawPath),
      fetch(metadataPath),
    ]);
    if (raw === null || metadata === null) return false;
    let record;
    try {
      record = ServerTokenSchema.parse(
        JSON.parse(new TextDecoder().decode(raw)),
      );
      // without a fingerprint nothing proves the pair
      if (record.secretFingerprint === undefined) return false;
      await verifyServerTokenSecret(record, secret);
    } catch {
      return false;
    }
    await Deno.mkdir(dirname(rawPath), { recursive: true });
    await atomicWriteFile(rawPath, raw);
    await atomicWriteFile(metadataPath, metadata);
    await atomicWriteFile(latestPath, marker);
    repoContext.catalogStore.invalidate();
    logger.warn(
      "Token {name} had another mint's record in this cache; took the datastore's, which pairs with its secret",
      { name },
    );
    return true;
  };
}
