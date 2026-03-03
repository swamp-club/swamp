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

/** Stored authentication credentials for swamp-club API access. */
export interface AuthCredentials {
  /** The swamp-club server URL (e.g., "https://swamp.club") */
  serverUrl: string;
  /** The API key prefixed with "swamp_" */
  apiKey: string;
  /** The API key ID for revocation */
  apiKeyId: string;
  /** The authenticated username */
  username: string;
}
