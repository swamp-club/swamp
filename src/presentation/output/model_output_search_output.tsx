// deno-lint-ignore verbatim-module-syntax
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";
import { Fzf, type FzfResultItem } from "fzf";

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
  const [selectedIndex, setSelectedIndex] = useState(0);

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
          {results.length} / {outputs.length} outputs
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {visibleResults.map((result, index) => (
          <ModelOutputSearchResultItem
            key={result.item.id}
            item={result.item}
            isSelected={index === selectedIndex}
          />
        ))}
        {results.length > maxVisible && (
          <Text dimColor>... {results.length - maxVisible} more results</Text>
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
      <Text dimColor></Text>
      <Text color="cyan">{item.methodName}</Text>
      <Text dimColor></Text>
      <Text color={getStatusColor(item.status)}>{item.status}</Text>
      <Text dimColor></Text>
      {item.durationMs !== undefined && (
        <Text dimColor>({formatDuration(item.durationMs)})</Text>
      )}
    </Box>
  );
}
