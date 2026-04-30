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
import {
  AuthRepository,
  type AuthRepositoryOptions,
} from "../../infrastructure/persistence/auth_repository.ts";
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

/**
 * Options for {@link createAuthDeps}. The `repo` field accepts the
 * same overrides as `AuthRepository` itself — used by tests to bypass
 * the shared `Deno.env` global, which races across files when
 * `deno test --parallel` runs multiple auth-touching test files at once.
 */
export interface CreateAuthDepsOptions {
  serverUrlOverride?: string;
  repo?: AuthRepositoryOptions;
}

/** Wires real infrastructure into AuthDeps. */
export function createAuthDeps(options: CreateAuthDepsOptions = {}): AuthDeps {
  const repo = new AuthRepository(options.repo);
  // When SWAMP_API_KEY is set, skip writing credentials to disk — env-var
  // auth is ephemeral and shouldn't create/update auth.json. Checked
  // lazily through the same getApiKey hook the repo uses, so test
  // overrides flow through here too.
  const getApiKey = options.repo?.getApiKey ??
    (() => Deno.env.get("SWAMP_API_KEY"));
  return {
    loadCredentials: () => repo.load(),
    saveCredentials: (credentials) =>
      getApiKey() ? Promise.resolve() : repo.save(credentials),
    fetchWhoami: (serverUrl, apiKey, signal) => {
      const client = new SwampClubClient(serverUrl);
      return client.whoami(apiKey, signal);
    },
    serverUrlOverride: options.serverUrlOverride,
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
