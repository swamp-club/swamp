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

export interface DatastoreTypeSearchItem {
  type: string;
  name: string;
  description: string;
}

export interface DatastoreTypeSearchData {
  query: string;
  results: DatastoreTypeSearchItem[];
}

export type DatastoreTypeSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: DatastoreTypeSearchData }
  | { kind: "error"; error: SwampError };

export interface DatastoreTypeSearchDeps {
  getDatastoreTypes(): Array<{
    type: string;
    name: string;
    description: string;
  }>;
}

export interface DatastoreTypeSearchInput {
  query?: string;
}

export async function* datastoreTypeSearch(
  _ctx: LibSwampContext,
  deps: DatastoreTypeSearchDeps,
  input: DatastoreTypeSearchInput,
): AsyncGenerator<DatastoreTypeSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.type_search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const types = deps.getDatastoreTypes();
      const results: DatastoreTypeSearchItem[] = types.map((t) => ({
        type: t.type,
        name: t.name,
        description: t.description,
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
