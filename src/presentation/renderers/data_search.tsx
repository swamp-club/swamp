// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
 * Builds the metadata section as markdown for scrollback (plain-text output).
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
 * Builds metadata as React elements for the preview pane. Uses Ink's own
 * <Text> styling instead of ANSI from renderMarkdownToTerminal — Ink can
 * measure its own elements correctly for truncation.
 */
function buildMetadataElements(item: DataSearchItem): React.ReactElement[] {
  const tagEntries = Object.entries(item.tags);
  const elements: React.ReactElement[] = [
    <Text key="name" bold wrap="truncate-end">
      {item.name} <Text dimColor>v{item.version}</Text>
    </Text>,
    <Text key="spacer" />,
    <Text key="model" dimColor wrap="truncate-end">
      Model: {item.modelName} ({item.modelType})
    </Text>,
    <Text key="ct" dimColor wrap="truncate-end">
      Content Type: {item.contentType}
    </Text>,
    <Text key="size" dimColor wrap="truncate-end">
      Size: {formatSize(item.size)}
    </Text>,
    <Text key="lifetime" dimColor wrap="truncate-end">
      Lifetime: {item.lifetime}
    </Text>,
    <Text key="type" dimColor wrap="truncate-end">Type: {item.type}</Text>,
    <Text key="owner" dimColor wrap="truncate-end">
      Owner: {item.ownerType} {item.ownerRef}
    </Text>,
  ];

  if (item.workflowTag) {
    elements.push(
      <Text key="wf" dimColor wrap="truncate-end">
        Workflow: {item.workflowTag}
      </Text>,
    );
  }
  if (item.jobTag) {
    elements.push(
      <Text key="job" dimColor wrap="truncate-end">
        Job: {item.jobTag}
      </Text>,
    );
  }
  if (item.stepTag) {
    elements.push(
      <Text key="step" dimColor wrap="truncate-end">
        Step: {item.stepTag}
      </Text>,
    );
  }

  if (tagEntries.length > 0) {
    elements.push(
      <Text key="tags" dimColor wrap="truncate-end">
        Tags: {tagEntries.map(([k, v]) => `${k}=${v}`).join(", ")}
      </Text>,
    );
  }

  elements.push(
    <Text key="created" dimColor wrap="truncate-end">
      Created: {formatRelativeTime(item.createdAt)}
    </Text>,
  );

  return elements;
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
  width: number,
  _height: number,
): React.ReactElement {
  const innerWidth = Math.max(10, width - 1);
  const elements = buildMetadataElements(item);

  if (detail && detail.content) {
    elements.push(<Text key="content-spacer" />);
    const contentLines = detail.content.split("\n");
    for (let i = 0; i < contentLines.length; i++) {
      elements.push(
        <Text key={`c-${i}`} wrap="truncate-end">{contentLines[i]}</Text>,
      );
    }
  } else if (detail && !detail.content) {
    elements.push(
      <Text key="binary" dimColor wrap="truncate-end">
        (binary data at {detail.contentPath})
      </Text>,
    );
  }

  return (
    <Box flexDirection="column" marginLeft={1} width={innerWidth}>
      {elements}
    </Box>
  );
}

function renderDataScrollback(
  item: DataSearchItem,
  detail: DataPreviewDetail | undefined,
): string {
  const metadata = renderMarkdownToTerminal(buildMetadataMarkdown(item));

  if (detail?.content) {
    return metadata + "\n" + detail.content;
  }

  return metadata;
}
