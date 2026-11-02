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

export interface ServerCredential {
  serverUrl: string;
  tokenName: string;
  token: string;
  principalId: string;
  displayName?: string;
  obtainedAt: string;
}

export interface ServerCredentialRepository {
  get(serverUrl: string): Promise<ServerCredential | null>;
  save(credential: ServerCredential): Promise<void>;
  remove(serverUrl: string): Promise<void>;
  list(): Promise<ServerCredential[]>;
}
