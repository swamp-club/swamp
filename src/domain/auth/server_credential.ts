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

/** Stored authentication credential for a swamp serve instance. */
export interface ServerCredential {
  /** Normalized URL of the serve instance (e.g. "https://swamp.acme.internal:9090"). */
  serverUrl: string;
  /** The name portion of the <name>.<secret> token. */
  tokenName: string;
  /** The full <name>.<secret> plaintext token. */
  token: string;
  /** The user's principal ID (sub from OAuth login). */
  principalId: string;
  /** The user's display name, if available. */
  displayName?: string;
  /** ISO 8601 timestamp of when the credential was obtained. */
  obtainedAt: string;
}

/** Persistence abstraction for server credentials, keyed by normalized server URL. */
export interface ServerCredentialRepository {
  get(serverUrl: string): Promise<ServerCredential | null>;
  save(credential: ServerCredential): Promise<void>;
  remove(serverUrl: string): Promise<void>;
  list(): Promise<ServerCredential[]>;
}
