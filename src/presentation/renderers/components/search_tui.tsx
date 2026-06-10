// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import React, { useCallback, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { Fzf, type FzfResultItem } from "fzf";
import { suppressInkTtyErrors } from "../../output/ink_lifecycle.ts";
import { useScrollableList } from "../../output/hooks/mod.ts";

/**
 * Props for the generic SearchTUI component.
 *
 * Each search command provides its own `selector` (for fzf matching) and
 * `renderItem` (for per-item display), while the chrome (search bar, count,
 * scroll indicators, keyboard navigation, help text) is shared.
 */
export interface SearchTUIProps<T> {
  items: T[];
  initialQuery: string;
  selector: (item: T) => string;
  renderItem: (item: T, isSelected: boolean) => React.ReactElement;
  itemLabel: string;
  emptyHint?: (query: string) => React.ReactElement | undefined;
  onSelect: (item: T) => void;
  onCancel: () => void;
}

/**
 * Generic fuzzy-search TUI component shared by all search commands.
 * Uses fzf for matching and useScrollableList for pagination.
 */
export function SearchTUI<T>(
  props: SearchTUIProps<T>,
): React.ReactElement {
  const {
    items,
    initialQuery,
    selector,
    renderItem,
    itemLabel,
    emptyHint,
    onSelect,
    onCancel,
  } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);

  // Generic T prevents SyncOptionsTuple conditional resolution; cast the
  // constructor so the rest-parameter tuple check is bypassed. At runtime T is
  // always an object requiring a selector, so this is safe.
  const fzf = useMemo(
    () => {
      const FzfCtor = Fzf as unknown as new (...args: unknown[]) => {
        find(query: string): FzfResultItem<T>[];
      };
      return new FzfCtor(items, { selector });
    },
    [items, selector],
  );

  const results: FzfResultItem<T>[] = fzf.find(query);

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
          {results.length} / {items.length} {itemLabel}
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <React.Fragment key={index}>
            {renderItem(
              result.item,
              index + scrollMetrics.moreAboveCount === selectedIndex,
            )}
          </React.Fragment>
        ))}
        {scrollMetrics.hasMoreBelow && (
          <Text dimColor>
            ... {scrollMetrics.moreBelowCount} more below
          </Text>
        )}
        {results.length === 0 && (
          <>
            <Text color="yellow">No matching {itemLabel} found</Text>
            {query && emptyHint?.(query)}
          </>
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

/**
 * Launches a SearchTUI inside an Ink render context and returns the selected
 * item (or `undefined` if the user cancelled).
 */
export function renderInteractiveSearch<T>(
  items: T[],
  initialQuery: string,
  selector: (item: T) => string,
  renderItem: (item: T, isSelected: boolean) => React.ReactElement,
  itemLabel: string,
  emptyHint?: (query: string) => React.ReactElement | undefined,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const cleanupTty = suppressInkTtyErrors();
    const { waitUntilExit } = render(
      <SearchTUI
        items={items}
        initialQuery={initialQuery}
        selector={selector}
        renderItem={renderItem}
        itemLabel={itemLabel}
        emptyHint={emptyHint}
        onSelect={(item) => {
          resolve(item);
        }}
        onCancel={() => {
          resolve(undefined);
        }}
      />,
    );
    waitUntilExit().then(() => {
      cleanupTty();
    }).catch(() => {
      cleanupTty();
      resolve(undefined);
    });
  });
}
