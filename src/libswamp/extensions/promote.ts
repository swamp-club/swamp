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
import type { PromoteResult } from "../../infrastructure/http/extension_api_client.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notAuthenticated, notFound, validationFailed } from "../errors.ts";
import { UserError } from "../../domain/errors.ts";
import { ReleaseChannel } from "../../domain/extensions/release_channel.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

export interface ExtensionPromoteData {
  name: string;
  version: string;
  previousChannel: string;
  channel: string;
  message: string;
}

export type ExtensionPromoteEvent =
  | { kind: "promoting" }
  | { kind: "completed"; data: ExtensionPromoteData }
  | { kind: "error"; error: SwampError };

export interface ExtensionPromoteInput {
  extensionName: string;
  version: string;
  toChannel: string;
  fromChannel?: string;
}

export interface ExtensionPromoteDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  promoteExtension: (
    serverUrl: string,
    name: string,
    version: string,
    toChannel: string,
    apiKey: string,
  ) => Promise<PromoteResult>;
}

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

export function createExtensionPromoteDeps(): ExtensionPromoteDeps {
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
    promoteExtension: async (
      serverUrl: string,
      name: string,
      version: string,
      toChannel: string,
      apiKey: string,
    ) => {
      const client = new ExtensionApiClient(serverUrl);
      return await client.promoteExtension(name, version, toChannel, apiKey);
    },
  };
}

export function extensionPromoteValidate(
  input: ExtensionPromoteInput,
): void {
  if (!SCOPED_NAME_PATTERN.test(input.extensionName)) {
    throw validationFailed(
      `Invalid extension name: "${input.extensionName}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }

  if (
    input.toChannel !== "rc" && input.toChannel !== "stable"
  ) {
    throw validationFailed(
      `Invalid target channel: "${input.toChannel}". Must be 'rc' or 'stable'.`,
    );
  }

  const target = ReleaseChannel.create(input.toChannel);
  if (input.fromChannel) {
    if (!ReleaseChannel.isValid(input.fromChannel)) {
      throw validationFailed(
        `Invalid source channel: "${input.fromChannel}". Must be one of: beta, rc, stable`,
      );
    }
    const source = ReleaseChannel.create(input.fromChannel);
    if (!source.canPromoteTo(target)) {
      throw validationFailed(
        `Cannot promote from ${input.fromChannel} to ${input.toChannel}. Promotion must move to a higher channel.`,
      );
    }
  }
}

export async function* extensionPromote(
  ctx: LibSwampContext,
  deps: ExtensionPromoteDeps,
  input: ExtensionPromoteInput,
): AsyncIterable<ExtensionPromoteEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.promote",
    {},
    (async function* () {
      yield { kind: "promoting" } as const;

      ctx.logger.debug`Executing extension promote`;

      const credentials = await deps.loadCredentials();
      if (!credentials) {
        yield { kind: "error", error: notAuthenticated() };
        return;
      }

      let result: PromoteResult;
      try {
        result = await deps.promoteExtension(
          credentials.serverUrl,
          input.extensionName,
          input.version,
          input.toChannel,
          credentials.apiKey,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isAuth = error instanceof UserError &&
          message.includes("Not authenticated");
        const is404 = error instanceof UserError &&
          (message.includes("not found") || message.includes("Not Found"));
        yield {
          kind: "error" as const,
          error: isAuth ? notAuthenticated() : is404
            ? notFound(
              "extension version",
              `${input.extensionName}@${input.version}`,
            )
            : validationFailed(message),
        };
        return;
      }

      ctx.logger
        .debug`Promoted extension ${input.extensionName}@${input.version} to ${input.toChannel}`;

      yield {
        kind: "completed",
        data: {
          name: result.name,
          version: result.version,
          previousChannel: result.previousChannel,
          channel: result.channel,
          message: result.message,
        },
      };
    })(),
  );
}
