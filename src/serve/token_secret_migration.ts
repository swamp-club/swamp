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

import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { VaultService } from "../domain/vaults/vault_service.ts";
import type { DataQueryService } from "../domain/data/data_query_service.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  type ServerToken,
  ServerTokenSchema,
  serverTokenSecretKey,
} from "../domain/models/access/server_token_model.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import { withServerTokenLock } from "../infrastructure/persistence/server_token_lock.ts";
import { runInRootUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { type SyncGate, withSharedSyncGate } from "./sync_gate.ts";
import { oauthAccessTokenKey } from "./device_auth_handler.ts";

const logger = getSwampLogger(["serve", "token-migration"]);

export interface TokenSecretMigrationDeps {
  tokenSecretsVaultName: string;
  vaultService: VaultService;
  dataQueryService: DataQueryService;
  updateTokenVaultName: (
    tokenName: string,
    newVaultName: string,
    currentAttrs: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * Runs `fn` holding the token's name lock, after bringing the local copy of
   * the datastore up to date and before pushing what `fn` wrote. Build it
   * with {@link createTokenMigrationLockDeps}.
   */
  withTokenLock: <T>(tokenName: string, fn: () => Promise<T>) => Promise<T>;
  /** The token's record as stored now, or null when it has none. */
  readTokenRecord: (
    tokenName: string,
  ) => Promise<Record<string, unknown> | null>;
}

/**
 * The lock and re-read the migration needs, for a process that writes the
 * given datastore. Each token is migrated as one unit: lock, pull, re-read,
 * write, push. `syncGate` is serve's; the CLI has none.
 */
export function createTokenMigrationLockDeps(options: {
  datastoreConfig: DatastoreConfig;
  repoContext: RepositoryContext;
  syncService: DatastoreSyncService | undefined;
  syncGate: SyncGate | undefined;
}): Pick<TokenSecretMigrationDeps, "withTokenLock" | "readTokenRecord"> {
  const { datastoreConfig, repoContext, syncService, syncGate } = options;
  const namespace = isCustomDatastoreConfig(datastoreConfig)
    ? datastoreConfig.namespace
    : undefined;
  return {
    withTokenLock: (tokenName, fn) =>
      withServerTokenLock(
        datastoreConfig,
        tokenName,
        () =>
          withSharedSyncGate(syncGate, async () => {
            if (syncService) {
              await syncService.pullChanged({ namespace });
              repoContext.catalogStore.invalidate();
            }
            // The push is the root's flush, so it runs once however `fn`
            // ends and covers everything `fn` wrote.
            return await runInRootUnitOfWork(
              repoContext,
              {
                flush: syncService
                  ? async () => {
                    await syncService.pushChanged({ namespace });
                  }
                  : undefined,
              },
              fn,
            );
          }),
      ),
    readTokenRecord: async (tokenName) => {
      const definition = await repoContext.definitionRepo.findByName(
        SERVER_TOKEN_MODEL_TYPE,
        tokenName,
      );
      if (definition === null) return null;
      const content = await repoContext.unifiedDataRepo.getContent(
        SERVER_TOKEN_MODEL_TYPE,
        definition.id,
        "token-main",
      );
      if (content === null) return null;
      return JSON.parse(new TextDecoder().decode(content));
    },
  };
}

export async function migrateTokenSecrets(
  deps: TokenSecretMigrationDeps,
): Promise<{ migrated: number; skipped: number; failed: number }> {
  const records = await deps.dataQueryService.query(
    `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main"`,
    { loadAttributes: true },
  );

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    const rawAttrs = (record as { attributes?: Record<string, unknown> })
      .attributes;
    if (!rawAttrs) continue;
    const parsed = ServerTokenSchema.safeParse(rawAttrs);
    if (!parsed.success) continue;

    const queried = parsed.data;
    if (queried.vaultName === TOKEN_SECRETS_VAULT_NAME) {
      skipped++;
      continue;
    }

    try {
      // The record above was read before the lock, so a rotate or re-mint
      // may have replaced it since. Writing it back would put an old record
      // and secret over the new ones (swamp-club#2482), so read it again
      // under the lock and migrate only what is there now.
      const outcome = await deps.withTokenLock(
        queried.name,
        async (): Promise<"migrated" | "skipped"> => {
          const currentAttrs = await deps.readTokenRecord(queried.name);
          if (currentAttrs === null) return "skipped";
          const current = ServerTokenSchema.safeParse(currentAttrs);
          if (
            !current.success ||
            current.data.vaultName === TOKEN_SECRETS_VAULT_NAME ||
            current.data.createdAt !== queried.createdAt
          ) {
            logger
              .info`Token ${queried.name} changed since it was listed, skipping migration`;
            return "skipped";
          }
          return await migrateOne(deps, current.data, currentAttrs);
        },
      );
      if (outcome === "migrated") {
        migrated++;
        logger.info`Migrated token secrets for ${queried.name}`;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      logger
        .warn`Failed to migrate token ${queried.name}, retrying on the next run: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  if (migrated > 0 || failed > 0) {
    logger
      .info`Token secret migration complete: ${migrated} migrated, ${skipped} skipped, ${failed} failed`;
  }

  return { migrated, skipped, failed };
}

/**
 * Moves one token's secrets and repoints its record. Runs under its lock.
 *
 * Only an OAuth login stores an access token, so its absence is normal. The
 * vault is listed to tell an absent key from one that failed to read: a listed
 * key that fails to copy throws before the record is repointed, so the token
 * stays on its vault and the next run retries (swamp-club#3136). Repointing it
 * anyway would leave the access token where the collective refresh no longer
 * looks.
 */
async function migrateOne(
  deps: TokenSecretMigrationDeps,
  token: ServerToken,
  rawAttrs: Record<string, unknown>,
): Promise<"migrated" | "skipped"> {
  const secretKey = serverTokenSecretKey(token.name);
  const oauthKey = oauthAccessTokenKey(token.name);

  let serverSecret: string;
  try {
    serverSecret = await deps.vaultService.get(
      token.vaultName,
      token.secretKey,
      "serve:token-migration",
    );
  } catch {
    logger.warn`Token secret missing from vault for ${token.name}, skipping`;
    return "skipped";
  }

  const listed = await deps.vaultService.list(token.vaultName);
  let oauthSecret: string | undefined;
  if (listed.includes(oauthKey)) {
    oauthSecret = await deps.vaultService.get(
      token.vaultName,
      oauthKey,
      "serve:token-migration",
    );
  } else {
    logger
      .debug`OAuth access token not found for ${token.name}, skipping OAuth key migration`;
  }

  await deps.vaultService.put(
    deps.tokenSecretsVaultName,
    secretKey,
    serverSecret,
  );
  if (oauthSecret !== undefined) {
    await deps.vaultService.put(
      deps.tokenSecretsVaultName,
      oauthKey,
      oauthSecret,
    );
  }

  await deps.updateTokenVaultName(
    token.name,
    deps.tokenSecretsVaultName,
    rawAttrs,
  );

  if (
    typeof deps.vaultService.supportsDelete === "function" &&
    deps.vaultService.supportsDelete(token.vaultName)
  ) {
    await deps.vaultService.delete(token.vaultName, token.secretKey)
      .catch(() => {});
    await deps.vaultService.delete(token.vaultName, oauthKey)
      .catch(() => {});
  }
  return "migrated";
}

/**
 * Recorded in `_token-secrets` once {@link recoverOAuthAccessTokens} has
 * finished, so later starts never list the user vault for it again.
 */
export const OAUTH_ACCESS_TOKENS_RECOVERED_KEY =
  "oauth-access-tokens-recovered";

export type OAuthAccessTokenRecoveryDeps =
  & Pick<
    TokenSecretMigrationDeps,
    | "tokenSecretsVaultName"
    | "vaultService"
    | "dataQueryService"
    | "withTokenLock"
    | "readTokenRecord"
  >
  & {
    /** The vault serves before swamp-club#1511 stored token secrets in. */
    userVaultName: string | undefined;
  };

/**
 * Copies OAuth access tokens that an older migration left behind in the user
 * vault into `_token-secrets` (swamp-club#3136).
 *
 * That migration repointed a token at `_token-secrets` even when copying its
 * access token failed, and the collective refresh reads only `_token-secrets`
 * for such a record, so the token was never refreshed or revoked. Each active
 * record that names `_token-secrets` is checked against one listing of the
 * user vault, and a key `_token-secrets` lacks is copied under the token's
 * lock. Token names come from the records, never from the vault's keys. Once
 * the listing succeeded and every key moved, the marker is recorded and the
 * user vault is not listed again; otherwise the next start retries.
 */
export async function recoverOAuthAccessTokens(
  deps: OAuthAccessTokenRecoveryDeps,
): Promise<{ recovered: number; failed: number }> {
  const { tokenSecretsVaultName, userVaultName, vaultService } = deps;
  let recovered = 0;
  let failed = 0;
  if (
    await hasSecret(
      vaultService,
      tokenSecretsVaultName,
      OAUTH_ACCESS_TOKENS_RECOVERED_KEY,
    )
  ) {
    return { recovered, failed };
  }
  if (!userVaultName) return { recovered, failed };

  const records = await deps.dataQueryService.query(
    `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main"`,
    { loadAttributes: true },
  );
  const candidates: ServerToken[] = [];
  for (const record of records) {
    const parsed = ServerTokenSchema.safeParse(
      (record as { attributes?: Record<string, unknown> }).attributes,
    );
    if (
      parsed.success &&
      parsed.data.state === "active" &&
      parsed.data.vaultName === tokenSecretsVaultName
    ) {
      candidates.push(parsed.data);
    }
  }

  if (candidates.length > 0) {
    let listed: Set<string>;
    try {
      listed = new Set(await vaultService.list(userVaultName));
    } catch (error) {
      logger
        .warn`Could not list vault ${userVaultName} to recover OAuth access tokens, retrying on the next start: ${error}`;
      return { recovered, failed };
    }

    for (const token of candidates) {
      const key = oauthAccessTokenKey(token.name);
      if (!listed.has(key)) continue;
      try {
        const outcome = await deps.withTokenLock(
          token.name,
          async (): Promise<"recovered" | "skipped"> => {
            const currentAttrs = await deps.readTokenRecord(token.name);
            const current = currentAttrs === null
              ? null
              : ServerTokenSchema.safeParse(currentAttrs);
            if (
              !current?.success ||
              current.data.state !== "active" ||
              current.data.vaultName !== tokenSecretsVaultName ||
              current.data.createdAt !== token.createdAt
            ) {
              return "skipped";
            }
            // Listed rather than read, so a failed read is not taken for
            // absence and cannot copy over a key that is there.
            const present = await vaultService.list(tokenSecretsVaultName);
            if (present.includes(key)) return "skipped";
            const value = await vaultService.get(
              userVaultName,
              key,
              "serve:token-migration",
            );
            await vaultService.put(tokenSecretsVaultName, key, value);
            if (
              typeof vaultService.supportsDelete === "function" &&
              vaultService.supportsDelete(userVaultName)
            ) {
              await vaultService.delete(userVaultName, key).catch(() => {});
            }
            return "recovered";
          },
        );
        if (outcome === "recovered") {
          recovered++;
          logger
            .info`Recovered OAuth access token for ${token.name} from vault ${userVaultName}`;
        }
      } catch (error) {
        failed++;
        logger
          .warn`Could not recover OAuth access token for ${token.name} from vault ${userVaultName}, retrying on the next start: ${error}`;
      }
    }
    if (failed > 0) return { recovered, failed };
  }

  // Never fails the start: without the marker the next start just retries.
  try {
    await vaultService.put(
      tokenSecretsVaultName,
      OAUTH_ACCESS_TOKENS_RECOVERED_KEY,
      new Date().toISOString(),
    );
  } catch (error) {
    logger
      .warn`Could not record the OAuth access token recovery, retrying on the next start: ${error}`;
  }
  return { recovered, failed };
}

async function hasSecret(
  vaultService: Pick<VaultService, "get">,
  vaultName: string,
  key: string,
): Promise<boolean> {
  try {
    return Boolean(
      await vaultService.get(vaultName, key, "serve:token-migration"),
    );
  } catch {
    return false;
  }
}
