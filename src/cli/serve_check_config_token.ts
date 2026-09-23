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

import { UserError } from "../domain/errors.ts";

/**
 * Picks the bearer token `swamp serve check-config` uses to look up
 * usernames on the OAuth provider.
 *
 * `SWAMP_API_KEY` is used as-is, as `swamp serve` does. A stored login key
 * is only sent to the origin it was issued by, so a config pointing at
 * another provider can never receive the user's swamp-club credential.
 */
export function selectCheckConfigToken(
  providerUrl: string,
  envApiKey: string | undefined,
  storedLogin: { readonly serverUrl: string; readonly apiKey: string } | null,
): string {
  if (envApiKey) return envApiKey;

  if (!storedLogin?.apiKey) {
    throw new UserError(
      `Checking auth.admins and auth.allowed-users needs a credential for ${providerUrl}. ` +
        "Run 'swamp auth login', or set SWAMP_API_KEY to a collective token with the oauth:manage scope.",
    );
  }
  if (new URL(storedLogin.serverUrl).origin !== new URL(providerUrl).origin) {
    throw new UserError(
      `You are logged in to ${storedLogin.serverUrl}, but the config's oauth-provider is ${providerUrl}. ` +
        `Set SWAMP_API_KEY to a collective token for ${providerUrl} with the oauth:manage scope.`,
    );
  }
  return storedLogin.apiKey;
}
