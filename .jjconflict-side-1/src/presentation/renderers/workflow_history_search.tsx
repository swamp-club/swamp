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
  WorkflowHistorySearchData,
  WorkflowHistorySearchEvent,
  WorkflowHistorySearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

/**
 * Filters runs by a query string (case-insensitive match on workflowName, runId, or status).
 */
function filterRuns(
  items: WorkflowHistorySearchItem[],
  query: string,
): WorkflowHistorySearchItem[] {
  if (!query) return items;
  const lowerQuery = query.toLowerCase();
  return items.filter(
    (r) =>
      r.workflowName.toLowerCase().includes(lowerQuery) ||
      r.runId.toLowerCase().includes(lowerQuery) ||
      r.status.toLowerCase().includes(lowerQuery),
  );
}

export type WorkflowHistorySearchRenderer = SearchRenderer<
  WorkflowHistorySearchEvent,
  WorkflowHistorySearchItem
>;

class JsonWorkflowHistorySearchRenderer
  implements WorkflowHistorySearchRenderer {
  private _selected: WorkflowHistorySearchItem | undefined;

  selectedItem(): WorkflowHistorySearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<WorkflowHistorySearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterRuns(e.data.results, e.data.query);
        const output: WorkflowHistorySearchData = {
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

class InkWorkflowHistorySearchRenderer
  implements WorkflowHistorySearchRenderer {
  private _selected: WorkflowHistorySearchItem | undefined;

  selectedItem(): WorkflowHistorySearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<WorkflowHistorySearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<
          WorkflowHistorySearchItem
        >(
          e.data.results,
          e.data.query,
          (item) => {
            const tagStr = item.tags
              ? Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(
                " ",
              )
              : "";
            return `${item.workflowName} ${item.runId} ${item.status} ${tagStr}`
              .trim();
          },
          (item, isSelected) => {
            const statusColors: Record<string, string> = {
              pending: "gray",
              running: "yellow",
              succeeded: "green",
              failed: "red",
            };
            const statusColor = statusColors[item.status] ?? "white";
            const dateStr = item.startedAt
              ? new Date(item.startedAt).toLocaleString()
              : "not started";
            const durationStr = item.duration !== undefined
              ? `${(item.duration / 1000).toFixed(1)}s`
              : "";
            const tagStr = item.tags && Object.keys(item.tags).length > 0
              ? Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(
                ", ",
              )
              : "";

            return (
              <Box>
                <Text
                  color={isSelected ? "green" : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "\u25B6 " : "  "}
                  {item.workflowName}
                </Text>
                <Text></Text>
                <Text color={statusColor}>[{item.status}]</Text>
                <Text></Text>
                <Text dimColor>{dateStr}</Text>
                {durationStr && (
                  <>
                    <Text></Text>
                    <Text dimColor>{durationStr}</Text>
                  </>
                )}
                {tagStr && (
                  <>
                    <Text></Text>
                    <Text color="cyan">[{tagStr}]</Text>
                  </>
                )}
              </Box>
            );
          },
          "runs",
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createWorkflowHistorySearchRenderer(
  mode: OutputMode,
): WorkflowHistorySearchRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowHistorySearchRenderer();
    case "log":
      return new InkWorkflowHistorySearchRenderer();
  }
}
