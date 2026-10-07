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
 * Reads the OAuth access token stored for a server token at login, or null
 * when it has none.
 *
 * Only an OAuth login stores one, so a manually minted or worker server token
 * never has it. `_token-secrets` is read first. The token's own vault is a
 * fallback only for a record that still names a user vault, which is a token
 * minted before swamp-club#1511 whose secrets have not been migrated. For any
 * other token a miss is final, and reading a user vault for it could only fail
 * (swamp-club#3127).
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
