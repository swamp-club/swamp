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

/**
 * Stored credential data persisted at ~/.config/swamp/credentials.json.
 */
export interface CredentialData {
  /** BetterAuth session token */
  sessionToken: string;
  /** User's email address */
  email: string;
  /** User's display name */
  name: string;
  /** User's server-side ID */
  userId: string;
  /** ISO 8601 timestamp of when credentials were stored */
  storedAt: string;
}

/**
 * Session info returned from the BetterAuth server.
 */
export interface AuthSession {
  user: {
    id: string;
    email: string;
    name: string;
  };
  session: {
    id: string;
    token: string;
    expiresAt: string;
  };
}

/**
 * Result of an auth operation (sign-in, sign-up).
 */
export type AuthResult =
  | { ok: true; session: AuthSession; token: string }
  | { ok: false; error: string };
