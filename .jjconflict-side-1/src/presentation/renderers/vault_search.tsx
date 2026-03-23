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
  VaultSearchData,
  VaultSearchEvent,
  VaultSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

/**
 * Filters vaults by a query string (case-insensitive match on name, type, or id).
 */
function filterVaults(
  vaults: VaultSearchItem[],
  query: string,
): VaultSearchItem[] {
  if (!query) return vaults;
  const lowerQuery = query.toLowerCase();
  return vaults.filter(
    (v) =>
      v.name.toLowerCase().includes(lowerQuery) ||
      v.type.toLowerCase().includes(lowerQuery) ||
      v.id.toLowerCase().includes(lowerQuery),
  );
}

export type VaultSearchRenderer = SearchRenderer<
  VaultSearchEvent,
  VaultSearchItem
>;

class JsonVaultSearchRenderer implements VaultSearchRenderer {
  private _selected: VaultSearchItem | undefined;

  selectedItem(): VaultSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<VaultSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterVaults(e.data.results, e.data.query);
        const output: VaultSearchData = {
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

class InkVaultSearchRenderer implements VaultSearchRenderer {
  private _selected: VaultSearchItem | undefined;

  selectedItem(): VaultSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<VaultSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<VaultSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.name} ${item.type} ${item.id}`,
          (item, isSelected) => (
            <Box flexDirection="column">
              <Box>
                <Text
                  color={isSelected ? "green" : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "> " : "  "}
                  {item.name}
                </Text>
                <Text dimColor>({item.type})</Text>
              </Box>
              {isSelected && (
                <Box marginLeft={4}>
                  <Text dimColor>ID: {item.id}</Text>
                </Box>
              )}
            </Box>
          ),
          "vaults",
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createVaultSearchRenderer(
  mode: OutputMode,
): VaultSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonVaultSearchRenderer();
    case "log":
      return new InkVaultSearchRenderer();
  }
}
