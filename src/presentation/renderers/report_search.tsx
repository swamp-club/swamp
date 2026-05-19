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
  ReportSearchEvent,
  StoredReportDetail,
  StoredReportSummary,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";

/**
 * Formats an ISO date string as a relative time (e.g., "2d ago").
 */
function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

/**
 * Filters reports by a query string (case-insensitive match on name, model, scope, workflow, variant).
 */
function filterReports(
  reports: StoredReportSummary[],
  query: string,
): StoredReportSummary[] {
  if (!query) return reports;
  const lowerQuery = query.toLowerCase();
  return reports.filter(
    (r) =>
      r.reportName.toLowerCase().includes(lowerQuery) ||
      r.modelName.toLowerCase().includes(lowerQuery) ||
      r.reportScope.toLowerCase().includes(lowerQuery) ||
      (r.workflowName ?? "").toLowerCase().includes(lowerQuery) ||
      (r.varySuffix ?? "").toLowerCase().includes(lowerQuery),
  );
}

/**
 * Callback type for fetching report detail data for the preview pane.
 */
export type ReportPreviewFetcher = (
  item: StoredReportSummary,
) => Promise<StoredReportDetail>;

export type ReportSearchRenderer = SearchRenderer<
  ReportSearchEvent,
  StoredReportSummary
>;

class JsonReportSearchRenderer implements ReportSearchRenderer {
  private _selected: StoredReportSummary | undefined;
  private query: string;

  constructor(query: string) {
    this.query = query;
  }

  selectedItem(): StoredReportSummary | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ReportSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterReports(e.data.reports, this.query);
        // Auto-select when query matches exactly one report
        if (this.query && filtered.length === 1) {
          this._selected = filtered[0];
        } else {
          console.log(
            JSON.stringify(
              { query: this.query, results: filtered },
              null,
              2,
            ),
          );
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkReportSearchRenderer implements ReportSearchRenderer {
  private _selected: StoredReportSummary | undefined;
  private query: string;
  private readonly fetchPreview: ReportPreviewFetcher | undefined;

  constructor(query: string, fetchPreview?: ReportPreviewFetcher) {
    this.query = query;
    this.fetchPreview = fetchPreview;
  }

  selectedItem(): StoredReportSummary | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ReportSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<
          StoredReportSummary,
          StoredReportDetail
        >(
          e.data.reports,
          this.query,
          (item) =>
            `${item.reportName} ${item.modelName} ${item.reportScope} ${
              item.workflowName ?? ""
            } ${item.varySuffix ?? ""}`,
          renderReportResultLine,
          renderReportPreview,
          renderReportScrollback,
          "reports",
          {
            fetchPreview: this.fetchPreview,
            previewKeyFn: (item) =>
              `${item.reportName}-${item.modelId}-${item.version}`,
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

export function createReportSearchRenderer(
  mode: OutputMode,
  query: string,
  fetchPreview?: ReportPreviewFetcher,
): ReportSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonReportSearchRenderer(query);
    case "log":
      return new InkReportSearchRenderer(query, fetchPreview);
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

/** Single-line result for the results list. */
function renderReportResultLine(
  item: StoredReportSummary,
): React.ReactElement {
  const source = item.workflowName ?? item.modelName;
  return (
    <Text>
      {`${item.reportName} `}
      <Text color="cyan">{source}</Text>
      {` ${item.reportScope}`}
      {item.varySuffix
        ? <Text color="yellow">{` [${item.varySuffix}]`}</Text>
        : null}
      <Text dimColor>
        {` v${item.version} ${formatRelativeTime(item.createdAt)}`}
      </Text>
    </Text>
  );
}

/** Preview content for a report. */
function renderReportPreview(
  item: StoredReportSummary,
  detail: StoredReportDetail | undefined,
  width: number,
  _height: number,
): React.ReactElement {
  const innerWidth = Math.max(10, width - 1);
  if (!detail) {
    // Immediate content from the search item
    const lines: React.ReactElement[] = [
      <Text key="name" bold wrap="truncate-end">{item.reportName}</Text>,
      <Text key="scope" dimColor wrap="truncate-end">
        scope: {item.reportScope}
      </Text>,
      <Text key="model" dimColor wrap="truncate-end">
        model: {item.modelName}
      </Text>,
      <Text key="type" dimColor wrap="truncate-end">
        type: {item.modelType}
      </Text>,
    ];
    if (item.workflowName) {
      lines.push(
        <Text key="wf" dimColor wrap="truncate-end">
          workflow: {item.workflowName}
        </Text>,
      );
    }
    lines.push(
      <Text key="version" dimColor wrap="truncate-end">
        version: {item.version}
      </Text>,
    );
    lines.push(
      <Text key="created" dimColor wrap="truncate-end">
        created: {item.createdAt}
      </Text>,
    );
    if (item.varySuffix) {
      lines.push(
        <Text key="variant" dimColor wrap="truncate-end">
          variant: {item.varySuffix}
        </Text>,
      );
    }
    return (
      <Box flexDirection="column" marginLeft={1} width={innerWidth}>
        {lines}
      </Box>
    );
  }

  // Combine header + rendered markdown into a single string to avoid
  // Ink layout overlap with multiple ANSI-formatted <Text> blocks.
  const header =
    `${detail.reportName}\nscope: ${detail.reportScope} | model: ${detail.modelName} | v${detail.version}\n`;
  const rendered = renderMarkdownToTerminal(detail.markdown);
  return (
    <Box flexDirection="column" marginLeft={1} width={innerWidth}>
      <Text wrap="truncate-end">{header + rendered}</Text>
    </Box>
  );
}

/** Plain-text scrollback output for a selected report. */
function renderReportScrollback(
  item: StoredReportSummary,
  detail: StoredReportDetail | undefined,
): string {
  if (!detail) {
    const lines: string[] = [
      item.reportName,
      `scope: ${item.reportScope}`,
      `model: ${item.modelName} (${item.modelType})`,
    ];

    if (item.workflowName) {
      lines.push(`workflow: ${item.workflowName}`);
    }

    lines.push(`version: ${item.version}`);
    lines.push(`created: ${item.createdAt}`);

    if (item.varySuffix) {
      lines.push(`variant: ${item.varySuffix}`);
    }

    return lines.join("\n");
  }

  // With detail, show the rendered markdown
  const lines: string[] = [
    `${detail.reportName} (${detail.reportScope}) v${detail.version}`,
    "",
    renderMarkdownToTerminal(detail.markdown),
  ];

  return lines.join("\n");
}
