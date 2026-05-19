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
import { Fzf, type FzfResultItem } from "fzf";
import { suppressInkTtyErrors } from "../../output/ink_lifecycle.ts";

/** Thin cursor character for the search input. */
const CURSOR = "\u258F";
import {
  usePreviewFetch,
  usePreviewScroll,
  useScrollableList,
  useTerminalSize,
} from "./hooks/mod.ts";
import { computePickerLayout } from "./picker_layout.ts";
import type { ActionDef } from "./help_bar.tsx";
import { HelpBar } from "./help_bar.tsx";
import { ResultsList } from "./results_list.tsx";
import { PreviewPane } from "./preview_pane.tsx";
import { BorderedSplitLayout, StackedLayout } from "./picker_borders.tsx";

/**
 * Props for the SearchPicker component.
 *
 * The two type params allow the preview to render richer data (`D`) than the
 * search item (`T`) contains. When `fetchPreview` is not provided, `D` defaults
 * to `T` and `detail` is always `undefined`.
 */
export interface SearchPickerProps<T, D = T> {
  items: T[];
  initialQuery: string;
  /** Extracts searchable text for fzf matching. */
  selector: (item: T) => string;
  /** Renders a single-line summary for the results list. */
  renderResultLine: (item: T) => React.ReactElement;
  /** Renders preview content for the highlighted item. */
  renderPreview: (
    item: T,
    detail: D | undefined,
    width: number,
    height: number,
  ) => React.ReactElement;
  /** Produces plain-text scrollback output on selection. */
  renderScrollback: (item: T, detail: D | undefined) => string;
  /** Async function to fetch full detail for preview. Optional. */
  fetchPreview?: (item: T) => Promise<D>;
  /** Extracts a stable cache key for the LRU preview cache. */
  previewKeyFn?: (item: T) => unknown;
  /** Plural label for the item type (e.g., "models", "data"). */
  itemLabel: string;
  /** Command name shown on the branding line (e.g., "model search"). */
  commandName?: string;
  /** Hint shown when no results match the query. */
  emptyHint?: (query: string) => React.ReactElement | undefined;
  /** Domain-specific action keys. */
  actions?: ActionDef[];
  /** Called when the user selects an item. Receives the scrollback text. */
  onSelect: (item: T, scrollback: string, action?: string) => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}

/**
 * Telescope-inspired search picker with three bordered regions: prompt,
 * results list, and preview pane. Prompt always has focus — typing always
 * filters, arrows always navigate results, Ctrl-u/d scrolls preview.
 *
 * Gracefully degrades through four tiers based on terminal size:
 * bordered-split → stacked → inline → minimal.
 */
export function SearchPicker<T, D = T>(
  props: SearchPickerProps<T, D>,
): React.ReactElement {
  const {
    items,
    initialQuery,
    selector,
    renderResultLine,
    renderPreview,
    renderScrollback,
    fetchPreview,
    previewKeyFn,
    itemLabel,
    commandName,
    emptyHint,
    actions,
    onSelect,
    onCancel,
  } = props;
  const effectiveCommandName = commandName ?? `${itemLabel} search`;
  const { exit } = useApp();

  const [query, setQuery] = useState(initialQuery);
  const { width, height } = useTerminalSize();
  const layout = computePickerLayout(width, height);

  // fzf fuzzy matching
  const fzf = useMemo(() => {
    const FzfCtor = Fzf as unknown as new (...args: unknown[]) => {
      find(query: string): FzfResultItem<T>[];
    };
    return new FzfCtor(items, { selector });
  }, [items, selector]);

  const results: FzfResultItem<T>[] = fzf.find(query);

  // Scrollable results list
  const {
    selectedIndex,
    setSelectedIndex,
    visibleItems: visibleResults,
    scrollMetrics,
  } = useScrollableList(results, layout.resultsHeight, [query]);

  // Currently highlighted item
  const highlightedItem = results.length > 0 && selectedIndex < results.length
    ? results[selectedIndex].item
    : undefined;

  // Async preview fetch with debounce + LRU cache
  const { detail } = usePreviewFetch(
    highlightedItem,
    fetchPreview,
    previewKeyFn,
  );

  // Estimate actual content height from scrollback text (mirrors preview content).
  // This prevents scrolling past the end into empty space.
  const scrollbackText = useMemo(
    () => highlightedItem ? renderScrollback(highlightedItem, detail) : "",
    [highlightedItem, detail, renderScrollback],
  );
  const previewContentHeight = Math.max(
    layout.previewHeight,
    scrollbackText.split("\n").length,
  );
  const { scrollOffset, scrollUp, scrollDown } = usePreviewScroll(
    previewContentHeight,
    layout.previewHeight,
    highlightedItem,
  );

  const handleSelect = useCallback(
    (action?: string) => {
      if (results.length > 0 && selectedIndex < results.length) {
        const selected = results[selectedIndex].item;
        const scrollbackText = renderScrollback(selected, detail);
        exit();
        onSelect(selected, scrollbackText, action);
      }
    },
    [results, selectedIndex, exit, onSelect, renderScrollback, detail],
  );

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

    // Ctrl-u: scroll preview up half page
    if (key.ctrl && input === "u") {
      scrollUp();
      return;
    }

    // Ctrl-d: scroll preview down half page
    if (key.ctrl && input === "d") {
      scrollDown();
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }

    // Check for action keys
    if (actions && input && !key.ctrl && !key.meta) {
      const action = actions.find((a) => a.key === input);
      if (action) {
        handleSelect(action.action);
        return;
      }
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
    }
  });

  const hasPreview = layout.previewHeight > 0;

  // Shared prompt content — no border wrapping, just search input and count
  const promptContent = (
    <Box justifyContent="space-between" width={width}>
      <Box>
        <Text color="cyan" bold>
          {">"}
          {" "}
        </Text>
        <Text>{query}</Text>
        <Text color="gray">{CURSOR}</Text>
      </Box>
      <Text dimColor>
        {results.length} / {items.length}
      </Text>
    </Box>
  );

  // Results content
  const resultsContent = results.length === 0
    ? (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color="yellow">No matching {itemLabel} found</Text>
        {query && emptyHint?.(query)}
      </Box>
    )
    : (
      <ResultsList
        visibleItems={visibleResults.map((r) => r.item)}
        selectedIndex={selectedIndex}
        scrollMetrics={scrollMetrics}
        renderLine={renderResultLine}
        width={layout.resultsWidth}
      />
    );

  // Preview content
  const previewContent = hasPreview
    ? (
      <PreviewPane
        item={highlightedItem}
        detail={detail}
        width={layout.previewWidth}
        height={layout.previewHeight}
        scrollOffset={scrollOffset}
        renderPreview={renderPreview}
      />
    )
    : null;

  // Help bar content
  const helpContent = <HelpBar hasPreview={hasPreview} actions={actions} />;

  // Render based on tier
  if (layout.tier === "bordered-split") {
    return (
      <BorderedSplitLayout
        width={width}
        resultsWidth={layout.resultsWidth}
        previewWidth={layout.previewWidth}
        contentHeight={layout.resultsHeight}
        commandName={effectiveCommandName}
        promptContent={promptContent}
        resultsContent={resultsContent}
        previewContent={previewContent ?? <Box />}
        helpContent={helpContent}
      />
    );
  }

  if (layout.tier === "stacked") {
    return (
      <StackedLayout
        width={width}
        resultsHeight={layout.resultsHeight}
        previewHeight={layout.previewHeight}
        commandName={effectiveCommandName}
        promptContent={promptContent}
        resultsContent={resultsContent}
        previewContent={previewContent ?? <Box />}
        helpContent={helpContent}
      />
    );
  }

  if (layout.tier === "inline") {
    return (
      <Box flexDirection="column">
        {/* Search input */}
        <Box>
          <Text color="cyan" bold>
            Search:{" "}
          </Text>
          <Text>{query}</Text>
          <Text color="gray">{CURSOR}</Text>
        </Box>

        {/* Results count */}
        <Box marginTop={1}>
          <Text dimColor>
            {results.length} / {items.length} {itemLabel}
          </Text>
        </Box>

        {/* Results list with inline preview expansion */}
        <Box
          flexDirection="column"
          marginTop={1}
          width={width}
          overflow="hidden"
        >
          {resultsContent}
          {highlightedItem && previewContent && (
            <Box marginLeft={4} marginTop={1}>
              {previewContent}
            </Box>
          )}
        </Box>

        {/* Help text */}
        <Box marginTop={1}>{helpContent}</Box>
      </Box>
    );
  }

  // Minimal tier: same layout as existing SearchTUI
  return (
    <Box flexDirection="column">
      {/* Search input */}
      <Box>
        <Text color="cyan" bold>
          Search:{" "}
        </Text>
        <Text>{query}</Text>
        <Text color="gray">{CURSOR}</Text>
      </Box>

      {/* Results count */}
      <Box marginTop={1}>
        <Text dimColor>
          {results.length} / {items.length} {itemLabel}
        </Text>
      </Box>

      {/* Results list */}
      <Box
        flexDirection="column"
        marginTop={1}
        width={width}
        overflow="hidden"
      >
        {resultsContent}
      </Box>

      {/* Help text */}
      <Box marginTop={1}>{helpContent}</Box>
    </Box>
  );
}

/**
 * Result returned from renderInteractivePicker.
 */
export interface PickerResult<T> {
  item: T;
  action?: string;
}

/**
 * Launches a SearchPicker inside an Ink render context and returns the selected
 * item (or `undefined` if the user cancelled).
 */
export async function renderInteractivePicker<T, D = T>(
  items: T[],
  initialQuery: string,
  selector: (item: T) => string,
  renderResultLine: (item: T) => React.ReactElement,
  renderPreview: (
    item: T,
    detail: D | undefined,
    width: number,
    height: number,
  ) => React.ReactElement,
  renderScrollback: (item: T, detail: D | undefined) => string,
  itemLabel: string,
  options?: {
    fetchPreview?: (item: T) => Promise<D>;
    previewKeyFn?: (item: T) => unknown;
    commandName?: string;
    emptyHint?: (query: string) => React.ReactElement | undefined;
    actions?: ActionDef[];
  },
): Promise<PickerResult<T> | undefined> {
  let pendingScrollback: string | undefined;
  const isTTY = Deno.stdout.isTerminal();

  // Enter alternate screen buffer so the picker UI doesn't pollute scrollback.
  // When we exit the alternate screen, the terminal restores to its pre-picker
  // state — no blank lines, no border remnants. Same technique as fzf/Telescope.
  if (isTTY) {
    Deno.stdout.writeSync(new TextEncoder().encode("\x1b[?1049h"));
  }

  const result = await new Promise<PickerResult<T> | undefined>((resolve) => {
    const cleanupTty = suppressInkTtyErrors();
    const { waitUntilExit } = render(
      <SearchPicker
        items={items}
        initialQuery={initialQuery}
        selector={selector}
        renderResultLine={renderResultLine}
        renderPreview={renderPreview}
        renderScrollback={renderScrollback}
        fetchPreview={options?.fetchPreview}
        previewKeyFn={options?.previewKeyFn}
        itemLabel={itemLabel}
        commandName={options?.commandName}
        emptyHint={options?.emptyHint}
        actions={options?.actions}
        onSelect={(item, scrollback, action) => {
          cleanupTty();
          // Only print scrollback for default select (Enter), not action keys
          if (!action) {
            pendingScrollback = scrollback;
          }
          resolve({ item, action });
        }}
        onCancel={() => {
          cleanupTty();
          resolve(undefined);
        }}
      />,
    );
    waitUntilExit().catch(() => {});
  });

  // Exit alternate screen buffer — terminal restores to pre-picker state
  if (isTTY) {
    Deno.stdout.writeSync(new TextEncoder().encode("\x1b[?1049l"));
  }

  // Print scrollback on the normal screen
  if (pendingScrollback) {
    console.log(pendingScrollback);
  }

  return result;
}
