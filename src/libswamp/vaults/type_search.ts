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
export interface VaultTypeSearchItem {
  type: string;
  name: string;
  description: string;
}

export interface VaultTypeSearchData {
  query: string;
  results: VaultTypeSearchItem[];
}

export type VaultTypeSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultTypeSearchData }
  | { kind: "error"; error: SwampError };

export interface VaultTypeSearchDeps {
  getVaultTypes(): Array<{
    type: string;
    name: string;
    description: string;
  }>;
}

export interface VaultTypeSearchInput {
  query?: string;
}

/** returns all vault types; filtering for JSON mode is done by the renderer */
export async function* vaultTypeSearch(
  _ctx: LibSwampContext,
  deps: VaultTypeSearchDeps,
  input: VaultTypeSearchInput,
): AsyncGenerator<VaultTypeSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.type_search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const types = deps.getVaultTypes();
      const results: VaultTypeSearchItem[] = types.map((t) => ({
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
