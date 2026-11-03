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

export type OAuthSecretMigrationVaults = Pick<
  VaultService,
  | "get"
  | "put"
  | "list"
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
 * a key that is legitimately absent, such as the bootstrap access token after
 * API-key registration, would otherwise send every boot to the user vault
 */
export const OAUTH_SECRETS_MIGRATED_KEY = "oauth-secrets-migrated";

/**
 * recorded only when the listing succeeded and every key moved, so an
 * unreachable vault is retried next boot; with no user vault no marker is
 * written
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
        // The user-vault copy stays: a seeded vault such as AWS Secrets Manager
        // is how a recreated instance with an empty datastore finds its client.
        await vaultService.put(tokenSecretsVaultName, key, value);
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

/**
 * the user vault is a fallback only until the migration is recorded; after that
 * a key _token-secrets lacks is absent and reading the user vault could only
 * fail
 */
export function createOAuthSecretReader(
  vaultService: Pick<
    VaultService,
    "get" | "getDefaultVaultName" | "getVaultNames"
  >,
  tokenSecretsVaultName: string,
): (key: string) => Promise<string | null> {
  let migrated: Promise<boolean> | undefined;
  return async (key) => {
    try {
      return await vaultService.get(
        tokenSecretsVaultName,
        key,
        "serve:oauth-resolve",
      );
    } catch {
      // Fall through to the user vault.
    }
    const userVaultName = vaultService.getDefaultVaultName() ??
      vaultService.getVaultNames().find((n) => n !== tokenSecretsVaultName);
    if (!userVaultName) return null;
    migrated ??= hasSecret(
      vaultService,
      tokenSecretsVaultName,
      OAUTH_SECRETS_MIGRATED_KEY,
    );
    if (await migrated) return null;
    try {
      return await vaultService.get(userVaultName, key, "serve:oauth-resolve");
    } catch {
      return null;
    }
  };
}

async function hasSecret(
  vaultService: Pick<VaultService, "get">,
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
