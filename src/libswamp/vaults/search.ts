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
 * A single vault search result item.
 */
export interface VaultSearchItem {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}

/**
 * Data payload for the completed event.
 */
export interface VaultSearchData {
  query: string;
  results: VaultSearchItem[];
}

export type VaultSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultSearchData }
  | { kind: "error"; error: SwampError };

/**
 * Dependencies for the vault search generator.
 */
export interface VaultSearchDeps {
  findAllVaults(): Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      createdAt: Date;
    }>
  >;
}

/**
 * Input for the vault search generator.
 */
export interface VaultSearchInput {
  query?: string;
}

/**
 * Searches vault configurations.
 *
 * Returns all vaults — filtering for JSON mode is handled by the renderer.
 * The Ink renderer uses fzf for interactive fuzzy matching.
 */
export async function* vaultSearch(
  _ctx: LibSwampContext,
  deps: VaultSearchDeps,
  input: VaultSearchInput,
): AsyncGenerator<VaultSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const configs = await deps.findAllVaults();
      const results: VaultSearchItem[] = configs.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        createdAt: c.createdAt.toISOString(),
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
