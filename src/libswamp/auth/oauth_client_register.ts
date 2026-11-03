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

import { resolveOAuthProviderUrl } from "../../domain/access/serve_auth_config.ts";
import { UserError } from "../../domain/errors.ts";
import { registerClientWithApiKey } from "../../infrastructure/http/oauth_client_registration.ts";
import { resolveApiKey } from "../../infrastructure/persistence/api_key_source.ts";
import type { LibSwampContext } from "../context.ts";
import { cancelled, type SwampError, validationFailed } from "../errors.ts";

export interface AuthOAuthClientRegisterData {
  clientId: string;
  clientName: string;
  clientSecret: string;
  provider: string;
}

export type AuthOAuthClientRegisterEvent =
  | { kind: "registering"; clientName: string; provider: string }
  | { kind: "completed"; data: AuthOAuthClientRegisterData }
  | { kind: "error"; error: SwampError };

export interface AuthOAuthClientRegisterInput {
  name: string;
  provider?: string;
}

export interface AuthOAuthClientRegisterDeps {
  resolveApiKey: () => string | undefined;
  registerClient: (
    provider: string,
    apiKey: string,
    clientName: string,
    signal: AbortSignal,
  ) => Promise<{ clientId: string; clientSecret: string }>;
}

export function createAuthOAuthClientRegisterDeps(): AuthOAuthClientRegisterDeps {
  return {
    resolveApiKey,
    registerClient: registerClientWithApiKey,
  };
}

export async function* authOAuthClientRegister(
  ctx: LibSwampContext,
  deps: AuthOAuthClientRegisterDeps,
  input: AuthOAuthClientRegisterInput,
): AsyncIterable<AuthOAuthClientRegisterEvent> {
  const clientName = input.name.trim();
  if (clientName === "") {
    yield {
      kind: "error",
      error: validationFailed("--name must not be empty."),
    };
    return;
  }

  let provider: string;
  try {
    provider = resolveOAuthProviderUrl(input.provider);
  } catch (error) {
    if (error instanceof UserError) {
      yield { kind: "error", error: validationFailed(error.message) };
      return;
    }
    throw error;
  }

  // A personal login would register a personal client that no collective
  // lists, so only a collective key is accepted.
  const apiKey = deps.resolveApiKey();
  if (apiKey === undefined) {
    yield {
      kind: "error",
      error: validationFailed(
        "Registering an OAuth client needs a collective API token with the oauth:manage scope. " +
          "Set SWAMP_API_KEY, SWAMP_API_KEY_FILE or --club-api-key-file.",
      ),
    };
    return;
  }

  yield { kind: "registering", clientName, provider };

  try {
    const result = await deps.registerClient(
      provider,
      apiKey,
      clientName,
      ctx.signal,
    );
    yield {
      kind: "completed",
      data: {
        clientId: result.clientId,
        clientName,
        clientSecret: result.clientSecret,
        provider,
      },
    };
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    if (error instanceof Error) {
      yield {
        kind: "error",
        error: {
          code: "registration_failed",
          message: `OAuth client registration failed: ${error.message}`,
          cause: error,
        },
      };
      return;
    }
    throw error;
  }
}
