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
  ServerTokenSchema,
  serverTokenSecretKey,
} from "../domain/models/access/server_token_model.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";

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

    const token = parsed.data;
    if (token.vaultName === TOKEN_SECRETS_VAULT_NAME) {
      skipped++;
      continue;
    }

    try {
      const secretKey = serverTokenSecretKey(token.name);
      const oauthKey = `oauth-access-token-${token.name}`;

      let serverSecret: string;
      try {
        serverSecret = await deps.vaultService.get(
          token.vaultName,
          token.secretKey,
          "serve:token-migration",
        );
      } catch {
        logger
          .warn`Token secret missing from vault for ${token.name}, skipping`;
        skipped++;
        continue;
      }

      await deps.vaultService.put(
        deps.tokenSecretsVaultName,
        secretKey,
        serverSecret,
      );

      try {
        const oauthSecret = await deps.vaultService.get(
          token.vaultName,
          oauthKey,
          "serve:token-migration",
        );
        await deps.vaultService.put(
          deps.tokenSecretsVaultName,
          oauthKey,
          oauthSecret,
        );
      } catch {
        logger
          .debug`OAuth access token not found for ${token.name}, skipping OAuth key migration`;
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

      migrated++;
      logger.info`Migrated token secrets for ${token.name}`;
    } catch (err) {
      failed++;
      logger.warn`Failed to migrate token ${token.name}: ${
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
