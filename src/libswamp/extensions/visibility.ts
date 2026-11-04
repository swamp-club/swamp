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
import {
  ExtensionApiClient,
  type ExtensionVisibility,
} from "../../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notAuthenticated, notFound, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
import { UserError } from "../../domain/errors.ts";

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

export type { ExtensionVisibility };

export interface ExtensionVisibilityData {
  name: string;
  before: ExtensionVisibility;
  after: ExtensionVisibility;
  changed: boolean;
  dryRun: boolean;
  /** Present only when the registry applied something other than what --set asked for. */
  requested?: ExtensionVisibility;
}

export type ExtensionVisibilityEvent =
  | { kind: "completed"; data: ExtensionVisibilityData }
  | { kind: "error"; error: SwampError };

export interface ExtensionVisibilityInput {
  extensionName: string;
  target: ExtensionVisibility | null;
  dryRun: boolean;
}

export interface ExtensionVisibilityDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  /** Null when the extension does not exist or these credentials cannot see it. */
  getVisibility: (
    serverUrl: string,
    name: string,
    apiKey: string,
  ) => Promise<ExtensionVisibility | null>;
  setVisibility: (
    serverUrl: string,
    name: string,
    visibility: ExtensionVisibility,
    apiKey: string,
  ) => Promise<ExtensionVisibility>;
}

export function createExtensionVisibilityDeps(
  identity?: ClientIdentity,
): ExtensionVisibilityDeps {
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
    getVisibility: async (serverUrl, name, apiKey) => {
      const client = new ExtensionApiClient(serverUrl, identity);
      const info = await client.getExtension(name, apiKey);
      if (!info) return null;
      // a guessed value could turn --set into a false no-op
      if (typeof info.isPrivate !== "boolean") {
        throw new UserError(
          "Registry did not report this extension's visibility. Upgrade the registry, or check the visibility in the registry UI.",
        );
      }
      return info.isPrivate ? "private" : "public";
    },
    setVisibility: async (serverUrl, name, visibility, apiKey) => {
      const client = new ExtensionApiClient(serverUrl, identity);
      const result = await client.setExtensionVisibility(
        name,
        visibility,
        apiKey,
      );
      return result.isPrivate ? "private" : "public";
    },
  };
}

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

export function validateExtensionVisibilityInput(
  input: ExtensionVisibilityInput,
): SwampError | null {
  if (!SCOPED_NAME_PATTERN.test(input.extensionName)) {
    return validationFailed(
      `Invalid extension name: "${input.extensionName}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }
  if (input.dryRun && input.target === null) {
    return validationFailed(
      "--dry-run needs --set: there is no change to preview when only reading visibility.",
    );
  }
  return null;
}

export async function* extensionVisibility(
  ctx: LibSwampContext,
  deps: ExtensionVisibilityDeps,
  input: ExtensionVisibilityInput,
): AsyncIterable<ExtensionVisibilityEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.visibility",
    {},
    (async function* () {
      const invalid = validateExtensionVisibilityInput(input);
      if (invalid) {
        yield { kind: "error", error: invalid };
        return;
      }

      const credentials = await deps.loadCredentials();
      if (!credentials) {
        yield { kind: "error", error: notAuthenticated() };
        return;
      }

      const before = await deps.getVisibility(
        credentials.serverUrl,
        input.extensionName,
        credentials.apiKey,
      );
      if (before === null) {
        yield {
          kind: "error",
          error: {
            ...notFound("Extension", input.extensionName),
            message:
              `Extension not found, or not visible to these credentials: ${input.extensionName}. Check the name and run swamp auth whoami to see which collective you are acting for.`,
          },
        };
        return;
      }

      const name = input.extensionName;
      if (input.target === null || input.target === before) {
        yield {
          kind: "completed",
          data: {
            name,
            before,
            after: before,
            changed: false,
            dryRun: input.dryRun,
          },
        };
        return;
      }

      if (input.dryRun) {
        yield {
          kind: "completed",
          data: {
            name,
            before,
            after: input.target,
            changed: true,
            dryRun: true,
          },
        };
        return;
      }

      ctx.logger.debug`Setting ${name} visibility to ${input.target}`;
      const requested = input.target;
      // the registry's answer is the applied value, whatever was requested
      const after = await deps.setVisibility(
        credentials.serverUrl,
        name,
        input.target,
        credentials.apiKey,
      );
      yield {
        kind: "completed",
        data: {
          name,
          before,
          after,
          changed: after !== before,
          dryRun: false,
          ...(after !== requested ? { requested } : {}),
        },
      };
    })(),
  );
}
