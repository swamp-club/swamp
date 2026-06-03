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

/**
 * Identity attached to every outbound request by a swamp-club HTTP client.
 *
 * Both fields are optional:
 * - `bearerToken` adds `Authorization: Bearer <token>`. The value is the
 *   `swamp_<personal-key>` written by `swamp auth login` and stored on
 *   `AuthCredentials.apiKey`. Wire-rename happens at the composition
 *   root — there is no second token field on `AuthCredentials`.
 * - `distinctId` adds `Swamp-Distinct-Id: <uuid>`. The value is the
 *   per-device UUID lazily created by `UserIdentityRepository.getUserId()`
 *   and stored at `~/.config/swamp/identity.json`. The header name is
 *   vendor-prefixed per RFC 6648 (no `X-` prefix).
 * - `userAgent` adds `User-Agent: <value>`. The value is
 *   `swamp-cli/<version>`, built at the composition root from the CLI
 *   `VERSION` constant so swamp-club can attribute traffic by client
 *   version.
 */
export interface ClientIdentity {
  bearerToken?: string;
  distinctId?: string;
  userAgent?: string;
}

/**
 * Merge constructor-supplied identity into an outbound `RequestInit`'s
 * headers, with caller-supplied headers taking precedence on conflict.
 *
 * Precedence is non-negotiable: identity headers are spread FIRST,
 * caller's `init.headers` SECOND. This lets callers override the
 * constructor identity on individual calls — e.g.
 * `SwampClubClient.getCurrentUser` ships its own session-token
 * `Authorization: Bearer …` and must keep working, and the existing
 * `x-api-key` per-method paths in `ExtensionApiClient` are left intact.
 *
 * A future refactor that flips the spread order silently breaks both
 * those flows. Don't.
 */
export function mergeIdentityHeaders(
  identity: ClientIdentity,
  callerHeaders: HeadersInit | undefined,
): Headers {
  const merged = new Headers();
  if (identity.bearerToken) {
    merged.set("Authorization", `Bearer ${identity.bearerToken}`);
  }
  if (identity.distinctId) {
    merged.set("Swamp-Distinct-Id", identity.distinctId);
  }
  if (identity.userAgent) {
    merged.set("User-Agent", identity.userAgent);
  }
  if (callerHeaders) {
    new Headers(callerHeaders).forEach((value, key) => {
      merged.set(key, value);
    });
  }
  return merged;
}
