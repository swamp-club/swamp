// deno-lint-ignore verbatim-module-syntax
import React, { useCallback, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";
import { Fzf, type FzfResultItem } from "fzf";
import { useScrollableList } from "./hooks/mod.ts";

/**
 * Represents a single model search item.
 */
export interface ModelSearchItem {
  id: string;
  name: string;
  type: string;
}

/**
 * Data structure for model search results.
 */
export interface ModelSearchData {
  query: string;
  results: ModelSearchItem[];
}

/**
 * Renders model search in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected model in interactive mode, or undefined in JSON mode
 */
export async function renderModelSearch(
  data: ModelSearchData,
  mode: OutputMode,
): Promise<ModelSearchItem | undefined> {
  if (mode === "json") {
    renderJsonModelSearch(data);
    return undefined;
  } else {
    return await renderInteractiveModelSearch(data);
  }
}

/**
 * Renders model search as JSON.
 */
function renderJsonModelSearch(data: ModelSearchData): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Renders an interactive model search UI.
 *
 * @param data - The initial search data (models to search and optional initial query)
 * @returns A promise that resolves with the selected model, or undefined if cancelled
 */
export function renderInteractiveModelSearch(
  data: ModelSearchData,
): Promise<ModelSearchItem | undefined> {
  return new Promise<ModelSearchItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <ModelSearchUI
        models={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface ModelSearchUIProps {
  models: ModelSearchItem[];
  initialQuery: string;
  onSelect: (item: ModelSearchItem) => void;
  onCancel: () => void;
}

/**
 * Interactive model search component using fzf for fuzzy matching.
 */
export function ModelSearchUI(
  props: ModelSearchUIProps,
): React.ReactElement {
  const { models, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);

  // Create fzf instance for fuzzy searching (memoized to avoid recreation on every render)
  const fzf = useMemo(
    () =>
      new Fzf(models, {
        selector: (item) => `${item.name} ${item.type} ${item.id}`,
      }),
    [models],
  );

  // Get filtered results
  const results: FzfResultItem<ModelSearchItem>[] = fzf.find(query);

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
          {results.length} / {models.length} models
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <ModelSearchResultItem
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
          <Text color="yellow">No matching models found</Text>
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

interface ModelSearchResultItemProps {
  item: ModelSearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single model search item.
 */
function ModelSearchResultItem(
  props: ModelSearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;

  return (
    <Box>
      <Text color={isSelected ? "green" : undefined} bold={isSelected}>
        {isSelected ? "> " : "  "}
        {item.name}
      </Text>
      <Text dimColor>({item.type})</Text>
    </Box>
  );
}
