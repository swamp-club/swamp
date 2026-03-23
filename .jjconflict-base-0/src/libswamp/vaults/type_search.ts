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
 * A single vault type search result item.
 */
export interface VaultTypeSearchItem {
  type: string;
  name: string;
  description: string;
}

/**
 * Data payload for the completed event.
 */
export interface VaultTypeSearchData {
  query: string;
  results: VaultTypeSearchItem[];
}

export type VaultTypeSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultTypeSearchData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the vault type search generator.
 */
export interface VaultTypeSearchDeps {
  getVaultTypes(): Array<{
    type: string;
    name: string;
    description: string;
  }>;
}

/**
 * Input for the vault type search generator.
 */
export interface VaultTypeSearchInput {
  query?: string;
}

/**
 * Searches available vault types.
 *
 * Returns all vault types — filtering for JSON mode is handled by the renderer.
 * The Ink renderer uses fzf for interactive fuzzy matching.
 */
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
