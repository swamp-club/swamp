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

import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import type { WhoamiResponse } from "../../infrastructure/http/swamp_club_client.ts";
import {
  getCollectives,
  SwampClubClient,
} from "../../infrastructure/http/swamp_club_client.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import type { LibSwampContext } from "../context.ts";
import {
  cancelled,
  invalidApiKey,
  notAuthenticated,
  type SwampError,
} from "../errors.ts";

export interface WhoamiIdentity {
  serverUrl: string;
  id: string;
  username: string;
  email: string;
  name: string;
  collectives?: string[];
}

export type AuthWhoamiEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; identity: WhoamiIdentity }
  | { kind: "error"; error: SwampError };

/** Dependencies for the whoami operation, injected for testability. */
export interface AuthDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  saveCredentials: (credentials: AuthCredentials) => Promise<void>;
  fetchWhoami: (
    serverUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<WhoamiResponse>;
  serverUrlOverride?: string;
}

/** Wires real infrastructure into AuthDeps. */
export function createAuthDeps(
  options?: { serverUrlOverride?: string },
): AuthDeps {
  const repo = new AuthRepository();
  return {
    loadCredentials: () => repo.load(),
    saveCredentials: (credentials) => repo.save(credentials),
    fetchWhoami: (serverUrl, apiKey, signal) => {
      const client = new SwampClubClient(serverUrl);
      return client.whoami(apiKey, signal);
    },
    serverUrlOverride: options?.serverUrlOverride,
  };
}

/** Verifies the current authenticated identity via the swamp-club API. */
export async function* whoami(
  ctx: LibSwampContext,
  deps: AuthDeps,
): AsyncIterable<AuthWhoamiEvent> {
  yield { kind: "loading_credentials" };

  const credentials = await deps.loadCredentials();
  if (!credentials) {
    yield { kind: "error", error: notAuthenticated() };
    return;
  }

  const serverUrl = deps.serverUrlOverride ?? credentials.serverUrl;
  yield { kind: "contacting_server", serverUrl };

  try {
    const response = await deps.fetchWhoami(
      serverUrl,
      credentials.apiKey,
      ctx.signal,
    );

    if (!response.authenticated) {
      yield { kind: "error", error: invalidApiKey() };
      return;
    }

    const collectives = getCollectives(response);

    // Refresh cached collectives in auth.json so they stay current
    await deps.saveCredentials({
      ...credentials,
      collectives: collectives ?? [],
    });

    yield {
      kind: "completed",
      identity: {
        serverUrl,
        id: response.id!,
        username: response.username!,
        email: response.email!,
        name: response.name!,
        ...(collectives ? { collectives } : {}),
      },
    };
  } catch (error: unknown) {
    if (
      error instanceof DOMException && error.name === "AbortError"
    ) {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    throw error;
  }
}
