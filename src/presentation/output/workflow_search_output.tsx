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
import { useScrollableList } from "./hooks/mod.ts";

/**
 * Represents a single workflow search result item.
 */
export interface WorkflowSearchItem {
  id: string;
  name: string;
  description?: string;
  jobCount: number;
}

/**
 * Data structure for workflow search results.
 */
export interface WorkflowSearchData {
  query: string;
  results: WorkflowSearchItem[];
}

/**
 * Renders workflow search results in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected workflow in interactive mode, or undefined in JSON mode
 */
export async function renderWorkflowSearch(
  data: WorkflowSearchData,
  mode: OutputMode,
): Promise<WorkflowSearchItem | undefined> {
  if (mode === "json") {
    renderJsonWorkflowSearch(data);
    return undefined;
  } else {
    return await renderInteractiveWorkflowSearch(data);
  }
}

/**
 * Renders workflow search results as JSON.
 */
function renderJsonWorkflowSearch(data: WorkflowSearchData): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Renders an interactive workflow search UI.
 *
 * @param data - The initial search data (workflows to search and optional initial query)
 * @returns A promise that resolves with the selected workflow, or undefined if cancelled
 */
export function renderInteractiveWorkflowSearch(
  data: WorkflowSearchData,
): Promise<WorkflowSearchItem | undefined> {
  return new Promise<WorkflowSearchItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <WorkflowSearchUI
        workflows={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface WorkflowSearchUIProps {
  workflows: WorkflowSearchItem[];
  initialQuery: string;
  onSelect: (item: WorkflowSearchItem) => void;
  onCancel: () => void;
}

/**
 * Interactive workflow search component using fzf for fuzzy matching.
 */
export function WorkflowSearchUI(
  props: WorkflowSearchUIProps,
): React.ReactElement {
  const { workflows, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);

  // Create fzf instance for fuzzy searching (memoized to avoid recreation on every render)
  const fzf = useMemo(
    () =>
      new Fzf(workflows, {
        selector: (item) => `${item.name} ${item.id} ${item.description ?? ""}`,
      }),
    [workflows],
  );

  // Get filtered results
  const results: FzfResultItem<WorkflowSearchItem>[] = fzf.find(query);

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
          {results.length} / {workflows.length} workflows
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <WorkflowSearchResultItem
            key={result.item.id}
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
          <Text color="yellow">No matching workflows found</Text>
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

interface WorkflowSearchResultItemProps {
  item: WorkflowSearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single search result item.
 */
function WorkflowSearchResultItem(
  props: WorkflowSearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;

  return (
    <Box>
      <Text color={isSelected ? "green" : undefined} bold={isSelected}>
        {isSelected ? "▶ " : "  "}
        {item.name}
      </Text>
      <Text dimColor>({item.jobCount} jobs)</Text>
    </Box>
  );
}
