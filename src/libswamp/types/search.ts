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
 * A single type search result item.
 */
export interface TypeSearchItem {
  raw: string;
  normalized: string;
}

/**
 * Data payload for the completed event.
 */
export interface TypeSearchData {
  query: string;
  results: TypeSearchItem[];
  hint?: string;
}

export type TypeSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: TypeSearchData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the type search generator.
 */
export interface TypeSearchDeps {
  getRegisteredTypes(): Array<{ raw: string; normalized: string }>;
}

/**
 * Input for the type search generator.
 */
export interface TypeSearchInput {
  query?: string;
}

/**
 * Searches registered model types.
 *
 * Returns all types — filtering for JSON mode is handled by the renderer.
 * The Ink renderer uses fzf for interactive fuzzy matching.
 */
export async function* typeSearch(
  _ctx: LibSwampContext,
  deps: TypeSearchDeps,
  input: TypeSearchInput,
): AsyncGenerator<TypeSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.type.search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const types = deps.getRegisteredTypes();
      const results: TypeSearchItem[] = types.map((t) => ({
        raw: t.raw,
        normalized: t.normalized,
      }));

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
