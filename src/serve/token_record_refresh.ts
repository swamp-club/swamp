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
  serverTokenSecretFingerprint,
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

/** a refusal is reused this long, so a client retrying a mispaired token never re-fetches */
export const REFRESH_RETRY_MS = 30_000;

type RefreshOutcome = "adopted" | "refused" | "moved";

export interface TokenRecordRefreshOptions {
  retryAfterMs?: number;
  now?: () => number;
}

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
  // a pull landing between the fetch and the write could leave an older marker
  exclusively: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
  options: TokenRecordRefreshOptions = {},
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
  const retryAfterMs = options.retryAfterMs ?? REFRESH_RETRY_MS;
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<RefreshOutcome>>();
  // token name and secret fingerprint to when the refusal may be retried
  const refusedUntil = new Map<string, number>();

  return async (name, secret) => {
    const key = JSON.stringify([
      name,
      await serverTokenSecretFingerprint(secret),
    ]);
    if ((refusedUntil.get(key) ?? 0) > now()) return false;
    const running = inFlight.get(key);
    if (running !== undefined) return await running === "adopted";
    const attempt = refresh(name, secret).then((outcome) => {
      if (outcome === "refused") {
        const at = now();
        for (const [k, until] of refusedUntil) {
          if (until <= at) refusedUntil.delete(k);
        }
        refusedUntil.set(key, at + retryAfterMs);
      }
      return outcome;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
    return await attempt === "adopted";
  };

  // the fetch and the pairing check take no sync gate; only an adoption does
  async function refresh(
    name: string,
    secret: string,
  ): Promise<RefreshOutcome> {
    const definition = await repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      name,
    );
    if (definition === null) return "refused";
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
    if (marker === null) return "refused";
    const version = Number.parseInt(
      new TextDecoder().decode(marker).trim(),
      10,
    );
    if (!Number.isInteger(version) || version < 1) return "refused";
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
    if (raw === null || metadata === null) return "refused";
    let record;
    try {
      record = ServerTokenSchema.parse(
        JSON.parse(new TextDecoder().decode(raw)),
      );
      // without a fingerprint nothing proves the pair
      if (record.secretFingerprint === undefined) return "refused";
      await verifyServerTokenSecret(record, secret);
    } catch {
      return "refused";
    }
    const adopted = await exclusively(async () => {
      // a peer may have published again since the fetch
      const current = await fetch(latestPath);
      if (
        current === null ||
        new TextDecoder().decode(current).trim() !==
          new TextDecoder().decode(marker).trim()
      ) return false;
      await Deno.mkdir(dirname(rawPath), { recursive: true });
      await atomicWriteFile(rawPath, raw);
      await atomicWriteFile(metadataPath, metadata);
      await atomicWriteFile(latestPath, marker);
      repoContext.catalogStore.invalidate();
      return true;
    });
    // a peer published again meanwhile: not remembered, the next attempt reads it
    if (!adopted) return "moved";
    logger.warn(
      "Token {name} had another mint's record in this cache; took the datastore's, which pairs with its secret",
      { name },
    );
    return "adopted";
  }
}
