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

/**
 * Moves the OAuth bootstrap secrets from the user's vault to
 * `_token-secrets`. These are fixed-name keys that were previously stored in
 * the user's vault during first-time OAuth setup.
 */
export async function migrateOAuthSecrets(
  vaultService: OAuthSecretMigrationVaults,
  tokenSecretsVaultName: string,
): Promise<void> {
  const userVaultForMigration = vaultService.getDefaultVaultName() ??
    vaultService.getVaultNames().find((n) => n !== tokenSecretsVaultName);
  if (!userVaultForMigration) return;
  for (
    const key of [
      OAUTH_CLIENT_ID_KEY,
      OAUTH_CLIENT_SECRET_KEY,
      OAUTH_BOOTSTRAP_ACCESS_TOKEN_KEY,
      OAUTH_RESOLVED_ADMINS_KEY,
    ]
  ) {
    try {
      const existing = await vaultService.get(
        tokenSecretsVaultName,
        key,
        "serve:oauth-migration",
      );
      if (existing) continue;
    } catch { /* not in _token-secrets yet */ }
    try {
      const value = await vaultService.get(
        userVaultForMigration,
        key,
        "serve:oauth-migration",
      );
      await vaultService.put(tokenSecretsVaultName, key, value);
      if (
        typeof vaultService.supportsDelete === "function" &&
        vaultService.supportsDelete(userVaultForMigration)
      ) {
        await vaultService.delete(userVaultForMigration, key)
          .catch(() => {});
      }
      logger.info(
        "Migrated OAuth secret {key} from vault to control-plane store",
        { key },
      );
    } catch { /* key doesn't exist in old vault — skip */ }
  }
}
