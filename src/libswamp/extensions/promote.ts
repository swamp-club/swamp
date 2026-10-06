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
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import type { PublishedVersion } from "../../domain/extensions/extension_publish_checks.ts";
import { findPublishedVersion } from "./published_version_lookup.ts";
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
  /** The registry lookup found the version on a channel below the target. */
  | {
    kind: "resolved";
    name: string;
    version: string;
    fromChannel: string;
    toChannel: string;
  }
  | { kind: "completed"; data: ExtensionPromoteData }
  | { kind: "error"; error: SwampError };

export interface ExtensionPromoteInput {
  extensionName: string;
  version: string;
  toChannel: string;
  fromChannel?: string;
  /**
   * Look the version up in the registry first and promote from the channel
   * it is on, failing with "Nothing to promote" when no channel below the
   * target carries it. Set when the name and version came from a manifest.
   */
  resolveFromChannel?: boolean;
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
  findPublishedVersion: (
    serverUrl: string,
    name: string,
    version: string,
    apiKey: string,
  ) => Promise<PublishedVersion | null>;
}

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

export function createExtensionPromoteDeps(
  identity?: ClientIdentity,
): ExtensionPromoteDeps {
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
      const client = new ExtensionApiClient(serverUrl, identity);
      return await client.promoteExtension(name, version, toChannel, apiKey);
    },
    findPublishedVersion: async (serverUrl, name, version, apiKey) => {
      // Built like push's lookup client, so both ask the same server.
      const client = new ExtensionApiClient(serverUrl, identity);
      return await findPublishedVersion(client, name, version, apiKey);
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

      if (input.resolveFromChannel) {
        let published: PublishedVersion | null;
        try {
          published = await deps.findPublishedVersion(
            credentials.serverUrl,
            input.extensionName,
            input.version,
            credentials.apiKey,
          );
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          // Mapped like the promote call below; a missing version is not an
          // error here (the lookup answers null), so there is no 404 case.
          const isAuth = error instanceof UserError &&
            message.includes("Not authenticated");
          yield {
            kind: "error",
            error: isAuth ? notAuthenticated() : validationFailed(message),
          };
          return;
        }
        const ref = `${input.extensionName}@${input.version}`;
        if (!published) {
          yield {
            kind: "error",
            error: validationFailed(
              `Nothing to promote: ${ref} is not published on any channel.`,
            ),
          };
          return;
        }
        if (
          !ReleaseChannel.isValid(published.channel) ||
          !ReleaseChannel.create(published.channel).canPromoteTo(
            ReleaseChannel.create(input.toChannel),
          )
        ) {
          yield {
            kind: "error",
            error: validationFailed(
              `Nothing to promote: ${ref} is on channel '${published.channel}', ` +
                `which is not below '${input.toChannel}'.`,
            ),
          };
          return;
        }
        yield {
          kind: "resolved",
          name: input.extensionName,
          version: input.version,
          fromChannel: published.channel,
          toChannel: input.toChannel,
        };
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
