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

import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notAuthenticated, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

/**
 * Data structure for the extension unyank output.
 *
 * Note: `reason` is nullable (unlike the yank equivalent where reason is
 * required). The unyank endpoint accepts an empty body, so callers may omit
 * a reason. JSON consumers should handle `reason: null` explicitly.
 */
export interface ExtensionUnyankData {
  name: string;
  version: string | null;
  reason: string | null;
}

export type ExtensionUnyankEvent =
  | { kind: "completed"; data: ExtensionUnyankData }
  | { kind: "error"; error: SwampError };

/** Input for the extension unyank operation. */
export interface ExtensionUnyankInput {
  extensionName: string;
  version: string | null;
  reason: string | null;
}

/** Preview data returned before executing the mutation. */
export interface ExtensionUnyankPreview {
  extensionName: string;
  version: string | null;
  reason: string | null;
}

/** Dependencies for the extension unyank operation. */
export interface ExtensionUnyankDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  unyankExtension: (
    serverUrl: string,
    name: string,
    version: string | null,
    reason: string | null,
    apiKey: string,
  ) => Promise<void>;
}

/** Wires real infrastructure into ExtensionUnyankDeps. */
export function createExtensionUnyankDeps(): ExtensionUnyankDeps {
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
    unyankExtension: async (
      serverUrl: string,
      name: string,
      version: string | null,
      reason: string | null,
      apiKey: string,
    ) => {
      const client = new ExtensionApiClient(serverUrl);
      await client.unyankExtension(name, version, reason, apiKey);
    },
  };
}

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

/** Gathers preview info for the extension unyank operation, validating inputs. */
export async function extensionUnyankPreview(
  ctx: LibSwampContext,
  deps: ExtensionUnyankDeps,
  input: ExtensionUnyankInput,
): Promise<ExtensionUnyankPreview> {
  ctx.logger.debug`Validating extension unyank preview`;

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
    version: input.version,
    reason: input.reason,
  };
}

/** Unyanks an extension or specific version, restoring availability. */
export async function* extensionUnyank(
  ctx: LibSwampContext,
  deps: ExtensionUnyankDeps,
  input: ExtensionUnyankInput,
): AsyncIterable<ExtensionUnyankEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.unyank",
    {},
    (async function* () {
      ctx.logger.debug`Executing extension unyank`;

      const credentials = await deps.loadCredentials();
      if (!credentials) {
        yield { kind: "error", error: notAuthenticated() };
        return;
      }

      await deps.unyankExtension(
        credentials.serverUrl,
        input.extensionName,
        input.version,
        input.reason,
        credentials.apiKey,
      );

      ctx.logger.debug`Unyanked extension ${input.extensionName}`;

      yield {
        kind: "completed",
        data: {
          name: input.extensionName,
          version: input.version,
          reason: input.reason,
        },
      };
    })(),
  );
}
