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
  ModelSearchData,
  ModelSearchEvent,
  ModelSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

/**
 * Filters models by a query string (case-insensitive match on name, type, or id).
 */
export function filterModels(
  models: ModelSearchItem[],
  query: string,
): ModelSearchItem[] {
  if (!query) return models;
  const lowerQuery = query.toLowerCase();
  return models.filter(
    (m) =>
      m.name.toLowerCase().includes(lowerQuery) ||
      m.type.toLowerCase().includes(lowerQuery) ||
      m.id.toLowerCase().includes(lowerQuery),
  );
}

export type ModelSearchRenderer = SearchRenderer<
  ModelSearchEvent,
  ModelSearchItem
>;

class JsonModelSearchRenderer implements ModelSearchRenderer {
  private _selected: ModelSearchItem | undefined;

  selectedItem(): ModelSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ModelSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterModels(e.data.results, e.data.query);
        // Auto-select when query matches exactly one model
        if (e.data.query && filtered.length === 1) {
          this._selected = filtered[0];
        } else {
          const output: ModelSearchData = {
            query: e.data.query,
            results: filtered,
          };
          console.log(JSON.stringify(output, null, 2));
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkModelSearchRenderer implements ModelSearchRenderer {
  private _selected: ModelSearchItem | undefined;

  selectedItem(): ModelSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ModelSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<ModelSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.name} ${item.type} ${item.id}`,
          (item, isSelected) => (
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
          ),
          "models",
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelSearchRenderer(
  mode: OutputMode,
): ModelSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonModelSearchRenderer();
    case "log":
      return new InkModelSearchRenderer();
  }
}
