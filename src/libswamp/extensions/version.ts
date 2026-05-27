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

import { CalVer } from "../../domain/models/calver.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { resolveServerUrl } from "./pull.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** Data payload for the completed event. */
export interface ExtensionVersionData {
  extensionName: string;
  currentPublished: string | null;
  publishedAt: string | null;
  nextVersion: string;
}

export type ExtensionVersionEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ExtensionVersionData }
  | { kind: "error"; error: SwampError };

/** Input for the extension version operation. */
export interface ExtensionVersionInput {
  extensionName: string;
}

/** Version info resolved from the public extension metadata endpoint. */
export interface LatestVersionInfo {
  version: string;
  publishedAt: string | null;
}

/** Dependencies for the extension version operation. */
export interface ExtensionVersionDeps {
  getLatestVersion: (name: string) => Promise<LatestVersionInfo | null>;
}

/** Wires real infrastructure into ExtensionVersionDeps. No authentication required. */
export function createExtensionVersionDeps(
  identity?: ClientIdentity,
): ExtensionVersionDeps {
  const serverUrl = resolveServerUrl();
  const client = new ExtensionApiClient(serverUrl, identity);
  return {
    getLatestVersion: async (name: string) => {
      const info = await client.getExtension(name);
      if (!info) return null;
      return { version: info.latestVersion, publishedAt: null };
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
        const latest = await deps.getLatestVersion(input.extensionName);

        const previousCalVer = latest
          ? CalVer.create(latest.version)
          : undefined;
        const nextVersion = CalVer.bump(previousCalVer);

        yield {
          kind: "completed",
          data: {
            extensionName: input.extensionName,
            currentPublished: latest?.version ?? null,
            publishedAt: latest?.publishedAt ?? null,
            nextVersion: nextVersion.value,
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
