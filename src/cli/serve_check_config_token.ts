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
import type { ApiKeySourceName } from "../infrastructure/persistence/api_key_source.ts";

export interface CheckConfigCredential {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly source: ApiKeySourceName | "login";
}

function originOf(url: string, what: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new UserError(`Invalid ${what} URL "${url}": expected a valid URL`);
  }
}

/**
 * the credential is only sent to the origin it was issued by: the command runs
 * on configs the user did not write, so a crafted `oauth-provider` must never
 * receive the token
 */
export function selectCheckConfigToken(
  providerUrl: string,
  credential: CheckConfigCredential | null,
): string {
  if (!credential?.apiKey) {
    throw new UserError(
      `Checking auth.admins and auth.allowed-users needs a credential for ${providerUrl}. ` +
        "Run 'swamp auth login', or set SWAMP_API_KEY (or SWAMP_API_KEY_FILE) to a collective token with the oauth:manage scope.",
    );
  }
  const providerOrigin = originOf(providerUrl, "oauth-provider");
  if (originOf(credential.serverUrl, "swamp-club server") !== providerOrigin) {
    const held = credential.source === "login"
      ? `You are logged in to ${credential.serverUrl}`
      : `The key from ${credential.source} is a credential for ${credential.serverUrl}`;
    throw new UserError(
      `${held}, but the config's oauth-provider is ${providerUrl}. ` +
        `To check against ${providerUrl}, set SWAMP_CLUB_URL to ${providerOrigin} and ` +
        "SWAMP_API_KEY (or SWAMP_API_KEY_FILE) to a collective token for it with the oauth:manage scope.",
    );
  }
  return credential.apiKey;
}
