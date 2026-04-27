// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/** Default swamp-club server URL, used when no override is configured. */
export const DEFAULT_SWAMP_CLUB_URL = "https://swamp-club.com";

/** Legacy default swamp-club URL, retained so stored credentials carrying the
 * old domain can be transparently migrated on load. */
export const LEGACY_SWAMP_CLUB_URL = "https://swamp.club";

/** Stored authentication credentials for swamp-club API access. */
export interface AuthCredentials {
  /** The swamp-club server URL (e.g., "https://swamp-club.com") */
  serverUrl: string;
  /** The API key prefixed with "swamp_" */
  apiKey: string;
  /** The API key ID for revocation */
  apiKeyId: string;
  /** The authenticated username */
  username: string;
  /** Cached collective memberships (slugs) from the last login/whoami */
  collectives?: string[];
}
