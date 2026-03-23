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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type {
  EventHandlers,
  VaultTypeSearchData,
  VaultTypeSearchEvent,
  VaultTypeSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

/**
 * Filters vault types by a query string (case-insensitive match on type, name,
 * or description).
 */
function filterVaultTypes(
  types: VaultTypeSearchItem[],
  query: string,
): VaultTypeSearchItem[] {
  if (!query) return types;
  const lowerQuery = query.toLowerCase();
  return types.filter(
    (t) =>
      t.type.toLowerCase().includes(lowerQuery) ||
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery),
  );
}

export type VaultTypeSearchRenderer = SearchRenderer<
  VaultTypeSearchEvent,
  VaultTypeSearchItem
>;

class JsonVaultTypeSearchRenderer implements VaultTypeSearchRenderer {
  private _selected: VaultTypeSearchItem | undefined;

  selectedItem(): VaultTypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<VaultTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterVaultTypes(e.data.results, e.data.query);
        const output: VaultTypeSearchData = {
          query: e.data.query,
          results: filtered,
        };
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkVaultTypeSearchRenderer implements VaultTypeSearchRenderer {
  private _selected: VaultTypeSearchItem | undefined;

  selectedItem(): VaultTypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<VaultTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<VaultTypeSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.type} ${item.name} ${item.description}`,
          (item, isSelected) => (
            <Box flexDirection="column">
              <Box>
                <Text
                  color={isSelected ? "green" : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "> " : "  "}
                  {item.type}
                </Text>
                <Text dimColor>- {item.name}</Text>
              </Box>
              {isSelected && (
                <Box marginLeft={4}>
                  <Text dimColor>{item.description}</Text>
                </Box>
              )}
            </Box>
          ),
          "vault types",
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createVaultTypeSearchRenderer(
  mode: OutputMode,
): VaultTypeSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonVaultTypeSearchRenderer();
    case "log":
      return new InkVaultTypeSearchRenderer();
  }
}
