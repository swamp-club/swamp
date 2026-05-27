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

import type {
  ExtensionAuthor,
  ExtensionInfo,
  ExtensionScoreSummary,
} from "../../infrastructure/http/extension_api_client.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import { resolveServerUrl } from "./pull.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface ExtensionInfoData {
  id: string;
  name: string;
  namespace: string | null;
  description: string;
  repository: string | null;
  homepageUrl: string | null;
  license: string | null;
  platforms: string[];
  labels: string[];
  contentTypes: string[];
  contentNames: string[];
  latestVersion: string;
  author: ExtensionAuthor | null;
  createdAt: string;
  updatedAt: string;
  yankedAt: string | null;
  yankReason: string | null;
  deprecatedAt: string | null;
  deprecatedByUserId: string | null;
  deprecationReason: string | null;
  supersededBy: string | null;
  repositoryVerified: boolean | null;
  repositoryVerifiedAt: string | null;
  repositoryVerifiedUrl: string | null;
  pullCount: number;
  score: ExtensionScoreSummary | null;
}

export type ExtensionInfoEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ExtensionInfoData }
  | { kind: "not_found"; extensionName: string }
  | { kind: "error"; error: SwampError };

export interface ExtensionInfoInput {
  extensionName: string;
}

export interface ExtensionInfoDeps {
  getExtension: (name: string) => Promise<ExtensionInfo | null>;
}

export function createExtensionInfoDeps(
  apiKey?: string,
): ExtensionInfoDeps {
  const serverUrl = resolveServerUrl();
  const client = new ExtensionApiClient(serverUrl);
  return {
    getExtension: (name: string) => client.getExtension(name, apiKey),
  };
}

export async function* extensionInfo(
  _ctx: LibSwampContext,
  deps: ExtensionInfoDeps,
  input: ExtensionInfoInput,
): AsyncIterable<ExtensionInfoEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.info",
    { "extension.name": input.extensionName },
    (async function* () {
      yield { kind: "resolving" as const };

      try {
        const info = await deps.getExtension(input.extensionName);

        if (!info) {
          yield {
            kind: "not_found" as const,
            extensionName: input.extensionName,
          };
          return;
        }

        yield {
          kind: "completed" as const,
          data: {
            id: info.id,
            name: info.name,
            namespace: info.namespace,
            description: info.description,
            repository: info.repository,
            homepageUrl: info.homepageUrl,
            license: info.license,
            platforms: info.platforms,
            labels: info.labels,
            contentTypes: info.contentTypes,
            contentNames: info.contentNames,
            latestVersion: info.latestVersion,
            author: info.author,
            createdAt: info.createdAt,
            updatedAt: info.updatedAt,
            yankedAt: info.yankedAt,
            yankReason: info.yankReason,
            deprecatedAt: info.deprecatedAt ?? null,
            deprecatedByUserId: info.deprecatedByUserId ?? null,
            deprecationReason: info.deprecationReason ?? null,
            supersededBy: info.supersededBy ?? null,
            repositoryVerified: info.repositoryVerified,
            repositoryVerifiedAt: info.repositoryVerifiedAt,
            repositoryVerifiedUrl: info.repositoryVerifiedUrl,
            pullCount: info.pullCount,
            score: info.score,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield {
          kind: "error" as const,
          error: {
            code: "info_lookup_failed",
            message:
              `Failed to look up info for ${input.extensionName}: ${message}`,
          },
        };
      }
    })(),
  );
}
