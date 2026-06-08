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

import type { LibSwampContext } from "../context.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { creekRegistry } from "../../domain/creeks/creek_registry.ts";
import type {
  CreekTypeSearchEvent,
  CreekTypeSearchItem,
} from "./creek_views.ts";

export interface CreekTypeSearchDeps {
  /**
   * Returns the registered creek types. Each item carries enough info to
   * render search results without forcing the full bundle to be imported
   * (lazy entries report `methodCount: undefined`).
   */
  getCreekTypes(): Array<{
    type: string;
    version: string;
    description?: string;
    methodCount: number;
  }>;
}

/** Wires the real registry into CreekTypeSearchDeps. */
export async function createCreekTypeSearchDeps(): Promise<
  CreekTypeSearchDeps
> {
  await creekRegistry.ensureLoaded();
  return {
    getCreekTypes() {
      const loaded = creekRegistry.getAll().map((c) => ({
        type: c.type,
        version: c.version,
        description: c.description,
        methodCount: Object.keys(c.methods).length,
      }));
      const lazy = creekRegistry.getAllLazy().map((entry) => ({
        type: entry.type,
        version: entry.version,
        description: undefined as string | undefined,
        methodCount: 0,
      }));
      return [...loaded, ...lazy];
    },
  };
}

export interface CreekTypeSearchInput {
  query?: string;
}

export async function* creekTypeSearch(
  _ctx: LibSwampContext,
  deps: CreekTypeSearchDeps,
  input: CreekTypeSearchInput,
): AsyncGenerator<CreekTypeSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.creek.type_search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const all = deps.getCreekTypes();
      const query = input.query?.trim().toLowerCase() ?? "";
      const filtered = query
        ? all.filter((t) =>
          t.type.toLowerCase().includes(query) ||
          (t.description?.toLowerCase().includes(query) ?? false)
        )
        : all;

      const results: CreekTypeSearchItem[] = filtered.map((t) => ({
        type: t.type,
        version: t.version,
        description: t.description,
        methodCount: t.methodCount,
      }));

      yield {
        kind: "completed",
        data: { query: input.query ?? "", results },
      };
    })(),
  );
}
