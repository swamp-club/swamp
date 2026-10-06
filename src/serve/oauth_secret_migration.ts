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
import {
  OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY,
  OAUTH_CLIENT_ID_KEY,
  OAUTH_CLIENT_SECRET_KEY,
  OAUTH_RESOLVED_ADMINS_KEY,
} from "./oauth_registration.ts";

const logger = getSwampLogger(["serve", "oauth-migration"]);

/** The vault calls the OAuth secret migration makes. */
export type OAuthSecretMigrationVaults = Pick<
  VaultService,
  | "get"
  | "put"
  | "delete"
  | "list"
  | "supportsDelete"
  | "getDefaultVaultName"
  | "getVaultNames"
>;

const OAUTH_SECRET_KEYS = [
  OAUTH_CLIENT_ID_KEY,
  OAUTH_CLIENT_SECRET_KEY,
  OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY,
  OAUTH_RESOLVED_ADMINS_KEY,
] as const;

/**
 * Recorded in `_token-secrets` once the migration has finished. A key that is
 * legitimately absent (the bootstrap access token after an API-key
 * registration, say) would otherwise send every boot to the user vault.
 */
export const OAUTH_SECRETS_MIGRATED_KEY = "oauth-secrets-migrated";

/**
 * Moves the OAuth bootstrap secrets from the user's vault to
 * `_token-secrets`. These are fixed-name keys that were previously stored in
 * the user's vault during first-time OAuth setup.
 *
 * The user vault is listed once and only the keys it holds are read. The
 * migration is recorded only when the listing succeeded and every key moved,
 * so a vault that is unreachable at boot is retried on the next one. With no
 * user vault there is nothing to move and no marker is written, so such starts
 * only repeat the `_token-secrets` lookups.
 */
export async function migrateOAuthSecrets(
  vaultService: OAuthSecretMigrationVaults,
  tokenSecretsVaultName: string,
): Promise<void> {
  if (
    await hasSecret(
      vaultService,
      tokenSecretsVaultName,
      OAUTH_SECRETS_MIGRATED_KEY,
    )
  ) {
    return;
  }
  const userVaultForMigration = vaultService.getDefaultVaultName() ??
    vaultService.getVaultNames().find((n) => n !== tokenSecretsVaultName);
  if (!userVaultForMigration) return;

  const missing: string[] = [];
  for (const key of OAUTH_SECRET_KEYS) {
    if (!await hasSecret(vaultService, tokenSecretsVaultName, key)) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    let listed: Set<string>;
    try {
      listed = new Set(await vaultService.list(userVaultForMigration));
    } catch (error) {
      logger
        .warn`Could not list vault ${userVaultForMigration} to migrate OAuth secrets, retrying on the next start: ${error}`;
      return;
    }

    let allMoved = true;
    for (const key of missing) {
      if (!listed.has(key)) continue;
      try {
        const value = await vaultService.get(
          userVaultForMigration,
          key,
          "serve:oauth-migration",
        );
        await vaultService.put(tokenSecretsVaultName, key, value);
        if (vaultService.supportsDelete(userVaultForMigration)) {
          await vaultService.delete(userVaultForMigration, key)
            .catch(() => {});
        }
        logger.info(
          "Migrated OAuth secret {key} from vault to control-plane store",
          { key },
        );
      } catch (error) {
        allMoved = false;
        logger
          .warn`Could not migrate OAuth secret ${key} from vault ${userVaultForMigration}, retrying on the next start: ${error}`;
      }
    }
    if (!allMoved) return;
  }

  // Never fails the start: without the marker the next start just retries.
  try {
    await vaultService.put(
      tokenSecretsVaultName,
      OAUTH_SECRETS_MIGRATED_KEY,
      new Date().toISOString(),
    );
  } catch (error) {
    logger
      .warn`Could not record the OAuth secret migration, retrying on the next start: ${error}`;
  }
}

async function hasSecret(
  vaultService: OAuthSecretMigrationVaults,
  vaultName: string,
  key: string,
): Promise<boolean> {
  try {
    return Boolean(
      await vaultService.get(vaultName, key, "serve:oauth-migration"),
    );
  } catch {
    return false;
  }
}
