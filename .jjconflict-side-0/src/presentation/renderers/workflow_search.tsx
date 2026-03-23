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
  WorkflowSearchData,
  WorkflowSearchEvent,
  WorkflowSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

/**
 * Filters workflows by a query string (case-insensitive match on name, id, or description).
 */
function filterWorkflows(
  items: WorkflowSearchItem[],
  query: string,
): WorkflowSearchItem[] {
  if (!query) return items;
  const lowerQuery = query.toLowerCase();
  return items.filter(
    (w) =>
      w.name.toLowerCase().includes(lowerQuery) ||
      w.id.toLowerCase().includes(lowerQuery) ||
      (w.description ?? "").toLowerCase().includes(lowerQuery),
  );
}

export type WorkflowSearchRenderer = SearchRenderer<
  WorkflowSearchEvent,
  WorkflowSearchItem
>;

class JsonWorkflowSearchRenderer implements WorkflowSearchRenderer {
  private _selected: WorkflowSearchItem | undefined;

  selectedItem(): WorkflowSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<WorkflowSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterWorkflows(e.data.results, e.data.query);
        // Auto-select when query matches exactly one workflow
        if (e.data.query && filtered.length === 1) {
          this._selected = filtered[0];
          return;
        }
        const output: WorkflowSearchData = {
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

class InkWorkflowSearchRenderer implements WorkflowSearchRenderer {
  private _selected: WorkflowSearchItem | undefined;

  selectedItem(): WorkflowSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<WorkflowSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<WorkflowSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.name} ${item.id} ${item.description ?? ""}`,
          (item, isSelected) => (
            <Box>
              <Text
                color={isSelected ? "green" : undefined}
                bold={isSelected}
              >
                {isSelected ? "\u25B6 " : "  "}
                {item.name}
              </Text>
              <Text dimColor>({item.jobCount} jobs)</Text>
              {item.description && (
                <>
                  <Text></Text>
                  <Text dimColor>{item.description}</Text>
                </>
              )}
            </Box>
          ),
          "workflows",
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createWorkflowSearchRenderer(
  mode: OutputMode,
): WorkflowSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowSearchRenderer();
    case "log":
      return new InkWorkflowSearchRenderer();
  }
}
