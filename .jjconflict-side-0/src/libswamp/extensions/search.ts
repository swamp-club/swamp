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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/** A single extension entry in search results. */
export interface ExtensionSearchItem {
  name: string;
  description: string;
  latestVersion: string;
  platforms: string[];
  labels: string[];
  contentTypes: string[];
  createdAt: string;
  updatedAt: string;
}

/** Pagination metadata for search results. */
export interface ExtensionSearchMeta {
  total: number;
  page: number;
  perPage: number;
}

/** Data payload for the completed event. */
export interface ExtensionSearchData {
  query: string;
  results: ExtensionSearchItem[];
  meta: ExtensionSearchMeta;
}

/** Input parameters for extension search. */
export interface ExtensionSearchInput {
  query?: string;
  collective?: string;
  platform?: string[];
  label?: string[];
  contentType?: string[];
  sort?: string;
  perPage?: number;
  page?: number;
}

/** Dependencies for the extension search operation. */
export interface ExtensionSearchDeps {
  searchExtensions(params: {
    q?: string;
    collective?: string;
    platform?: string[];
    label?: string[];
    contentType?: string[];
    sort?: string;
    perPage?: number;
    page?: number;
  }): Promise<{
    extensions: Array<{
      name: string;
      description: string;
      latestVersion: string;
      platforms: string[];
      labels: string[];
      contentTypes?: string[];
      createdAt: string;
      updatedAt: string;
    }>;
    meta: { total: number; page: number; perPage: number };
  }>;
}

export type ExtensionSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ExtensionSearchData }
  | { kind: "error"; error: SwampError };

/** Searches the extension registry and yields results. */
export async function* extensionSearch(
  _ctx: LibSwampContext,
  deps: ExtensionSearchDeps,
  input: ExtensionSearchInput,
): AsyncGenerator<ExtensionSearchEvent> {
  yield { kind: "resolving" };

  const response = await deps.searchExtensions({
    q: input.query,
    collective: input.collective,
    platform: input.platform,
    label: input.label,
    contentType: input.contentType,
    sort: input.sort,
    perPage: input.perPage,
    page: input.page,
  });

  yield {
    kind: "completed",
    data: {
      query: input.query ?? "",
      results: response.extensions.map((ext) => ({
        name: ext.name,
        description: ext.description,
        latestVersion: ext.latestVersion,
        platforms: ext.platforms,
        labels: ext.labels,
        contentTypes: ext.contentTypes ?? [],
        createdAt: ext.createdAt,
        updatedAt: ext.updatedAt,
      })),
      meta: response.meta,
    },
  };
}
