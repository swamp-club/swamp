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

export const DEFAULT_SWAMP_CLUB_URL = "https://swamp-club.com";

/** retained so stored credentials carrying the old domain are migrated on load */
export const LEGACY_SWAMP_CLUB_URL = "https://swamp.club";

/**
 * first 16 hex characters of the SHA-256 of the key; swamp-club shows the same
 * value, so it identifies a key to revoke without revealing it; also the cache
 * key for identity and scope caches
 */
export async function keyFingerprint(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface AuthCredentials {
  serverUrl: string;
  apiKey: string;
  apiKeyId: string;
  username: string;
  collectives?: string[];
  scopes?: string[];
  /**
   * detects key rotation for SWAMP_API_KEY users; older files hold a
   * 12-character prefix, which never matches and so reads as stale
   */
  apiKeyFingerprint?: string;
}
