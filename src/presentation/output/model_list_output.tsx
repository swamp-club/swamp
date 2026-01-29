// deno-lint-ignore verbatim-module-syntax
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.tsx";
import { Fzf, type FzfResultItem } from "fzf";

/**
 * Represents a single model list item.
 */
export interface ModelListItem {
  id: string;
  name: string;
  type: string;
  resourceId?: string;
}

/**
 * Data structure for model list results.
 */
export interface ModelListData {
  query: string;
  results: ModelListItem[];
}

/**
 * Renders model list in either interactive or JSON mode.
 *
 * @param data - The list data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected model in interactive mode, or undefined in JSON mode
 */
export async function renderModelList(
  data: ModelListData,
  mode: OutputMode,
): Promise<ModelListItem | undefined> {
  if (mode === "json") {
    renderJsonModelList(data);
    return undefined;
  } else {
    return await renderInteractiveModelList(data);
  }
}

/**
 * Renders model list as JSON.
 */
function renderJsonModelList(data: ModelListData): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Renders an interactive model list UI.
 *
 * @param data - The initial list data (models to search and optional initial query)
 * @returns A promise that resolves with the selected model, or undefined if cancelled
 */
export function renderInteractiveModelList(
  data: ModelListData,
): Promise<ModelListItem | undefined> {
  return new Promise<ModelListItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <ModelListUI
        models={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface ModelListUIProps {
  models: ModelListItem[];
  initialQuery: string;
  onSelect: (item: ModelListItem) => void;
  onCancel: () => void;
}

/**
 * Interactive model list component using fzf for fuzzy matching.
 */
export function ModelListUI(
  props: ModelListUIProps,
): React.ReactElement {
  const { models, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Create fzf instance for fuzzy searching (memoized to avoid recreation on every render)
  const fzf = useMemo(
    () =>
      new Fzf(models, {
        selector: (item) => `${item.name} ${item.type} ${item.id}`,
      }),
    [models],
  );

  // Get filtered results
  const results: FzfResultItem<ModelListItem>[] = fzf.find(query);
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
          {results.length} / {models.length} models
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {visibleResults.map((result, index) => (
          <ModelListResultItem
            key={result.item.id}
            item={result.item}
            isSelected={index === selectedIndex}
          />
        ))}
        {results.length > maxVisible && (
          <Text dimColor>... {results.length - maxVisible} more results</Text>
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

interface ModelListResultItemProps {
  item: ModelListItem;
  isSelected: boolean;
}

/**
 * Component to display a single model list item.
 */
function ModelListResultItem(
  props: ModelListResultItemProps,
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
