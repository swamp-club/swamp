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
import { suppressInkTtyErrors } from "./ink_lifecycle.ts";
import { useScrollableList } from "./hooks/mod.ts";

/**
 * Represents a single extension search result item.
 */
export interface ExtensionSearchResultItem {
  name: string;
  description: string;
  latestVersion: string;
  platforms: string[];
  labels: string[];
  contentTypes: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The action taken on a search result.
 */
export type ExtensionSearchAction = "select" | "install";

/**
 * Result from the extension search UI, combining the action and extension.
 */
export interface ExtensionSearchResult {
  action: ExtensionSearchAction;
  extension: ExtensionSearchResultItem;
}

/**
 * Data structure for extension search results.
 */
export interface ExtensionSearchData {
  extensions: ExtensionSearchResultItem[];
  meta: {
    total: number;
    page: number;
    perPage: number;
  };
}

/**
 * Renders extension search results in either interactive or JSON mode.
 *
 * @param data - The search data to render
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the search result in interactive mode, or undefined in JSON mode
 */
export async function renderExtensionSearch(
  data: ExtensionSearchData,
  mode: OutputMode,
): Promise<ExtensionSearchResult | undefined> {
  if (mode === "json") {
    const output = {
      ...data,
      extensions: data.extensions.map((ext) => {
        const { platforms, labels, contentTypes, ...rest } = ext;
        return {
          ...rest,
          ...(platforms.length > 0 ? { platforms } : {}),
          ...(labels.length > 0 ? { labels } : {}),
          ...(contentTypes.length > 0 ? { contentTypes } : {}),
        };
      }),
    };
    console.log(JSON.stringify(output, null, 2));
    return undefined;
  } else {
    return await renderInteractiveExtensionSearch(data);
  }
}

/**
 * Renders an interactive extension search UI.
 */
function renderInteractiveExtensionSearch(
  data: ExtensionSearchData,
): Promise<ExtensionSearchResult | undefined> {
  return new Promise<ExtensionSearchResult | undefined>((resolve) => {
    const cleanupTty = suppressInkTtyErrors();
    const { waitUntilExit } = render(
      <ExtensionSearchUI
        extensions={data.extensions}
        meta={data.meta}
        onSelect={(result) => {
          cleanupTty();
          resolve(result);
        }}
        onCancel={() => {
          cleanupTty();
          resolve(undefined);
        }}
      />,
    );
    waitUntilExit().catch(() => {});
  });
}

interface ExtensionSearchUIProps {
  extensions: ExtensionSearchResultItem[];
  meta: { total: number; page: number; perPage: number };
  onSelect: (result: ExtensionSearchResult) => void;
  onCancel: () => void;
}

/**
 * Interactive extension search component using fzf for fuzzy matching.
 */
export function ExtensionSearchUI(
  props: ExtensionSearchUIProps,
): React.ReactElement {
  const { extensions, meta, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [query, setQuery] = useState("");
  const [selectedDetail, setSelectedDetail] = useState<
    ExtensionSearchResultItem | null
  >(null);

  const fzf = useMemo(
    () =>
      new Fzf(extensions, {
        selector: (item) =>
          `${item.name} ${item.description} ${item.labels.join(" ")}`,
      }),
    [extensions],
  );

  const results: FzfResultItem<ExtensionSearchResultItem>[] = fzf.find(query);

  const {
    selectedIndex,
    setSelectedIndex,
    visibleItems: visibleResults,
    scrollMetrics,
  } = useScrollableList(results, 10, [query]);

  const handleSelect = useCallback(() => {
    if (results.length > 0 && selectedIndex < results.length) {
      const selected = results[selectedIndex].item;
      if (selectedDetail) {
        // Already in detail view, confirm selection
        exit();
        onSelect({ action: "select", extension: selected });
      } else {
        setSelectedDetail(selected);
      }
    }
  }, [results, selectedIndex, exit, onSelect, selectedDetail]);

  const handleInstall = useCallback(() => {
    if (selectedDetail) {
      exit();
      onSelect({ action: "install", extension: selectedDetail });
    }
  }, [exit, onSelect, selectedDetail]);

  const handleCancel = useCallback(() => {
    if (selectedDetail) {
      setSelectedDetail(null);
    } else {
      exit();
      onCancel();
    }
  }, [exit, onCancel, selectedDetail]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      handleCancel();
      return;
    }

    if (key.return) {
      handleSelect();
      return;
    }

    // Handle install key in detail view
    if (selectedDetail && input === "i" && !key.ctrl && !key.meta) {
      handleInstall();
      return;
    }

    // Don't handle navigation/input keys in detail view
    if (selectedDetail) return;

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

    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
    }
  });

  if (selectedDetail) {
    return <ExtensionDetailView extension={selectedDetail} />;
  }

  return (
    <Box flexDirection="column">
      {/* Search input */}
      <Box>
        <Text color="cyan" bold>
          Filter:{" "}
        </Text>
        <Text>{query}</Text>
        <Text color="gray">▏</Text>
      </Box>

      {/* Results count and pagination */}
      <Box marginTop={1}>
        <Text dimColor>
          {results.length} / {extensions.length} extensions — Page {meta.page}
          {" "}
          ({meta.total} total)
        </Text>
      </Box>

      {/* Results list */}
      <Box flexDirection="column" marginTop={1}>
        {scrollMetrics.hasMoreAbove && (
          <Text dimColor>... {scrollMetrics.moreAboveCount} more above</Text>
        )}
        {visibleResults.map((result, index) => (
          <ExtensionSearchResultRow
            key={result.item.name}
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
          <Text color="yellow">No matching extensions found</Text>
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

interface ExtensionSearchResultRowProps {
  item: ExtensionSearchResultItem;
  isSelected: boolean;
}

/**
 * Component to display a single extension search result row.
 */
function ExtensionSearchResultRow(
  props: ExtensionSearchResultRowProps,
): React.ReactElement {
  const { item, isSelected } = props;
  const descriptionMax = 60;
  const truncatedDesc = item.description.length > descriptionMax
    ? item.description.slice(0, descriptionMax) + "…"
    : item.description;

  return (
    <Box>
      <Text color={isSelected ? "green" : undefined} bold={isSelected}>
        {isSelected ? "▶ " : "  "}
        {item.name}
      </Text>
      <Text dimColor>
        {` v${item.latestVersion}`}
      </Text>
      {truncatedDesc && (
        <Text dimColor>
          {` — ${truncatedDesc}`}
        </Text>
      )}
      {item.labels.length > 0 && (
        <Text color="blue">
          {` [${item.labels.join(", ")}]`}
        </Text>
      )}
    </Box>
  );
}

interface ExtensionDetailViewProps {
  extension: ExtensionSearchResultItem;
}

/**
 * Component to display extension details.
 */
function ExtensionDetailView(
  props: ExtensionDetailViewProps,
): React.ReactElement {
  const { extension } = props;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>{extension.name}</Text>
        <Text dimColor>
          {` v${extension.latestVersion}`}
        </Text>
      </Box>

      {extension.description && (
        <Box marginTop={1}>
          <Text>{extension.description}</Text>
        </Box>
      )}

      {extension.platforms.length > 0 && (
        <Box marginTop={1}>
          <Text bold>
            {`Platforms: ${extension.platforms.join(", ")}`}
          </Text>
        </Box>
      )}

      {extension.labels.length > 0 && (
        <Box marginTop={1}>
          <Text bold>
            {`Labels: ${extension.labels.join(", ")}`}
          </Text>
        </Box>
      )}

      {extension.contentTypes.length > 0 && (
        <Box marginTop={1}>
          <Text bold>
            {`Content Types: ${extension.contentTypes.join(", ")}`}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text bold>
          {`Created: ${extension.createdAt}`}
        </Text>
      </Box>

      <Box>
        <Text bold>
          {`Updated: ${extension.updatedAt}`}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Enter: Select | i: Install | Esc: Back
        </Text>
      </Box>
    </Box>
  );
}
