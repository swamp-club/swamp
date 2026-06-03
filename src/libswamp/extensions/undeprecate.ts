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

import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notAuthenticated, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

export interface ExtensionUndeprecateData {
  name: string;
}

export type ExtensionUndeprecateEvent =
  | { kind: "completed"; data: ExtensionUndeprecateData }
  | { kind: "error"; error: SwampError };

export interface ExtensionUndeprecateInput {
  extensionName: string;
}

export interface ExtensionUndeprecatePreview {
  extensionName: string;
}

export interface ExtensionUndeprecateDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  undeprecateExtension: (
    serverUrl: string,
    name: string,
    apiKey: string,
  ) => Promise<void>;
}

export function createExtensionUndeprecateDeps(): ExtensionUndeprecateDeps {
  const authRepo = new AuthRepository();
  return {
    loadCredentials: async () => {
      const creds = await authRepo.load();
      if (!creds) return null;
      return {
        serverUrl: creds.serverUrl ?? resolveServerUrl(),
        apiKey: creds.apiKey,
      };
    },
    undeprecateExtension: async (
      serverUrl: string,
      name: string,
      apiKey: string,
    ) => {
      const client = new ExtensionApiClient(serverUrl);
      await client.undeprecateExtension(name, apiKey);
    },
  };
}

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

export async function extensionUndeprecatePreview(
  ctx: LibSwampContext,
  deps: ExtensionUndeprecateDeps,
  input: ExtensionUndeprecateInput,
): Promise<ExtensionUndeprecatePreview> {
  ctx.logger.debug`Validating extension undeprecate preview`;

  const credentials = await deps.loadCredentials();
  if (!credentials) {
    throw notAuthenticated();
  }

  if (!SCOPED_NAME_PATTERN.test(input.extensionName)) {
    throw validationFailed(
      `Invalid extension name: "${input.extensionName}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }

  return {
    extensionName: input.extensionName,
  };
}

export async function* extensionUndeprecate(
  ctx: LibSwampContext,
  deps: ExtensionUndeprecateDeps,
  input: ExtensionUndeprecateInput,
): AsyncIterable<ExtensionUndeprecateEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.undeprecate",
    {},
    (async function* () {
      ctx.logger.debug`Executing extension undeprecate`;

      const credentials = await deps.loadCredentials();
      if (!credentials) {
        yield { kind: "error", error: notAuthenticated() };
        return;
      }

      await deps.undeprecateExtension(
        credentials.serverUrl,
        input.extensionName,
        credentials.apiKey,
      );

      ctx.logger.debug`Undeprecated extension ${input.extensionName}`;

      yield {
        kind: "completed",
        data: {
          name: input.extensionName,
        },
      };
    })(),
  );
}
