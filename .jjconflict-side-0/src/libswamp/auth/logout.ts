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

import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/**
 * Data structure for the auth logout output.
 */
export interface AuthLogoutData {
  loggedOut: boolean;
  username?: string;
  serverUrl?: string;
  reason?: string;
}

export type AuthLogoutEvent =
  | { kind: "completed"; data: AuthLogoutData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the auth logout operation. */
export interface AuthLogoutDeps {
  loadCredentials: () => Promise<
    { username: string; serverUrl: string } | null
  >;
  deleteCredentials: () => Promise<void>;
}

/** Wires real infrastructure into AuthLogoutDeps. */
export function createAuthLogoutDeps(): AuthLogoutDeps {
  const repo = new AuthRepository();
  return {
    loadCredentials: async () => {
      const creds = await repo.load();
      if (!creds) return null;
      return { username: creds.username, serverUrl: creds.serverUrl };
    },
    deleteCredentials: () => repo.delete(),
  };
}

/** Removes stored authentication credentials. */
export async function* authLogout(
  ctx: LibSwampContext,
  deps: AuthLogoutDeps,
): AsyncIterable<AuthLogoutEvent> {
  ctx.logger.debug`Executing auth logout`;

  const credentials = await deps.loadCredentials();

  if (!credentials) {
    const data: AuthLogoutData = {
      loggedOut: false,
      reason: "not authenticated",
    };
    yield { kind: "completed", data };
    return;
  }

  await deps.deleteCredentials();

  ctx.logger.debug`Logged out ${credentials.username}`;

  const data: AuthLogoutData = {
    loggedOut: true,
    username: credentials.username,
    serverUrl: credentials.serverUrl,
  };

  yield { kind: "completed", data };
}
