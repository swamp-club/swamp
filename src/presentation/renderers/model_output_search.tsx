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
  ModelOutputSearchData,
  ModelOutputSearchEvent,
  ModelOutputSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

/**
 * Filters outputs by a query string.
 */
function filterOutputs(
  outputs: ModelOutputSearchItem[],
  query: string,
): ModelOutputSearchItem[] {
  if (!query) return outputs;
  const lowerQuery = query.toLowerCase();
  return outputs.filter(
    (o) =>
      (o.modelName?.toLowerCase().includes(lowerQuery) ?? false) ||
      o.type.toLowerCase().includes(lowerQuery) ||
      o.methodName.toLowerCase().includes(lowerQuery) ||
      o.status.toLowerCase().includes(lowerQuery) ||
      o.id.toLowerCase().includes(lowerQuery) ||
      o.definitionId.toLowerCase().includes(lowerQuery),
  );
}

function getStatusColor(
  status: string,
): "green" | "yellow" | "red" | "blue" | undefined {
  switch (status) {
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "running":
      return "yellow";
    case "pending":
      return "blue";
    default:
      return undefined;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

export type ModelOutputSearchRenderer = SearchRenderer<
  ModelOutputSearchEvent,
  ModelOutputSearchItem
>;

class JsonModelOutputSearchRenderer implements ModelOutputSearchRenderer {
  private _selected: ModelOutputSearchItem | undefined;

  selectedItem(): ModelOutputSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ModelOutputSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterOutputs(e.data.results, e.data.query);
        const output: ModelOutputSearchData = {
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

class InkModelOutputSearchRenderer implements ModelOutputSearchRenderer {
  private _selected: ModelOutputSearchItem | undefined;

  selectedItem(): ModelOutputSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ModelOutputSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<ModelOutputSearchItem>(
          e.data.results,
          e.data.query,
          (item) =>
            `${
              item.modelName ?? item.definitionId
            } ${item.type} ${item.methodName} ${item.status} ${item.id}`,
          (item, isSelected) => (
            <Box>
              <Text
                color={isSelected ? "green" : undefined}
                bold={isSelected}
              >
                {isSelected ? "> " : "  "}
                {item.modelName ?? item.definitionId.slice(0, 8)}
              </Text>
              <Text color="cyan">{` ${item.methodName}`}</Text>
              <Text color={getStatusColor(item.status)}>
                {` [${item.status}]`}
              </Text>
              {item.durationMs !== undefined && (
                <Text dimColor>
                  {` (${formatDuration(item.durationMs)})`}
                </Text>
              )}
            </Box>
          ),
          "outputs",
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelOutputSearchRenderer(
  mode: OutputMode,
): ModelOutputSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonModelOutputSearchRenderer();
    case "log":
      return new InkModelOutputSearchRenderer();
  }
}
