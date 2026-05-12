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

export interface DriverTypeSearchItem {
  type: string;
  name: string;
  description: string;
}

export interface DriverTypeSearchData {
  query: string;
  results: DriverTypeSearchItem[];
}

export type DriverTypeSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: DriverTypeSearchData }
  | { kind: "error"; error: SwampError };

export interface DriverTypeSearchDeps {
  getDriverTypes(): Array<{
    type: string;
    name: string;
    description: string;
  }>;
}

export interface DriverTypeSearchInput {
  query?: string;
}

export async function* driverTypeSearch(
  _ctx: LibSwampContext,
  deps: DriverTypeSearchDeps,
  input: DriverTypeSearchInput,
): AsyncGenerator<DriverTypeSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.driver.type_search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const types = deps.getDriverTypes();
      const results: DriverTypeSearchItem[] = types.map((t) => ({
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
