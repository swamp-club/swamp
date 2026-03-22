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

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;
const DEFAULT_SERVER_URL = "https://swamp.club";

/** Data structure for the extension yank output. */
export interface ExtensionYankData {
  name: string;
  version: string | null;
  reason: string;
}

export type ExtensionYankEvent =
  | { kind: "completed"; data: ExtensionYankData }
  | { kind: "error"; error: SwampError };

/** Input for the extension yank operation. */
export interface ExtensionYankInput {
  extensionName: string;
  version: string | null;
  reason: string;
}

/** Preview data returned before confirmation. */
export interface ExtensionYankPreview {
  extensionName: string;
  version: string | null;
  reason: string;
}

/** Dependencies for the extension yank operation. */
export interface ExtensionYankDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  yankExtension: (
    serverUrl: string,
    name: string,
    version: string | null,
    reason: string,
    apiKey: string,
  ) => Promise<void>;
}

/** Wires real infrastructure into ExtensionYankDeps. */
export function createExtensionYankDeps(): ExtensionYankDeps {
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
    yankExtension: async (
      serverUrl: string,
      name: string,
      version: string | null,
      reason: string,
      apiKey: string,
    ) => {
      const client = new ExtensionApiClient(serverUrl);
      await client.yankExtension(name, version, reason, apiKey);
    },
  };
}

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SERVER_URL;
}

/** Gathers preview info for the extension yank operation, validating inputs. */
export async function extensionYankPreview(
  ctx: LibSwampContext,
  deps: ExtensionYankDeps,
  input: ExtensionYankInput,
): Promise<ExtensionYankPreview> {
  ctx.logger.debug`Validating extension yank preview`;

  // Validate credentials
  const credentials = await deps.loadCredentials();
  if (!credentials) {
    throw notAuthenticated();
  }

  // Validate extension name
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

/** Yanks an extension or specific version from the registry. */
export async function* extensionYank(
  ctx: LibSwampContext,
  deps: ExtensionYankDeps,
  input: ExtensionYankInput,
): AsyncIterable<ExtensionYankEvent> {
  ctx.logger.debug`Executing extension yank`;

  // Re-validate credentials (self-contained)
  const credentials = await deps.loadCredentials();
  if (!credentials) {
    yield { kind: "error", error: notAuthenticated() };
    return;
  }

  await deps.yankExtension(
    credentials.serverUrl,
    input.extensionName,
    input.version,
    input.reason,
    credentials.apiKey,
  );

  ctx.logger.debug`Yanked extension ${input.extensionName}`;

  yield {
    kind: "completed",
    data: {
      name: input.extensionName,
      version: input.version,
      reason: input.reason,
    },
  };
}
