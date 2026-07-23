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

// State lives on globalThis so that all module copies produced by
// --unstable-bundle share the same values at runtime.
interface AuthState {
  authenticated: boolean;
  collectiveToken: boolean;
  authScopes: string[] | undefined;
}

const STATE_KEY = "__swamp_auth_state__";
function state(): AuthState {
  const g = globalThis as unknown as Record<string, AuthState>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      authenticated: false,
      collectiveToken: false,
      authScopes: undefined,
    };
  }
  return g[STATE_KEY];
}

export function setAuthenticated(value: boolean): void {
  state().authenticated = value;
}

export function isAuthenticated(): boolean {
  return state().authenticated;
}

export function setCollectiveToken(apiKey: string): void {
  state().collectiveToken = apiKey.startsWith(COLLECTIVE_TOKEN_PREFIX);
}

export function isCollectiveToken(): boolean {
  return state().collectiveToken;
}

export function setAuthScopes(scopes: string[] | undefined): void {
  state().authScopes = scopes;
}

export function getAuthScopes(): string[] | undefined {
  return state().authScopes;
}

export function requireAuthenticated(
  featureSentence: string,
  scope: string,
): void {
  if (!state().authenticated) {
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
  const s = state();
  if (!s.collectiveToken) return;
  if (s.authScopes !== undefined && s.authScopes.includes(scope)) return;

  throw new UserError(
    `Your token lacks the ${scope} scope.\n\n` +
      `Create a new collective token at swamp-club.com/collectives that\n` +
      `includes the ${scope} scope and set SWAMP_API_KEY.\n`,
    "missing_scope",
  );
}
