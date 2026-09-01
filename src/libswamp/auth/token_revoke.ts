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
import type { RevokeCollectiveTokenResponse } from "../../infrastructure/http/swamp_club_client.ts";
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

export interface AuthTokenRevokeData {
  id: string;
  name: string;
  collective: string;
}

export type AuthTokenRevokeEvent =
  | { kind: "revoking"; collective: string; tokenId: string }
  | { kind: "completed"; data: AuthTokenRevokeData }
  | { kind: "error"; error: SwampError };

export interface AuthTokenRevokeInput {
  collective: string;
  tokenId: string;
}

export interface AuthTokenRevokeDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  revokeToken: (
    serverUrl: string,
    apiKey: string,
    collective: string,
    tokenId: string,
    signal: AbortSignal,
  ) => Promise<RevokeCollectiveTokenResponse>;
  isCollectiveToken: () => boolean;
  serverUrlOverride?: string;
}

export interface CreateAuthTokenRevokeDepsOptions {
  serverUrlOverride?: string;
  identity?: ClientIdentity;
  repo?: AuthRepositoryOptions;
  isCollectiveToken: () => boolean;
}

export function createAuthTokenRevokeDeps(
  options: CreateAuthTokenRevokeDepsOptions,
): AuthTokenRevokeDeps {
  const repo = new AuthRepository(options.repo);
  return {
    loadCredentials: () => repo.load(),
    revokeToken: (serverUrl, apiKey, collective, tokenId, signal) => {
      const client = new SwampClubClient(serverUrl, options.identity);
      return client.revokeCollectiveToken(apiKey, collective, tokenId, signal);
    },
    isCollectiveToken: options.isCollectiveToken,
    serverUrlOverride: options.serverUrlOverride,
  };
}

export async function* authTokenRevoke(
  ctx: LibSwampContext,
  deps: AuthTokenRevokeDeps,
  input: AuthTokenRevokeInput,
): AsyncIterable<AuthTokenRevokeEvent> {
  if (deps.isCollectiveToken()) {
    yield {
      kind: "error",
      error: validationFailed(
        "Collective tokens cannot revoke other collective tokens. Sign in with a personal account using `swamp auth login`.",
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

  yield {
    kind: "revoking",
    collective: input.collective,
    tokenId: input.tokenId,
  };

  try {
    const response = await deps.revokeToken(
      serverUrl,
      credentials.apiKey,
      input.collective,
      input.tokenId,
      ctx.signal,
    );

    yield {
      kind: "completed",
      data: {
        id: response.token.id,
        name: response.token.name,
        collective: input.collective,
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
