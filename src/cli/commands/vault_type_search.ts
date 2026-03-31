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

import { Command } from "@cliffy/command";
import {
  consumeStream,
  createLibSwampContext,
  vaultTypeSearch,
  type VaultTypeSearchDeps,
} from "../../libswamp/mod.ts";
import { createVaultTypeSearchRenderer } from "../../presentation/renderers/vault_type_search.tsx";
import {
  createContext,
  type GlobalOptions,
  interactiveOutputMode,
} from "../context.ts";
import { getVaultTypes } from "../../domain/vaults/vault_types.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export async function vaultTypeSearchAction(
  options: AnyOptions,
  query?: string,
): Promise<void> {
  const ctx = createContext(options as GlobalOptions, [
    "vault",
    "type-search",
  ]);
  const effectiveMode = interactiveOutputMode(ctx);
  const libCtx = createLibSwampContext();
  ctx.logger.debug`Searching vault types with query: ${query ?? "(none)"}`;

  const deps: VaultTypeSearchDeps = {
    getVaultTypes: () => getVaultTypes(),
  };

  const renderer = createVaultTypeSearchRenderer(effectiveMode);
  await consumeStream(
    vaultTypeSearch(libCtx, deps, { query }),
    renderer.handlers(),
  );

  const selected = renderer.selectedItem();
  if (selected) {
    ctx.logger.debug`Selected vault type: ${selected.type}`;
    // Both log and json modes output the vault type as JSON
    console.log(JSON.stringify(selected, null, 2));
  } else {
    ctx.logger.debug`Search cancelled`;
  }

  ctx.logger.debug("Vault type search command completed");
}

export const vaultTypeSearchCommand = new Command()
  .name("search")
  .description("Search for vault types")
  .example("Browse vault types", "swamp vault type-search")
  .example("Search by keyword", "swamp vault type-search aws")
  .arguments("[query:string]")
  .action(vaultTypeSearchAction);
