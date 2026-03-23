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
  DataSearchEvent,
  DataSearchItem,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

/**
 * Formats a byte count into a human-readable size string.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Formats an ISO date string as a relative time (e.g., "2s ago", "5m ago").
 */
function formatRelativeTime(isoStr: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Returns the color for a lifetime label.
 */
function getLifetimeColor(
  lifetime: string,
): string | undefined {
  if (lifetime === "infinite") return "green";
  if (lifetime === "ephemeral") return "yellow";
  return undefined;
}

export type DataSearchRenderer = SearchRenderer<
  DataSearchEvent,
  DataSearchItem
>;

class JsonDataSearchRenderer implements DataSearchRenderer {
  private _selected: DataSearchItem | undefined;

  selectedItem(): DataSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<DataSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkDataSearchRenderer implements DataSearchRenderer {
  private _selected: DataSearchItem | undefined;

  selectedItem(): DataSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<DataSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<DataSearchItem>(
          e.data.results,
          e.data.query,
          (item) =>
            `${item.name} ${item.modelName} ${item.modelType} ${item.type} ${
              item.workflowTag ?? ""
            } ${item.stepTag ?? ""} ${
              Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(" ")
            }`,
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
                <Text dimColor>v{item.version}</Text>
                <Text>{item.modelName}</Text>
                <Text dimColor>{item.contentType}</Text>
                <Text color={getLifetimeColor(item.lifetime)}>
                  {` [${item.lifetime}]`}
                </Text>
                <Text dimColor>{formatSize(item.size)}</Text>
                <Text dimColor>{formatRelativeTime(item.createdAt)}</Text>
              </Box>
              {isSelected && (
                <Box marginLeft={4} flexDirection="column">
                  <Text dimColor>type: {item.type}</Text>
                  <Text dimColor>ownerType: {item.ownerType}</Text>
                  <Text dimColor>ownerRef: {item.ownerRef}</Text>
                  {item.workflowTag && (
                    <Text dimColor>workflow: {item.workflowTag}</Text>
                  )}
                  {item.stepTag && <Text dimColor>step: {item.stepTag}</Text>}
                </Box>
              )}
            </Box>
          ),
          "data",
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDataSearchRenderer(
  mode: OutputMode,
): DataSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonDataSearchRenderer();
    case "log":
      return new InkDataSearchRenderer();
  }
}
