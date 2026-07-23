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

import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
import type { CreateCollectiveTokenResponse } from "../../infrastructure/http/swamp_club_client.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import {
  AuthRepository,
  type AuthRepositoryOptions,
} from "../../infrastructure/persistence/auth_repository.ts";
import type { LibSwampContext } from "../context.ts";
import {
  cancelled,
  notAuthenticated,
  type SwampError,
  validationFailed,
} from "../errors.ts";

export interface AuthTokenCreateData {
  key: string;
  id: string;
  name: string;
  collective: string;
  scopes: string[];
}

export type AuthTokenCreateEvent =
  | { kind: "creating"; collective: string; name: string }
  | { kind: "completed"; data: AuthTokenCreateData }
  | { kind: "error"; error: SwampError };

export interface AuthTokenCreateInput {
  collective: string;
  scopes: string[];
  name?: string;
}

export interface AuthTokenCreateDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  createToken: (
    serverUrl: string,
    apiKey: string,
    collective: string,
    input: { name: string; scopes: string[] },
    signal: AbortSignal,
  ) => Promise<CreateCollectiveTokenResponse>;
  getHostname: () => string;
  getTimestamp: () => number;
  isCollectiveToken: () => boolean;
  serverUrlOverride?: string;
}

export interface CreateAuthTokenCreateDepsOptions {
  serverUrlOverride?: string;
  identity?: ClientIdentity;
  repo?: AuthRepositoryOptions;
  isCollectiveToken: () => boolean;
}

export function createAuthTokenCreateDeps(
  options: CreateAuthTokenCreateDepsOptions,
): AuthTokenCreateDeps {
  const repo = new AuthRepository(options.repo);
  return {
    loadCredentials: () => repo.load(),
    createToken: (serverUrl, apiKey, collective, input, signal) => {
      const client = new SwampClubClient(serverUrl, options.identity);
      return client.createCollectiveToken(apiKey, collective, input, signal);
    },
    getHostname: () => {
      try {
        return Deno.hostname?.() ?? "unknown";
      } catch {
        return "unknown";
      }
    },
    getTimestamp: () => Date.now(),
    isCollectiveToken: options.isCollectiveToken,
    serverUrlOverride: options.serverUrlOverride,
  };
}

export async function* authTokenCreate(
  ctx: LibSwampContext,
  deps: AuthTokenCreateDeps,
  input: AuthTokenCreateInput,
): AsyncIterable<AuthTokenCreateEvent> {
  if (deps.isCollectiveToken()) {
    yield {
      kind: "error",
      error: validationFailed(
        "Collective tokens cannot create other collective tokens. Sign in with a personal account using `swamp auth login`.",
      ),
    };
    return;
  }

  if (input.scopes.length === 0) {
    yield {
      kind: "error",
      error: validationFailed("At least one scope is required."),
    };
    return;
  }

  const credentials = await deps.loadCredentials();
  if (!credentials) {
    yield { kind: "error", error: notAuthenticated() };
    return;
  }

  const serverUrl = deps.serverUrlOverride ?? credentials.serverUrl ??
    DEFAULT_SWAMP_CLUB_URL;
  const host = deps.getHostname().slice(0, 14);
  const tokenName = input.name ?? `cli-${host}-${deps.getTimestamp()}`;

  yield { kind: "creating", collective: input.collective, name: tokenName };

  try {
    const response = await deps.createToken(
      serverUrl,
      credentials.apiKey,
      input.collective,
      { name: tokenName, scopes: input.scopes },
      ctx.signal,
    );

    yield {
      kind: "completed",
      data: {
        key: response.key,
        id: response.token.id,
        name: response.token.name,
        collective: input.collective,
        scopes: response.token.scopes,
      },
    };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    throw error;
  }
}
