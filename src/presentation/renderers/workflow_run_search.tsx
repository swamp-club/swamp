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
  WorkflowRunSearchData,
  WorkflowRunSearchEvent,
  WorkflowRunSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

export type WorkflowRunSearchRenderer = SearchRenderer<
  WorkflowRunSearchEvent,
  WorkflowRunSearchItem
>;

class JsonWorkflowRunSearchRenderer implements WorkflowRunSearchRenderer {
  private _selected: WorkflowRunSearchItem | undefined;

  selectedItem(): WorkflowRunSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<WorkflowRunSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const output: WorkflowRunSearchData = {
          query: e.data.query,
          results: e.data.results,
        };
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkWorkflowRunSearchRenderer implements WorkflowRunSearchRenderer {
  private _selected: WorkflowRunSearchItem | undefined;

  selectedItem(): WorkflowRunSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<WorkflowRunSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<WorkflowRunSearchItem>(
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

export function createWorkflowRunSearchRenderer(
  mode: OutputMode,
): WorkflowRunSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowRunSearchRenderer();
    case "log":
      return new InkWorkflowRunSearchRenderer();
  }
}
