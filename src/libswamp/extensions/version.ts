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

import { CalVer } from "../../domain/models/calver.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { resolveServerUrl } from "./pull.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Latest published version on a single prerelease channel. */
export interface ChannelVersionInfo {
  latest: string;
}

/**
 * Per-channel latest prerelease versions. A channel key is present only when
 * that channel has a published version — never with a null latest.
 */
export type PrereleaseChannels = Partial<
  Record<"beta" | "rc", ChannelVersionInfo>
>;

/** Data payload for the completed event. */
export interface ExtensionVersionData {
  extensionName: string;
  currentPublished: string | null;
  publishedAt: string | null;
  nextVersion: string;
  /**
   * Latest prerelease versions per channel. Present only when at least one
   * prerelease exists, and carries only the channels that have a published
   * latest. Omitted entirely for never-published and stable-only extensions.
   */
  channels?: PrereleaseChannels;
}

export type ExtensionVersionEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ExtensionVersionData }
  | { kind: "error"; error: SwampError };

/** Input for the extension version operation. */
export interface ExtensionVersionInput {
  extensionName: string;
}

/**
 * Latest published version on each channel, as reported by the registry.
 * Any field is null when that channel has no published version. Extension
 * versions are globally unique per extension across channels (a version
 * document carries one channel and promotion just updates it).
 */
export interface PublishedVersions {
  stable: string | null;
  beta: string | null;
  rc: string | null;
}

/** Dependencies for the extension version operation. */
export interface ExtensionVersionDeps {
  /** Resolves per-channel latest versions, or null when the extension does not exist. */
  getPublishedVersions: (name: string) => Promise<PublishedVersions | null>;
}

/** Wires real infrastructure into ExtensionVersionDeps. No authentication required. */
export function createExtensionVersionDeps(
  identity?: ClientIdentity,
): ExtensionVersionDeps {
  const serverUrl = resolveServerUrl();
  const client = new ExtensionApiClient(serverUrl, identity);
  const apiKey = identity?.bearerToken;
  return {
    getPublishedVersions: async (name: string) => {
      const info = await client.getExtension(name, apiKey);
      if (!info) return null;
      return {
        stable: info.latestVersion ?? null,
        beta: info.latestBeta ?? null,
        rc: info.latestRc ?? null,
      };
    },
  };
}

/** Queries the registry for the latest published version and computes the next CalVer version. */
export async function* extensionVersion(
  _ctx: LibSwampContext,
  deps: ExtensionVersionDeps,
  input: ExtensionVersionInput,
): AsyncIterable<ExtensionVersionEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.version",
    { "extension.name": input.extensionName },
    (async function* () {
      yield { kind: "resolving" };

      try {
        const published = await deps.getPublishedVersions(input.extensionName);

        // The next publishable version must exceed the max across all channels,
        // since versions are globally unique per extension. Filter to valid
        // CalVers and pick the highest as the bump baseline.
        const baseline = published
          ? [published.stable, published.beta, published.rc]
            .filter((v): v is string => v !== null && CalVer.isValid(v))
            .map((v) => CalVer.create(v))
            .reduce(
              (max: CalVer | undefined, v) =>
                max === undefined || CalVer.compare(v, max) > 0 ? v : max,
              undefined,
            )
          : undefined;
        const nextVersion = CalVer.bump(baseline);

        // Surface latest prerelease versions per channel, omitting channels
        // with no published latest. Undefined when no prerelease exists.
        const channels: PrereleaseChannels = {};
        if (published?.beta) channels.beta = { latest: published.beta };
        if (published?.rc) channels.rc = { latest: published.rc };
        const hasPrerelease = Object.keys(channels).length > 0;

        yield {
          kind: "completed",
          data: {
            extensionName: input.extensionName,
            currentPublished: published?.stable ?? null,
            publishedAt: null,
            nextVersion: nextVersion.value,
            ...(hasPrerelease ? { channels } : {}),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield {
          kind: "error",
          error: {
            code: "version_lookup_failed",
            message:
              `Failed to look up version for ${input.extensionName}: ${message}`,
          },
        };
      }
    })(),
  );
}
