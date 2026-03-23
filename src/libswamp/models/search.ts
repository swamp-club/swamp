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

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * A single model search result item.
 */
export interface ModelSearchItem {
  id: string;
  name: string;
  type: string;
}

/**
 * Data payload for the completed event.
 */
export interface ModelSearchData {
  query: string;
  results: ModelSearchItem[];
}

export type ModelSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelSearchData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the model search generator.
 */
export interface ModelSearchDeps {
  findAllGlobal(): Promise<
    Array<{
      definition: { id: string; name: string };
      type: { normalized: string };
    }>
  >;
}

/**
 * Input for the model search generator.
 */
export interface ModelSearchInput {
  query?: string;
}

/**
 * Searches model definitions across all types.
 *
 * Returns all models — filtering for JSON mode is handled by the renderer.
 * The Ink renderer uses fzf for interactive fuzzy matching.
 */
export async function* modelSearch(
  _ctx: LibSwampContext,
  deps: ModelSearchDeps,
  input: ModelSearchInput,
): AsyncGenerator<ModelSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.model.search",
    { "search.query": input.query ?? "" },
    (async function* () {
      yield { kind: "resolving" };

      const allResults = await deps.findAllGlobal();
      const results: ModelSearchItem[] = allResults.map(
        ({ definition, type }) => ({
          id: definition.id,
          name: definition.name,
          type: type.normalized,
        }),
      );

      yield {
        kind: "completed",
        data: {
          query: input.query ?? "",
          results,
        },
      };
    })(),
  );
}
