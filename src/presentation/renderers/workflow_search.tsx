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
import { renderInteractivePicker } from "./components/search_picker.tsx";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";

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

/**
 * Detail data for the preview pane — the raw YAML file content.
 */
export interface WorkflowPreviewDetail {
  yaml: string;
  name: string;
}

/**
 * Callback type for fetching workflow YAML for the preview pane.
 */
export type WorkflowPreviewFetcher = (
  item: WorkflowSearchItem,
) => Promise<WorkflowPreviewDetail>;

export interface WorkflowSearchRendererResult {
  item: WorkflowSearchItem;
  action?: string;
}

export interface WorkflowSearchRenderer
  extends SearchRenderer<WorkflowSearchEvent, WorkflowSearchItem> {
  selectedAction(): string | undefined;
}

class JsonWorkflowSearchRenderer implements WorkflowSearchRenderer {
  private _selected: WorkflowSearchItem | undefined;

  selectedItem(): WorkflowSearchItem | undefined {
    return this._selected;
  }

  selectedAction(): string | undefined {
    return undefined;
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
  private _action: string | undefined;
  private readonly fetchPreview: WorkflowPreviewFetcher | undefined;

  constructor(fetchPreview?: WorkflowPreviewFetcher) {
    this.fetchPreview = fetchPreview;
  }

  selectedItem(): WorkflowSearchItem | undefined {
    return this._selected;
  }

  selectedAction(): string | undefined {
    return this._action;
  }

  handlers(): EventHandlers<WorkflowSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<
          WorkflowSearchItem,
          WorkflowPreviewDetail
        >(
          e.data.results,
          e.data.query,
          (item) => `${item.name} ${item.id} ${item.description ?? ""}`,
          renderWorkflowResultLine,
          renderWorkflowPreview,
          renderWorkflowScrollback,
          "workflows",
          {
            fetchPreview: this.fetchPreview,
            previewKeyFn: (item) => item.id,
            actions: [
              { key: "r", label: "Run", action: "run" },
            ],
          },
        );
        if (result) {
          this._selected = result.item;
          this._action = result.action;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createWorkflowSearchRenderer(
  mode: OutputMode,
  fetchPreview?: WorkflowPreviewFetcher,
): WorkflowSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowSearchRenderer();
    case "log":
      return new InkWorkflowSearchRenderer(fetchPreview);
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

/** Single-line result for the results list. */
function renderWorkflowResultLine(
  item: WorkflowSearchItem,
): React.ReactElement {
  const desc = item.description ? ` ${item.description}` : "";
  return (
    <Text>
      {`${item.name} `}
      <Text dimColor>{`(${item.jobCount} jobs)${desc}`}</Text>
    </Text>
  );
}

/** Preview content for a workflow — shows YAML when available. */
function renderWorkflowPreview(
  item: WorkflowSearchItem,
  detail: WorkflowPreviewDetail | undefined,
  width: number,
  _height: number,
): React.ReactElement {
  const innerWidth = Math.max(10, width - 1);
  if (!detail) {
    // Immediate content from the search item
    const lines: React.ReactElement[] = [
      <Text key="name" bold wrap="truncate-end">{item.name}</Text>,
    ];
    if (item.description) {
      lines.push(
        <Text key="desc" wrap="truncate-end">{item.description}</Text>,
      );
    }
    lines.push(
      <Text key="jobs" dimColor wrap="truncate-end">
        {`${item.jobCount} jobs`}
      </Text>,
    );
    return (
      <Box flexDirection="column" marginLeft={1} width={innerWidth}>
        {lines}
      </Box>
    );
  }

  // Show YAML with syntax highlighting
  const rendered = renderMarkdownToTerminal(
    `**${detail.name}**\n\n\`\`\`yaml\n${detail.yaml}\n\`\`\``,
  );
  return (
    <Box flexDirection="column" marginLeft={1} width={innerWidth}>
      <Text wrap="truncate-end">{rendered}</Text>
    </Box>
  );
}

/** Plain-text scrollback output — rendered YAML. */
function renderWorkflowScrollback(
  item: WorkflowSearchItem,
  detail: WorkflowPreviewDetail | undefined,
): string {
  if (!detail) {
    return `${item.name} (${item.jobCount} jobs)`;
  }

  return renderMarkdownToTerminal(
    `**${detail.name}**\n\n\`\`\`yaml\n${detail.yaml}\n\`\`\``,
  );
}
