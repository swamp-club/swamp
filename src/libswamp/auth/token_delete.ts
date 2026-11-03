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
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import {
  AuthRepository,
  type AuthRepositoryOptions,
} from "../../infrastructure/persistence/auth_repository.ts";
import type { LibSwampContext } from "../context.ts";
import { cancelled, notAuthenticated, type SwampError } from "../errors.ts";

export interface AuthTokenDeleteData {
  id: string;
  collective: string;
}

export type AuthTokenDeleteEvent =
  | { kind: "deleting"; collective: string; tokenId: string }
  | { kind: "completed"; data: AuthTokenDeleteData }
  | { kind: "error"; error: SwampError };

export interface AuthTokenDeleteInput {
  collective: string;
  tokenId: string;
}

export interface AuthTokenDeleteDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  deleteToken: (
    serverUrl: string,
    apiKey: string,
    collective: string,
    tokenId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  serverUrlOverride?: string;
}

export interface CreateAuthTokenDeleteDepsOptions {
  serverUrlOverride?: string;
  identity?: ClientIdentity;
  repo?: AuthRepositoryOptions;
  isCollectiveToken: () => boolean;
}

export function createAuthTokenDeleteDeps(
  options: CreateAuthTokenDeleteDepsOptions,
): AuthTokenDeleteDeps {
  const repo = new AuthRepository(options.repo);
  return {
    loadCredentials: () => repo.load(),
    deleteToken: (serverUrl, apiKey, collective, tokenId, signal) => {
      const client = new SwampClubClient(serverUrl, options.identity);
      // only to word the server's refusal; the server decides who may delete
      return client.deleteCollectiveToken(apiKey, collective, tokenId, {
        collectiveKey: options.isCollectiveToken(),
        signal,
      });
    },
    serverUrlOverride: options.serverUrlOverride,
  };
}

export async function* authTokenDelete(
  ctx: LibSwampContext,
  deps: AuthTokenDeleteDeps,
  input: AuthTokenDeleteInput,
): AsyncIterable<AuthTokenDeleteEvent> {
  const credentials = await deps.loadCredentials();
  if (!credentials) {
    yield { kind: "error", error: notAuthenticated() };
    return;
  }

  const serverUrl = deps.serverUrlOverride ?? credentials.serverUrl ??
    DEFAULT_SWAMP_CLUB_URL;

  yield {
    kind: "deleting",
    collective: input.collective,
    tokenId: input.tokenId,
  };

  try {
    await deps.deleteToken(
      serverUrl,
      credentials.apiKey,
      input.collective,
      input.tokenId,
      ctx.signal,
    );

    yield {
      kind: "completed",
      data: {
        id: input.tokenId,
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
