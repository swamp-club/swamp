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
  TypeSearchData,
  TypeSearchEvent,
  TypeSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

/**
 * Filters types by a query string (case-insensitive match on raw or normalized).
 */
function filterTypes(
  types: TypeSearchItem[],
  query: string,
): TypeSearchItem[] {
  if (!query) return types;
  const lowerQuery = query.toLowerCase();
  return types.filter(
    (t) =>
      t.raw.toLowerCase().includes(lowerQuery) ||
      t.normalized.toLowerCase().includes(lowerQuery),
  );
}

export type TypeSearchRenderer = SearchRenderer<
  TypeSearchEvent,
  TypeSearchItem
>;

class JsonTypeSearchRenderer implements TypeSearchRenderer {
  private _selected: TypeSearchItem | undefined;

  selectedItem(): TypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<TypeSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterTypes(e.data.results, e.data.query);
        const output: TypeSearchData = {
          query: e.data.query,
          results: filtered,
        };
        if (filtered.length === 0 && e.data.query) {
          output.hint =
            `No local types matched. Try: swamp extension search ${e.data.query}`;
        }
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkTypeSearchRenderer implements TypeSearchRenderer {
  private _selected: TypeSearchItem | undefined;

  selectedItem(): TypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<TypeSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<TypeSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.raw} ${item.normalized}`,
          (item, isSelected) => (
            <Box>
              <Text
                color={isSelected ? "green" : undefined}
                bold={isSelected}
              >
                {isSelected ? "\u25B6 " : "  "}
                {item.normalized}
              </Text>
              {item.raw !== item.normalized && (
                <Text dimColor>({item.raw})</Text>
              )}
            </Box>
          ),
          "types",
          (query) => (
            <Text dimColor>
              Tip: run `swamp extension search{" "}
              {query}` to check community extensions
            </Text>
          ),
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createTypeSearchRenderer(
  mode: OutputMode,
): TypeSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonTypeSearchRenderer();
    case "log":
      return new InkTypeSearchRenderer();
  }
}
