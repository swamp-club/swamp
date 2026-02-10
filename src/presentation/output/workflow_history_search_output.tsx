// deno-lint-ignore verbatim-module-syntax
import React, { useCallback, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";
import { Fzf, type FzfResultItem } from "fzf";
import { useScrollableList } from "./hooks/mod.ts";

/**
 * Represents a single workflow run search result item.
 */
export interface WorkflowHistorySearchItem {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: "pending" | "running" | "succeeded" | "failed";
  startedAt?: string;
  completedAt?: string;
  duration?: number;
}

/**
 * Data structure for workflow history search results.
 */
export interface WorkflowHistorySearchData {
  query: string;
  results: WorkflowHistorySearchItem[];
}

/**
 * Renders workflow history search results in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected run in interactive mode, or undefined in JSON mode
 */
export async function renderWorkflowHistorySearch(
  data: WorkflowHistorySearchData,
  mode: OutputMode,
): Promise<WorkflowHistorySearchItem | undefined> {
  if (mode === "json") {
    renderJsonWorkflowHistorySearch(data);
    return undefined;
  } else {
    return await renderInteractiveWorkflowHistorySearch(data);
  }
}

/**
 * Renders workflow history search results as JSON.
 */
function renderJsonWorkflowHistorySearch(
  data: WorkflowHistorySearchData,
): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Renders an interactive workflow history search UI.
 *
 * @param data - The initial search data (runs to search and optional initial query)
 * @returns A promise that resolves with the selected run, or undefined if cancelled
 */
export function renderInteractiveWorkflowHistorySearch(
  data: WorkflowHistorySearchData,
): Promise<WorkflowHistorySearchItem | undefined> {
  return new Promise<WorkflowHistorySearchItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <WorkflowHistorySearchUI
        runs={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface WorkflowHistorySearchUIProps {
  runs: WorkflowHistorySearchItem[];
  initialQuery: string;
  onSelect: (item: WorkflowHistorySearchItem) => void;
  onCancel: () => void;
}

/**
 * Interactive workflow history search component using fzf for fuzzy matching.
 */
export function WorkflowHistorySearchUI(
  props: WorkflowHistorySearchUIProps,
): React.ReactElement {
  const { runs, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);

  // Create fzf instance for fuzzy searching (memoized to avoid recreation on every render)
  const fzf = useMemo(
    () =>
      new Fzf(runs, {
        selector: (item) =>
          `${item.workflowName} ${item.runId} ${item.status} ${
            item.startedAt ?? ""
          }`,
      }),
    [runs],
  );

  // Get filtered results
  const results: FzfResultItem<WorkflowHistorySearchItem>[] = fzf.find(query);

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
        <Text color="gray">▏</Text>
      </Box>

      {/* Results count */}
      <Box marginTop={1}>
        <Text dimColor>
          {results.length} / {runs.length} runs
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <WorkflowHistorySearchResultItem
            key={result.item.runId}
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
          <Text color="yellow">No matching runs found</Text>
        )}
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓: Navigate | Enter: Select | Esc: Cancel
        </Text>
      </Box>
    </Box>
  );
}

interface WorkflowHistorySearchResultItemProps {
  item: WorkflowHistorySearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single search result item.
 */
function WorkflowHistorySearchResultItem(
  props: WorkflowHistorySearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;

  const statusColors: Record<string, string> = {
    pending: "gray",
    running: "yellow",
    succeeded: "green",
    failed: "red",
  };

  const statusColor = statusColors[item.status] ?? "white";

  // Format the date if available
  const dateStr = item.startedAt
    ? new Date(item.startedAt).toLocaleString()
    : "not started";

  return (
    <Box>
      <Text color={isSelected ? "green" : undefined} bold={isSelected}>
        {isSelected ? "▶ " : "  "}
        {item.workflowName}
      </Text>
      <Text></Text>
      <Text color={statusColor}>[{item.status}]</Text>
      <Text></Text>
      <Text dimColor>{dateStr}</Text>
    </Box>
  );
}
