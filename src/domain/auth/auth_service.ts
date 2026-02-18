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

import type { AuthResult, AuthSession, CredentialData } from "./credentials.ts";

/**
 * Port for communicating with the BetterAuth backend.
 */
export interface AuthClient {
  signIn(email: string, password: string): Promise<AuthResult>;
  signUp(
    email: string,
    password: string,
    name: string,
  ): Promise<AuthResult>;
  signOut(token: string): Promise<boolean>;
  getSession(token: string): Promise<AuthSession | null>;
}

/**
 * Port for persisting credentials locally.
 */
export interface CredentialStore {
  load(): Promise<CredentialData | null>;
  save(data: CredentialData): Promise<void>;
  remove(): Promise<void>;
}
