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
import type {
  CollectiveTokenMetadata,
  ListCollectiveTokensResponse,
} from "../../infrastructure/http/swamp_club_client.ts";
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

export interface AuthTokenListItem {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  scopes: string[];
}

export interface AuthTokenListData {
  collective: string;
  tokens: AuthTokenListItem[];
}

export type AuthTokenListEvent =
  | { kind: "listing"; collective: string }
  | { kind: "completed"; data: AuthTokenListData }
  | { kind: "error"; error: SwampError };

export interface AuthTokenListInput {
  collective: string;
}

export interface AuthTokenListDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  listTokens: (
    serverUrl: string,
    apiKey: string,
    collective: string,
    signal: AbortSignal,
  ) => Promise<ListCollectiveTokensResponse>;
  isCollectiveToken: () => boolean;
  serverUrlOverride?: string;
}

export interface CreateAuthTokenListDepsOptions {
  serverUrlOverride?: string;
  identity?: ClientIdentity;
  repo?: AuthRepositoryOptions;
  isCollectiveToken: () => boolean;
}

export function createAuthTokenListDeps(
  options: CreateAuthTokenListDepsOptions,
): AuthTokenListDeps {
  const repo = new AuthRepository(options.repo);
  return {
    loadCredentials: () => repo.load(),
    listTokens: (serverUrl, apiKey, collective, signal) => {
      const client = new SwampClubClient(serverUrl, options.identity);
      return client.listCollectiveTokens(apiKey, collective, signal);
    },
    isCollectiveToken: options.isCollectiveToken,
    serverUrlOverride: options.serverUrlOverride,
  };
}

function toListItem(token: CollectiveTokenMetadata): AuthTokenListItem {
  return {
    id: token.id,
    name: token.name,
    keyPrefix: token.keyPrefix,
    enabled: token.enabled,
    expiresAt: token.expiresAt,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    scopes: token.scopes,
  };
}

export async function* authTokenList(
  ctx: LibSwampContext,
  deps: AuthTokenListDeps,
  input: AuthTokenListInput,
): AsyncIterable<AuthTokenListEvent> {
  if (deps.isCollectiveToken()) {
    yield {
      kind: "error",
      error: validationFailed(
        "Collective tokens cannot list other collective tokens. Sign in with a personal account using `swamp auth login`.",
      ),
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

  yield { kind: "listing", collective: input.collective };

  try {
    const response = await deps.listTokens(
      serverUrl,
      credentials.apiKey,
      input.collective,
      ctx.signal,
    );

    yield {
      kind: "completed",
      data: {
        collective: input.collective,
        tokens: response.tokens.map(toListItem),
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
