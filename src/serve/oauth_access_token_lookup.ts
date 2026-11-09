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

import type { VaultService } from "../domain/vaults/vault_service.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import { oauthAccessTokenKey } from "./device_auth_handler.ts";

/**
 * only an OAuth login stores a token; _token-secrets is read first, and the
 * token's own vault is a fallback only for a record still naming a user vault;
 * for any other token a miss is final
 */
export async function lookupOAuthAccessToken(
  vaultService: Pick<VaultService, "get">,
  token: { readonly name: string; readonly vaultName: string },
): Promise<string | null> {
  const key = oauthAccessTokenKey(token.name);
  try {
    return await vaultService.get(
      TOKEN_SECRETS_VAULT_NAME,
      key,
      "serve:group-refresh",
    );
  } catch {
    // Fall through to the token's own vault.
  }
  if (token.vaultName === TOKEN_SECRETS_VAULT_NAME) return null;
  try {
    return await vaultService.get(token.vaultName, key, "serve:group-refresh");
  } catch {
    return null;
  }
}

/**
 * Whether an OAuth login stored an access token for this token, in the same
 * vaults the lookup reads; throws when a vault cannot answer.
 */
export async function hasOAuthAccessToken(
  vaultService: Pick<VaultService, "has" | "getVaultNames">,
  token: { readonly name: string; readonly vaultName: string },
): Promise<boolean> {
  const key = oauthAccessTokenKey(token.name);
  const configured = new Set(vaultService.getVaultNames());
  for (const vault of new Set([TOKEN_SECRETS_VAULT_NAME, token.vaultName])) {
    if (!configured.has(vault)) continue;
    if (await vaultService.has(vault, key)) return true;
  }
  return false;
}
