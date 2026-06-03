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

export interface ExtensionDeprecateData {
  name: string;
  reason: string;
  supersededBy: string | null;
}

export type ExtensionDeprecateEvent =
  | { kind: "completed"; data: ExtensionDeprecateData }
  | { kind: "error"; error: SwampError };

export interface ExtensionDeprecateInput {
  extensionName: string;
  reason: string;
  supersededBy: string | null;
}

export interface ExtensionDeprecatePreview {
  extensionName: string;
  reason: string;
  supersededBy: string | null;
}

export interface ExtensionDeprecateDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  deprecateExtension: (
    serverUrl: string,
    name: string,
    reason: string,
    supersededBy: string | null,
    apiKey: string,
  ) => Promise<void>;
}

export function createExtensionDeprecateDeps(): ExtensionDeprecateDeps {
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
    deprecateExtension: async (
      serverUrl: string,
      name: string,
      reason: string,
      supersededBy: string | null,
      apiKey: string,
    ) => {
      const client = new ExtensionApiClient(serverUrl);
      await client.deprecateExtension(name, reason, supersededBy, apiKey);
    },
  };
}

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

export async function extensionDeprecatePreview(
  ctx: LibSwampContext,
  deps: ExtensionDeprecateDeps,
  input: ExtensionDeprecateInput,
): Promise<ExtensionDeprecatePreview> {
  ctx.logger.debug`Validating extension deprecate preview`;

  const credentials = await deps.loadCredentials();
  if (!credentials) {
    throw notAuthenticated();
  }

  if (!SCOPED_NAME_PATTERN.test(input.extensionName)) {
    throw validationFailed(
      `Invalid extension name: "${input.extensionName}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }

  if (
    input.supersededBy !== null &&
    !SCOPED_NAME_PATTERN.test(input.supersededBy)
  ) {
    throw validationFailed(
      `Invalid successor extension name: "${input.supersededBy}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }

  return {
    extensionName: input.extensionName,
    reason: input.reason,
    supersededBy: input.supersededBy,
  };
}

export async function* extensionDeprecate(
  ctx: LibSwampContext,
  deps: ExtensionDeprecateDeps,
  input: ExtensionDeprecateInput,
): AsyncIterable<ExtensionDeprecateEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.deprecate",
    {},
    (async function* () {
      ctx.logger.debug`Executing extension deprecate`;

      const credentials = await deps.loadCredentials();
      if (!credentials) {
        yield { kind: "error", error: notAuthenticated() };
        return;
      }

      await deps.deprecateExtension(
        credentials.serverUrl,
        input.extensionName,
        input.reason,
        input.supersededBy,
        credentials.apiKey,
      );

      ctx.logger.debug`Deprecated extension ${input.extensionName}`;

      yield {
        kind: "completed",
        data: {
          name: input.extensionName,
          reason: input.reason,
          supersededBy: input.supersededBy,
        },
      };
    })(),
  );
}
