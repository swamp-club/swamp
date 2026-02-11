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
  renderVaultTypeSearch,
  toVaultTypeSearchItem,
  type VaultTypeSearchData,
  type VaultTypeSearchItem,
} from "../../presentation/output/vault_type_search_output.tsx";
import {
  renderVaultTypeDescribe,
} from "../../presentation/output/vault_type_describe_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { getVaultTypes } from "../../domain/vaults/vault_types.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Gets all vault types as VaultTypeSearchItem array.
 */
function getAllVaultTypes(): VaultTypeSearchItem[] {
  return getVaultTypes().map(toVaultTypeSearchItem);
}

/**
 * Filters vault types by a query string (case-insensitive match on type, name, or description).
 */
function filterVaultTypes(
  types: VaultTypeSearchItem[],
  query: string,
): VaultTypeSearchItem[] {
  if (!query) {
    return types;
  }
  const lowerQuery = query.toLowerCase();
  return types.filter(
    (t) =>
      t.type.toLowerCase().includes(lowerQuery) ||
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Displays the vault type describe output for a selected vault type.
 */
function displayVaultTypeDescribe(
  item: VaultTypeSearchItem,
  options: AnyOptions,
): void {
  const ctx = createContext(options as GlobalOptions, ["vault", "type-search"]);
  renderVaultTypeDescribe(item, ctx.outputMode);
}

export const vaultTypeSearchCommand = new Command()
  .name("search")
  .description("Search for vault types")
  .arguments("[query:string]")
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "vault",
      "type-search",
    ]);
    ctx.logger.debug`Searching vault types with query: ${query ?? "(none)"}`;

    const allTypes = getAllVaultTypes();

    if (ctx.outputMode === "json") {
      // Non-interactive: filter and output JSON
      const filteredTypes = filterVaultTypes(allTypes, query ?? "");
      const data: VaultTypeSearchData = {
        query: query ?? "",
        results: filteredTypes,
      };
      await renderVaultTypeSearch(data, ctx.outputMode);
    } else {
      // Interactive: show fuzzy search UI
      const data: VaultTypeSearchData = {
        query: query ?? "",
        results: allTypes,
      };

      const selected = await renderVaultTypeSearch(data, ctx.outputMode);

      if (selected) {
        ctx.logger.debug`Selected vault type: ${selected.type}`;
        // Display the vault type description
        displayVaultTypeDescribe(selected, options);
      } else {
        ctx.logger.debug`Search cancelled`;
      }
    }

    ctx.logger.debug("Vault type search command completed");
  });
