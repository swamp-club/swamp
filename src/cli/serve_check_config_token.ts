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

/** The swamp-club credential available to the CLI, and where it came from. */
export interface CheckConfigCredential {
  /** The swamp-club server the credential was issued by. */
  readonly serverUrl: string;
  readonly apiKey: string;
  /** `env` for SWAMP_API_KEY, `login` for the stored `swamp auth login`. */
  readonly source: "env" | "login";
}

function originOf(url: string, what: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new UserError(`Invalid ${what} URL "${url}": expected a valid URL`);
  }
}

/**
 * Picks the bearer token `swamp serve check-config` uses to look up
 * usernames on the OAuth provider.
 *
 * The credential is only sent to the origin it was issued by. The command
 * is meant to be run on configs before they are deployed, including ones
 * the user did not write, so a crafted `oauth-provider` must never receive
 * the user's token.
 */
export function selectCheckConfigToken(
  providerUrl: string,
  credential: CheckConfigCredential | null,
): string {
  if (!credential?.apiKey) {
    throw new UserError(
      `Checking auth.admins and auth.allowed-users needs a credential for ${providerUrl}. ` +
        "Run 'swamp auth login', or set SWAMP_API_KEY to a collective token with the oauth:manage scope.",
    );
  }
  const providerOrigin = originOf(providerUrl, "oauth-provider");
  if (originOf(credential.serverUrl, "swamp-club server") !== providerOrigin) {
    const held = credential.source === "env"
      ? `SWAMP_API_KEY is a credential for ${credential.serverUrl}`
      : `You are logged in to ${credential.serverUrl}`;
    throw new UserError(
      `${held}, but the config's oauth-provider is ${providerUrl}. ` +
        `To check against ${providerUrl}, set SWAMP_CLUB_URL to ${providerOrigin} and ` +
        "SWAMP_API_KEY to a collective token for it with the oauth:manage scope.",
    );
  }
  return credential.apiKey;
}
