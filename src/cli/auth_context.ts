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

import { UserError } from "../domain/errors.ts";

const COLLECTIVE_TOKEN_PREFIX = "swamp_org_";

let authenticated = false;
let collectiveToken = false;
let authScopes: string[] | undefined;

export function setAuthenticated(value: boolean): void {
  authenticated = value;
}

export function isAuthenticated(): boolean {
  return authenticated;
}

export function setCollectiveToken(apiKey: string): void {
  collectiveToken = apiKey.startsWith(COLLECTIVE_TOKEN_PREFIX);
}

export function isCollectiveToken(): boolean {
  return collectiveToken;
}

export function setAuthScopes(scopes: string[] | undefined): void {
  authScopes = scopes;
}

export function getAuthScopes(): string[] | undefined {
  return authScopes;
}

export function requireAuthenticated(
  featureSentence: string,
  scope: string,
): void {
  if (!authenticated) {
    throw new UserError(
      `${featureSentence} that requires a free swamp-club.com account.\n\n` +
        `Sign in:\n\n` +
        `  swamp auth login\n\n` +
        `Or create a collective token at swamp-club.com/collectives and set\n` +
        `SWAMP_API_KEY. Your token should include the ${scope} scope.\n`,
      "auth_required",
    );
  }
}

export function requireScope(scope: string): void {
  if (!collectiveToken) return;
  if (authScopes !== undefined && authScopes.includes(scope)) return;

  throw new UserError(
    `Your token lacks the ${scope} scope.\n\n` +
      `Create a new collective token at swamp-club.com/collectives that\n` +
      `includes the ${scope} scope and set SWAMP_API_KEY.\n`,
    "missing_scope",
  );
}
