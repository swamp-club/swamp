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
export interface VaultSearchItem {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}

export interface VaultSearchData {
  query: string;
  results: VaultSearchItem[];
}

export type VaultSearchEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultSearchData }
  | { kind: "error"; error: SwampError };

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

export interface VaultSearchInput {
  query?: string;
}

/** returns all vaults; filtering for JSON mode is done by the renderer */
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
