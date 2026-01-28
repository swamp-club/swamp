// deno-lint-ignore verbatim-module-syntax
import React, { useCallback, useEffect, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.tsx";
import { Fzf, type FzfResultItem } from "fzf";

/**
 * Represents a single type search result item.
 */
export interface TypeSearchItem {
  raw: string;
  normalized: string;
}

/**
 * Data structure for type search results.
 */
export interface TypeSearchData {
  query: string;
  results: TypeSearchItem[];
}

/**
 * Renders type search results in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected type in interactive mode, or undefined in JSON mode
 */
export async function renderTypeSearch(
  data: TypeSearchData,
  mode: OutputMode,
): Promise<TypeSearchItem | undefined> {
  if (mode === "json") {
    renderJsonTypeSearch(data);
    return undefined;
  } else {
    return await renderInteractiveTypeSearch(data);
  }
}

/**
 * Renders type search results as JSON.
 */
function renderJsonTypeSearch(data: TypeSearchData): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Renders an interactive type search UI.
 *
 * @param data - The initial search data (types to search and optional initial query)
 * @returns A promise that resolves with the selected type, or undefined if cancelled
 */
export function renderInteractiveTypeSearch(
  data: TypeSearchData,
): Promise<TypeSearchItem | undefined> {
  return new Promise<TypeSearchItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <TypeSearchUI
        types={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface TypeSearchUIProps {
  types: TypeSearchItem[];
  initialQuery: string;
  onSelect: (item: TypeSearchItem) => void;
  onCancel: () => void;
}

/**
 * Interactive type search component using fzf for fuzzy matching.
 */
export function TypeSearchUI(
  props: TypeSearchUIProps,
): React.ReactElement {
  const { types, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Create fzf instance for fuzzy searching
  const fzf = new Fzf(types, {
    selector: (item) => `${item.raw} ${item.normalized}`,
  });

  // Get filtered results
  const results: FzfResultItem<TypeSearchItem>[] = fzf.find(query);
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
        <Text color="gray">▏</Text>
      </Box>

      {/* Results count */}
      <Box marginTop={1}>
        <Text dimColor>
          {results.length} / {types.length} types
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {visibleResults.map((result, index) => (
          <TypeSearchResultItem
            key={result.item.normalized}
            item={result.item}
            isSelected={index === selectedIndex}
          />
        ))}
        {results.length > maxVisible && (
          <Text dimColor>... {results.length - maxVisible} more results</Text>
        )}
        {results.length === 0 && (
          <Text color="yellow">No matching types found</Text>
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

interface TypeSearchResultItemProps {
  item: TypeSearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single search result item.
 */
function TypeSearchResultItem(
  props: TypeSearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;

  return (
    <Box>
      <Text color={isSelected ? "green" : undefined} bold={isSelected}>
        {isSelected ? "▶ " : "  "}
        {item.normalized}
      </Text>
      {item.raw !== item.normalized && <Text dimColor>({item.raw})</Text>}
    </Box>
  );
}
