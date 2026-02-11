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
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";
import { Fzf, type FzfResultItem } from "fzf";

/**
 * Represents a single data search result item.
 */
export interface DataSearchItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string;
  lifetime: string;
  ownerType: string;
  ownerRef: string;
  modelId: string;
  modelName: string;
  modelType: string;
  streaming: boolean;
  size?: number;
  createdAt: string;
  tags: Record<string, string>;
  workflowTag?: string;
  stepTag?: string;
}

/**
 * Data structure for data search results.
 */
export interface DataSearchData {
  query: string;
  filters: Record<string, string>;
  results: DataSearchItem[];
  total: number;
  limited: boolean;
}

/**
 * Formats a byte size into a human-readable string.
 */
function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Formats an ISO date string as a relative time (e.g., "2s ago").
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
 * Returns the color for a lifetime value.
 */
function getLifetimeColor(
  lifetime: string,
): "green" | "yellow" | undefined {
  switch (lifetime) {
    case "infinite":
      return "green";
    case "ephemeral":
      return "yellow";
    default:
      return undefined;
  }
}

/**
 * Renders data search results in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected item in interactive mode, or undefined in JSON mode
 */
export async function renderDataSearch(
  data: DataSearchData,
  mode: OutputMode,
): Promise<DataSearchItem | undefined> {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return undefined;
  } else {
    return await renderInteractiveDataSearch(data);
  }
}

/**
 * Renders an interactive data search UI.
 *
 * @param data - The initial search data
 * @returns A promise that resolves with the selected item, or undefined if cancelled
 */
function renderInteractiveDataSearch(
  data: DataSearchData,
): Promise<DataSearchItem | undefined> {
  return new Promise<DataSearchItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <DataSearchUI
        items={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface DataSearchUIProps {
  items: DataSearchItem[];
  initialQuery: string;
  onSelect: (item: DataSearchItem) => void;
  onCancel: () => void;
}

/**
 * Interactive data search component using fzf for fuzzy matching.
 */
export function DataSearchUI(props: DataSearchUIProps): React.ReactElement {
  const { items, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Create fzf instance for fuzzy searching
  const fzf = useMemo(
    () =>
      new Fzf(items, {
        selector: (item) =>
          `${item.name} ${item.modelName} ${item.modelType} ${item.type} ${
            item.workflowTag ?? ""
          } ${item.stepTag ?? ""} ${
            Object.entries(item.tags).map(([k, v]) => `${k}=${v}`).join(" ")
          }`,
      }),
    [items],
  );

  // Get filtered results
  const results: FzfResultItem<DataSearchItem>[] = fzf.find(query);
  const maxVisible = 10;
  const visibleResults = results.slice(0, maxVisible);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

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
    if (key.escape) {
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
          {results.length} / {items.length} data items
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {visibleResults.map((result, index) => (
          <DataSearchResultItem
            key={result.item.id}
            item={result.item}
            isSelected={index === selectedIndex}
          />
        ))}
        {results.length > maxVisible && (
          <Text dimColor>... {results.length - maxVisible} more results</Text>
        )}
        {results.length === 0 && (
          <Text color="yellow">No matching data found</Text>
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

interface DataSearchResultItemProps {
  item: DataSearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single data search result item.
 */
function DataSearchResultItem(
  props: DataSearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text color={isSelected ? "green" : undefined} bold={isSelected}>
          {isSelected ? "> " : "  "}
          {item.name}
        </Text>
        <Text dimColor>v{item.version}</Text>
        <Text color="cyan">{item.modelName}</Text>
        <Text dimColor>{item.contentType}</Text>
        <Text color={getLifetimeColor(item.lifetime)}>{item.lifetime}</Text>
        <Text dimColor>{formatSize(item.size)}</Text>
        <Text dimColor>{formatRelativeTime(item.createdAt)}</Text>
      </Box>
      {isSelected && (
        <Box marginLeft={4}>
          <Text dimColor>
            type: {item.type} | owner: {item.ownerType} ({item.ownerRef})
            {item.workflowTag ? ` | workflow: ${item.workflowTag}` : ""}
            {item.stepTag ? ` | step: ${item.stepTag}` : ""}
          </Text>
        </Box>
      )}
    </Box>
  );
}
