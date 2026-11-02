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
 * bearerToken is the swamp_ personal key from AuthCredentials.apiKey, renamed
 * on the wire at the composition root; the Swamp-Distinct-Id header is
 * vendor-prefixed per RFC 6648, so no X- prefix
 */
export interface ClientIdentity {
  bearerToken?: string;
  distinctId?: string;
  userAgent?: string;
}

/**
 * identity headers are spread first and the caller's second, so a call can
 * override the identity (getCurrentUser sends its own session-token
 * Authorization); flipping the order silently breaks that
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
