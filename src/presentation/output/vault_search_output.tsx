// deno-lint-ignore verbatim-module-syntax
import React, { useCallback, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";
import { Fzf, type FzfResultItem } from "fzf";
import type { VaultConfig } from "../../domain/vaults/vault_config.ts";
import { useScrollableList } from "./hooks/mod.ts";

/**
 * Represents a single vault search result item.
 */
export interface VaultSearchItem {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}

/**
 * Data structure for vault search results.
 */
export interface VaultSearchData {
  query: string;
  results: VaultSearchItem[];
}

/**
 * Converts VaultConfig to VaultSearchItem.
 */
export function toVaultSearchItem(config: VaultConfig): VaultSearchItem {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    createdAt: config.createdAt.toISOString(),
  };
}

/**
 * Renders vault search results in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected vault in interactive mode, or undefined in JSON mode
 */
export async function renderVaultSearch(
  data: VaultSearchData,
  mode: OutputMode,
): Promise<VaultSearchItem | undefined> {
  if (mode === "json") {
    renderJsonVaultSearch(data);
    return undefined;
  } else {
    return await renderInteractiveVaultSearch(data);
  }
}

/**
 * Renders vault search results as JSON.
 */
function renderJsonVaultSearch(data: VaultSearchData): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Renders an interactive vault search UI.
 *
 * @param data - The initial search data (vaults to search and optional initial query)
 * @returns A promise that resolves with the selected vault, or undefined if cancelled
 */
export function renderInteractiveVaultSearch(
  data: VaultSearchData,
): Promise<VaultSearchItem | undefined> {
  return new Promise<VaultSearchItem | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <VaultSearchUI
        vaults={data.results}
        initialQuery={data.query}
        onSelect={(item) => resolve(item)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface VaultSearchUIProps {
  vaults: VaultSearchItem[];
  initialQuery: string;
  onSelect: (item: VaultSearchItem) => void;
  onCancel: () => void;
}

/**
 * Interactive vault search component using fzf for fuzzy matching.
 */
export function VaultSearchUI(props: VaultSearchUIProps): React.ReactElement {
  const { vaults, initialQuery, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);

  // Create fzf instance for fuzzy searching (memoized to avoid recreation on every render)
  const fzf = useMemo(
    () =>
      new Fzf(vaults, {
        selector: (item) => `${item.name} ${item.type} ${item.id}`,
      }),
    [vaults],
  );

  // Get filtered results
  const results: FzfResultItem<VaultSearchItem>[] = fzf.find(query);

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
          {results.length} / {vaults.length} vaults
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <VaultSearchResultItem
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
          <Text color="yellow">No matching vaults found</Text>
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

interface VaultSearchResultItemProps {
  item: VaultSearchItem;
  isSelected: boolean;
}

/**
 * Component to display a single vault search result item.
 */
function VaultSearchResultItem(
  props: VaultSearchResultItemProps,
): React.ReactElement {
  const { item, isSelected } = props;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={isSelected ? "green" : undefined} bold={isSelected}>
          {isSelected ? "> " : "  "}
          {item.name}
        </Text>
        <Text dimColor>({item.type})</Text>
      </Box>
      {isSelected && (
        <Box marginLeft={4}>
          <Text dimColor>ID: {item.id}</Text>
        </Box>
      )}
    </Box>
  );
}
