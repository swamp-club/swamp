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

import {
  AuthRepository,
  type AuthRepositoryOptions,
} from "../../infrastructure/persistence/auth_repository.ts";
import {
  type RevokePresentingApiKeyResult,
  SwampClubClient,
} from "../../infrastructure/http/swamp_club_client.ts";
import { UserError } from "../../domain/errors.ts";
import type { LibSwampContext } from "../context.ts";
import { cancelled, type SwampError } from "../errors.ts";

/**
 * What happened to the stored API key on the server, for a logout that
 * completed:
 * - `revoked`: the server revoked it.
 * - `already_invalid`: the server no longer accepted it, so nothing was left
 *   to revoke.
 * - `no_key`: the stored credentials held no API key to revoke.
 */
export type AuthLogoutKeyRevocation = "revoked" | "already_invalid" | "no_key";

/**
 * Data structure for the auth logout output.
 */
export interface AuthLogoutData {
  loggedOut: boolean;
  username?: string;
  serverUrl?: string;
  reason?: string;
  keyRevocation?: AuthLogoutKeyRevocation;
  keyId?: string;
}

export type AuthLogoutEvent =
  | { kind: "completed"; data: AuthLogoutData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the auth logout operation. */
export interface AuthLogoutDeps {
  loadCredentials: () => Promise<
    { username: string; serverUrl: string; apiKey: string } | null
  >;
  revokeApiKey: (
    serverUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<RevokePresentingApiKeyResult>;
  deleteCredentials: () => Promise<void>;
  credentialsPath: () => string;
}

/**
 * Options for {@link createAuthLogoutDeps}. The `repo` field accepts
 * the same overrides as `AuthRepository` itself — used by tests to
 * bypass the shared `Deno.env` global, which races across files when
 * `deno test --parallel` runs multiple auth-touching test files at
 * once.
 */
export interface CreateAuthLogoutDepsOptions {
  repo?: AuthRepositoryOptions;
}

/** Wires real infrastructure into AuthLogoutDeps. */
export function createAuthLogoutDeps(
  options: CreateAuthLogoutDepsOptions = {},
): AuthLogoutDeps {
  // Logout only ever acts on the stored login credentials. A SWAMP_API_KEY
  // from the environment is never revoked, and SWAMP_CLUB_URL never redirects
  // where the stored key is sent.
  const repo = new AuthRepository({
    ...options.repo,
    getApiKey: () => undefined,
  });
  return {
    loadCredentials: async () => {
      const creds = await repo.load();
      if (!creds) return null;
      return {
        username: creds.username,
        serverUrl: creds.serverUrl,
        apiKey: creds.apiKey ?? "",
      };
    },
    revokeApiKey: (serverUrl, apiKey, signal) =>
      new SwampClubClient(serverUrl).revokePresentingApiKey(apiKey, signal),
    deleteCredentials: () => repo.delete(),
    credentialsPath: () => repo.getAuthPath(),
  };
}

/**
 * Revokes the stored API key on the server, then removes the stored
 * credentials. If the key cannot be revoked, the credentials are kept so the
 * key is never discarded while it is still valid.
 */
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

  let keyRevocation: AuthLogoutKeyRevocation = "no_key";
  let keyId: string | undefined;
  if (credentials.apiKey) {
    const path = deps.credentialsPath();
    const server = credentials.serverUrl;
    const keepCredentials = (reason: string, advice: string) => ({
      kind: "error" as const,
      error: {
        code: "revoke_failed",
        message: `Could not revoke the API key: ${
          /[.!?…]$/.test(reason) ? reason : `${reason}.`
        } Your credentials were kept at ${path}. ${advice}`,
      },
    });

    let result: RevokePresentingApiKeyResult;
    try {
      result = await deps.revokeApiKey(server, credentials.apiKey, ctx.signal);
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        yield { kind: "error", error: cancelled(error) };
        return;
      }
      if (error instanceof UserError) {
        yield keepCredentials(
          error.message,
          "Run 'swamp auth logout' again once this is resolved.",
        );
        return;
      }
      throw error;
    }

    switch (result.kind) {
      case "revoked":
        keyRevocation = "revoked";
        if (result.id) keyId = result.id;
        break;
      case "already_invalid":
        keyRevocation = "already_invalid";
        break;
      case "unsupported":
        // Retrying cannot help: the server has no self-revoke endpoint.
        yield keepCredentials(
          `${server} does not support revoking API keys from the CLI.`,
          `Revoke the key in the web UI under Access Tokens on ${server}, then delete ${path} to log out.`,
        );
        return;
      case "not_personal_key":
        // Retrying cannot help: only a personal API key can revoke itself.
        yield keepCredentials(
          `${server} refused to revoke the stored credential: it is not a personal API key.`,
          `Revoke it in the web UI on ${server}, then delete ${path} to log out.`,
        );
        return;
    }
  }

  await deps.deleteCredentials();

  ctx.logger.debug`Logged out ${credentials.username}`;

  const data: AuthLogoutData = {
    loggedOut: true,
    username: credentials.username,
    serverUrl: credentials.serverUrl,
    keyRevocation,
    ...(keyId ? { keyId } : {}),
  };

  yield { kind: "completed", data };
}
