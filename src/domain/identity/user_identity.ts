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
 * Persistent user identity data stored at ~/.config/swamp/identity.json.
 * Identifies a unique user across all repositories.
 */
export interface UserIdentityData {
  /** UUID identifying this user */
  userId: string;
  /** ISO 8601 timestamp of when this identity was created */
  createdAt: string;
}

/**
 * Creates a new user identity with a random UUID.
 */
export function createUserIdentity(): UserIdentityData {
  return {
    userId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
}
