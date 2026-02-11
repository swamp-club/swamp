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
 * Represents a single model output search item.
 */
export interface ModelOutputSearchItem {
  id: string;
  definitionId: string;
  modelName?: string;
  type: string;
  methodName: string;
  status: string;
  startedAt: string;
  durationMs?: number;
}

/**
 * Data structure for model output search results.
 */
export interface ModelOutputSearchData {
  query: string;
  results: ModelOutputSearchItem[];
}

/**
 * Renders model output search in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected output in interactive mode, or undefined in JSON mode
 */
export async function renderModelOutputSearch(
  data: ModelOutputSearchData,
  mode: OutputMode,
): Promise<ModelOutputSearchItem | undefined> {
  if (mode === "json") {
    renderJsonModelOutputSearch(data);
    return undefined;
  } else {
    return await renderInteractiveModelOutputSearch(data);
  }
}

/**
 * Renders model output search as JSON.
 */
function renderJsonModelOutputSearch(data: ModelOutputSearchData): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Renders an interactive model output search UI.
 *
 * @param data - The initial search data (outputs to search and optional initial query)
 * @returns A promise that resolves with the selected output, or undefined if cancelled
 */
export function renderInteractiveModelOutputSearch(
  data: ModelOutputSearchData,
): Promise<ModelOutputSearchItem | undefined> {
  return new Promise<ModelOutputSearchItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <ModelOutputSearchUI
        outputs={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface ModelOutputSearchUIProps {
  outputs: ModelOutputSearchItem[];
  initialQuery: string;
  onSelect: (item: ModelOutputSearchItem) => void;
  onCancel: () => void;
}

/**
 * Gets the status color based on execution status.
 */
function getStatusColor(
  status: string,
): "green" | "yellow" | "red" | "blue" | undefined {
  switch (status) {
    case "succeeded":
      return "green";
    case "failed":
      return "red";
    case "running":
      return "yellow";
    case "pending":
      return "blue";
    default:
      return undefined;
  }
}

/**
 * Formats duration in a human-readable way.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Interactive model output search component using fzf for fuzzy matching.
 */
export function ModelOutputSearchUI(
  props: ModelOutputSearchUIProps,
): React.ReactElement {
  const { outputs, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);

  // Create fzf instance for fuzzy searching (memoized to avoid recreation on every render)
  const fzf = useMemo(
    () =>
      new Fzf(outputs, {
        selector: (item) =>
          `${
            item.modelName ?? item.definitionId
          } ${item.type} ${item.methodName} ${item.status} ${item.id}`,
      }),
    [outputs],
  );

  // Get filtered results
  const results: FzfResultItem<ModelOutputSearchItem>[] = fzf.find(query);

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
          {results.length} / {outputs.length} outputs
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <ModelOutputSearchResultItem
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
          <Text color="yellow">No matching outputs found</Text>
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

interface ModelOutputSearchResultItemProps {
  item: ModelOutputSearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single model output search item.
 */
function ModelOutputSearchResultItem(
  props: ModelOutputSearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;

  return (
    <Box>
      <Text color={isSelected ? "green" : undefined} bold={isSelected}>
        {isSelected ? "> " : "  "}
        {item.modelName ?? item.definitionId.slice(0, 8)}
      </Text>
      <Text color="cyan">{` ${item.methodName}`}</Text>
      <Text color={getStatusColor(item.status)}>{` [${item.status}]`}</Text>
      {item.durationMs !== undefined && (
        <Text dimColor>{` (${formatDuration(item.durationMs)})`}</Text>
      )}
    </Box>
  );
}
