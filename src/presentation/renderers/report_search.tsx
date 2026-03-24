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
  StoredReportSummary,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractiveSearch } from "./components/search_tui.tsx";

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

  constructor(query: string) {
    this.query = query;
  }

  selectedItem(): StoredReportSummary | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ReportSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        this._selected = await renderInteractiveSearch<StoredReportSummary>(
          e.data.reports,
          this.query,
          (item) =>
            `${item.reportName} ${item.modelName} ${item.reportScope} ${
              item.workflowName ?? ""
            } ${item.varySuffix ?? ""}`,
          (item, isSelected) => {
            const source = item.workflowName ?? item.modelName;
            return (
              <Box flexDirection="column">
                <Box gap={2}>
                  <Text
                    color={isSelected ? "green" : undefined}
                    bold={isSelected}
                  >
                    {isSelected ? "> " : "  "}
                    {item.reportName}
                  </Text>
                  <Text color="cyan">{source}</Text>
                  <Text dimColor>{item.reportScope}</Text>
                  {item.varySuffix && (
                    <Text color="yellow">[{item.varySuffix}]</Text>
                  )}
                  <Text dimColor>v{item.version}</Text>
                  <Text dimColor>{formatRelativeTime(item.createdAt)}</Text>
                </Box>
                {isSelected && (
                  <Box marginLeft={4}>
                    <Text dimColor>
                      type: {item.modelType} | id: {item.modelId}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          },
          "reports",
        );
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
): ReportSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonReportSearchRenderer(query);
    case "log":
      return new InkReportSearchRenderer(query);
  }
}
