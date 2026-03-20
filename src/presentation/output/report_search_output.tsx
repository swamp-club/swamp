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
import React, { useCallback, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";
import { Fzf, type FzfResultItem } from "fzf";
import { suppressInkTtyErrors } from "./ink_lifecycle.ts";
import { useScrollableList } from "./hooks/mod.ts";
import type { StoredReportSummary } from "../../libswamp/mod.ts";

/**
 * Re-export for convenience.
 */
export type ReportSearchItem = StoredReportSummary;

/**
 * Data structure for report search results.
 */
export interface ReportSearchData {
  query: string;
  results: ReportSearchItem[];
}

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
 * Renders report search in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected report in interactive mode, or undefined in JSON mode
 */
export async function renderReportSearch(
  data: ReportSearchData,
  mode: OutputMode,
): Promise<ReportSearchItem | undefined> {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return undefined;
  } else {
    return await renderInteractiveReportSearch(data);
  }
}

/**
 * Renders an interactive report search UI.
 *
 * @param data - The initial search data (reports to search and optional initial query)
 * @returns A promise that resolves with the selected report, or undefined if cancelled
 */
function renderInteractiveReportSearch(
  data: ReportSearchData,
): Promise<ReportSearchItem | undefined> {
  return new Promise<ReportSearchItem | undefined>((resolve) => {
    const cleanupTty = suppressInkTtyErrors();
    const { waitUntilExit } = render(
      <ReportSearchUI
        reports={data.results}
        initialQuery={data.query}
        onSelect={(item) => {
          cleanupTty();
          resolve(item);
        }}
        onCancel={() => {
          cleanupTty();
          resolve(undefined);
        }}
      />,
    );
    waitUntilExit().catch(() => {});
  });
}

interface ReportSearchUIProps {
  reports: ReportSearchItem[];
  initialQuery: string;
  onSelect: (item: ReportSearchItem) => void;
  onCancel: () => void;
}

/**
 * Interactive report search component using fzf for fuzzy matching.
 */
export function ReportSearchUI(
  props: ReportSearchUIProps,
): React.ReactElement {
  const { reports, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);

  // Create fzf instance for fuzzy searching
  const fzf = useMemo(
    () =>
      new Fzf(reports, {
        selector: (item) =>
          `${item.reportName} ${item.modelName} ${item.reportScope} ${
            item.workflowName ?? ""
          } ${item.varySuffix ?? ""}`,
      }),
    [reports],
  );

  // Get filtered results
  const results: FzfResultItem<ReportSearchItem>[] = fzf.find(query);

  // Use shared scrollable list hook
  const {
    selectedIndex,
    setSelectedIndex,
    visibleItems: visibleResults,
    scrollMetrics,
  } = useScrollableList(results, 10, [query]);

  const handleSelect = useCallback(() => {
    if (results.length > 0 && selectedIndex < results.length) {
      const selected = results[selectedIndex].item;
      exit();
      onSelect(selected);
    }
  }, [results, selectedIndex, exit, onSelect]);

  const handleCancel = useCallback(() => {
    exit();
    onCancel();
  }, [exit, onCancel]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      handleCancel();
      return;
    }

    if (key.return) {
      handleSelect();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(results.length - 1, i + 1));
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }

    // Handle regular character input
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Search input */}
      <Box>
        <Text color="cyan" bold>
          Search:{" "}
        </Text>
        <Text>{query}</Text>
        <Text color="gray">|</Text>
      </Box>

      {/* Results count */}
      <Box marginTop={1}>
        <Text dimColor>
          {results.length} / {reports.length} reports
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <ReportSearchResultItem
            key={`${result.item.modelId}-${result.item.dataName}-${result.item.version}`}
            item={result.item}
            isSelected={index + scrollMetrics.moreAboveCount === selectedIndex}
          />
        ))}
        {scrollMetrics.hasMoreBelow && (
          <Text dimColor>
            ... {scrollMetrics.moreBelowCount} more below
          </Text>
        )}
        {results.length === 0 && (
          <Text color="yellow">No matching reports found</Text>
        )}
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>
          Up/Down: Navigate | Enter: Select | Esc: Cancel
        </Text>
      </Box>
    </Box>
  );
}

interface ReportSearchResultItemProps {
  item: ReportSearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single report search result item.
 */
function ReportSearchResultItem(
  props: ReportSearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;
  const source = item.workflowName ?? item.modelName;

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text color={isSelected ? "green" : undefined} bold={isSelected}>
          {isSelected ? "> " : "  "}
          {item.reportName}
        </Text>
        <Text color="cyan">{source}</Text>
        <Text dimColor>{item.reportScope}</Text>
        {item.varySuffix && <Text color="yellow">[{item.varySuffix}]</Text>}
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
}
