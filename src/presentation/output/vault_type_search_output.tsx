// deno-lint-ignore verbatim-module-syntax
import React, { useCallback, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";
import { Fzf, type FzfResultItem } from "fzf";
import type { VaultTypeInfo } from "../../domain/vaults/vault_types.ts";
import { useScrollableList } from "./hooks/mod.ts";

/**
 * Represents a single vault type search result item.
 */
export interface VaultTypeSearchItem {
  type: string;
  name: string;
  description: string;
}

/**
 * Data structure for vault type search results.
 */
export interface VaultTypeSearchData {
  query: string;
  results: VaultTypeSearchItem[];
}

/**
 * Converts VaultTypeInfo to VaultTypeSearchItem.
 */
export function toVaultTypeSearchItem(
  info: VaultTypeInfo,
): VaultTypeSearchItem {
  return {
    type: info.type,
    name: info.name,
    description: info.description,
  };
}

/**
 * Renders vault type search results in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected vault type in interactive mode, or undefined in JSON mode
 */
export async function renderVaultTypeSearch(
  data: VaultTypeSearchData,
  mode: OutputMode,
): Promise<VaultTypeSearchItem | undefined> {
  if (mode === "json") {
    renderJsonVaultTypeSearch(data);
    return undefined;
  } else {
    return await renderInteractiveVaultTypeSearch(data);
  }
}

/**
 * Renders vault type search results as JSON.
 */
function renderJsonVaultTypeSearch(data: VaultTypeSearchData): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Renders an interactive vault type search UI.
 *
 * @param data - The initial search data (vault types to search and optional initial query)
 * @returns A promise that resolves with the selected vault type, or undefined if cancelled
 */
export function renderInteractiveVaultTypeSearch(
  data: VaultTypeSearchData,
): Promise<VaultTypeSearchItem | undefined> {
  return new Promise<VaultTypeSearchItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <VaultTypeSearchUI
        vaultTypes={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface VaultTypeSearchUIProps {
  vaultTypes: VaultTypeSearchItem[];
  initialQuery: string;
  onSelect: (item: VaultTypeSearchItem) => void;
  onCancel: () => void;
}

/**
 * Interactive vault type search component using fzf for fuzzy matching.
 */
export function VaultTypeSearchUI(
  props: VaultTypeSearchUIProps,
): React.ReactElement {
  const { vaultTypes, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);

  // Create fzf instance for fuzzy searching (memoized to avoid recreation on every render)
  const fzf = useMemo(
    () =>
      new Fzf(vaultTypes, {
        selector: (item) => `${item.type} ${item.name} ${item.description}`,
      }),
    [vaultTypes],
  );

  // Get filtered results
  const results: FzfResultItem<VaultTypeSearchItem>[] = fzf.find(query);

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
          {results.length} / {vaultTypes.length} vault types
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <VaultTypeSearchResultItem
            key={result.item.type}
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
          <Text color="yellow">No matching vault types found</Text>
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

interface VaultTypeSearchResultItemProps {
  item: VaultTypeSearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single vault type search result item.
 */
function VaultTypeSearchResultItem(
  props: VaultTypeSearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? "green" : undefined} bold={isSelected}>
          {isSelected ? "> " : "  "}
          {item.type}
        </Text>
        <Text dimColor>- {item.name}</Text>
      </Box>
      {isSelected && (
        <Box marginLeft={4}>
          <Text dimColor>{item.description}</Text>
        </Box>
      )}
    </Box>
  );
}
