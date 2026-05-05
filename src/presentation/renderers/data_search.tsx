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
import { renderInteractivePicker } from "./components/search_picker.tsx";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";

/**
 * Detail data fetched for the preview pane. Contains the raw content string
 * (or a description for binary data).
 */
export interface DataPreviewDetail {
  content: string | undefined;
  contentPath: string;
}

/**
 * Callback type for fetching data content for the preview pane.
 */
export type DataPreviewFetcher = (
  item: DataSearchItem,
) => Promise<DataPreviewDetail>;

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
  private readonly fetchPreview: DataPreviewFetcher | undefined;

  constructor(fetchPreview?: DataPreviewFetcher) {
    this.fetchPreview = fetchPreview;
  }

  selectedItem(): DataSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<DataSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<
          DataSearchItem,
          DataPreviewDetail
        >(
          e.data.results,
          e.data.query,
          (item) =>
            `${item.name} ${item.modelName} ${item.modelType} ${item.type} ${
              item.workflowTag ?? ""
            } ${item.jobTag ?? ""} ${item.stepTag ?? ""} ${
              Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(" ")
            }`,
          renderDataResultLine,
          renderDataPreview,
          renderDataScrollback,
          "data",
          {
            fetchPreview: this.fetchPreview,
            previewKeyFn: (item) => `${item.id}:${item.version}`,
          },
        );
        if (result) {
          this._selected = result.item;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDataSearchRenderer(
  mode: OutputMode,
  fetchPreview?: DataPreviewFetcher,
): DataSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonDataSearchRenderer();
    case "log":
      return new InkDataSearchRenderer(fetchPreview);
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

/**
 * Builds the metadata section as markdown (rendered separately from content
 * to avoid markdown-in-markdown nesting issues).
 */
function buildMetadataMarkdown(item: DataSearchItem): string {
  const tagEntries = Object.entries(item.tags);
  const lines: string[] = [
    `**${item.name}** v${item.version}`,
    "",
    `**Model:** ${item.modelName} (${item.modelType})`,
    `**Content Type:** ${item.contentType}`,
    `**Size:** ${formatSize(item.size)}`,
    `**Lifetime:** ${item.lifetime}`,
    `**Type:** ${item.type}`,
    `**Owner:** ${item.ownerType} ${item.ownerRef}`,
  ];

  if (item.workflowTag) lines.push(`**Workflow:** ${item.workflowTag}`);
  if (item.jobTag) lines.push(`**Job:** ${item.jobTag}`);
  if (item.stepTag) lines.push(`**Step:** ${item.stepTag}`);

  if (tagEntries.length > 0) {
    lines.push(
      `**Tags:** ${tagEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
  }

  lines.push(`**Created:** ${formatRelativeTime(item.createdAt)}`);

  return lines.join("\n");
}

/**
 * Renders content based on its type. Markdown content is rendered as markdown.
 * JSON/YAML get syntax-highlighted code blocks. Other text is shown plain.
 */
function renderContentString(
  content: string,
  contentType: string,
): string {
  if (contentType === "text/markdown") {
    // Content IS markdown — render it directly
    return renderMarkdownToTerminal(content);
  }

  if (contentType === "application/json") {
    return renderMarkdownToTerminal("```json\n" + content + "\n```");
  }

  if (
    contentType === "application/yaml" || contentType === "application/x-yaml"
  ) {
    return renderMarkdownToTerminal("```yaml\n" + content + "\n```");
  }

  // Plain text or unknown — show as-is
  return content;
}

function renderDataResultLine(item: DataSearchItem): React.ReactElement {
  return (
    <Text>
      {`${item.name} `}
      <Text dimColor>
        {`${item.contentType} ${formatSize(item.size)} ${
          formatRelativeTime(item.createdAt)
        }`}
      </Text>
    </Text>
  );
}

function renderDataPreview(
  item: DataSearchItem,
  detail: DataPreviewDetail | undefined,
  _width: number,
  _height: number,
): React.ReactElement {
  // Combine metadata + content into a single string to avoid Ink layout
  // issues with multiple <Text> blocks containing ANSI-formatted content.
  const parts: string[] = [
    renderMarkdownToTerminal(buildMetadataMarkdown(item)),
  ];

  if (detail && detail.content) {
    parts.push(renderContentString(detail.content, item.contentType));
  } else if (detail && !detail.content) {
    parts.push(`(binary data at ${detail.contentPath})`);
  }

  return (
    <Box paddingLeft={1}>
      <Text>{parts.join("\n")}</Text>
    </Box>
  );
}

function renderDataScrollback(
  item: DataSearchItem,
  detail: DataPreviewDetail | undefined,
): string {
  const metadata = renderMarkdownToTerminal(buildMetadataMarkdown(item));

  if (detail?.content) {
    const content = renderContentString(detail.content, item.contentType);
    return metadata + "\n" + content;
  }

  return metadata;
}
