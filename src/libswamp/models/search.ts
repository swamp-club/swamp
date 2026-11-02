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
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export interface ModelSearchItem {
  id: string;
  name: string;
  type: string;
}

export interface ModelSearchData {
  query: string;
  results: ModelSearchItem[];
}

export type ModelSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ModelSearchData }
  | { kind: "error"; error: SwampError };

export interface ModelSearchDeps {
  findAllGlobal(): Promise<
    Array<{
      definition: { id: string; name: string };
      type: { normalized: string };
    }>
  >;
  isInternalType?: (type: string) => boolean;
}

export interface ModelSearchInput {
  query?: string;
  includeInternal?: boolean;
}

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
      const filtered = input.includeInternal || !deps.isInternalType
        ? allResults
        : allResults.filter((r) => !deps.isInternalType!(r.type.normalized));
      const results: ModelSearchItem[] = filtered.map(
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
