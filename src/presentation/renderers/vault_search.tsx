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
import React from "react";
import { Box, Text } from "ink";
import type {
  EventHandlers,
  VaultDescribeData,
  VaultSearchData,
  VaultSearchEvent,
  VaultSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";

/**
 * Filters vaults by a query string (case-insensitive match on name, type, or id).
 */
function filterVaults(
  vaults: VaultSearchItem[],
  query: string,
): VaultSearchItem[] {
  if (!query) return vaults;
  const lowerQuery = query.toLowerCase();
  return vaults.filter(
    (v) =>
      v.name.toLowerCase().includes(lowerQuery) ||
      v.type.toLowerCase().includes(lowerQuery) ||
      v.id.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Callback type for fetching vault detail data for the preview pane.
 */
export type VaultPreviewFetcher = (
  item: VaultSearchItem,
) => Promise<VaultDescribeData>;

export type VaultSearchRenderer = SearchRenderer<
  VaultSearchEvent,
  VaultSearchItem
>;

class JsonVaultSearchRenderer implements VaultSearchRenderer {
  private _selected: VaultSearchItem | undefined;

  selectedItem(): VaultSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<VaultSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterVaults(e.data.results, e.data.query);
        const output: VaultSearchData = {
          query: e.data.query,
          results: filtered,
        };
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkVaultSearchRenderer implements VaultSearchRenderer {
  private _selected: VaultSearchItem | undefined;
  private readonly fetchPreview: VaultPreviewFetcher | undefined;

  constructor(fetchPreview?: VaultPreviewFetcher) {
    this.fetchPreview = fetchPreview;
  }

  selectedItem(): VaultSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<VaultSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<
          VaultSearchItem,
          VaultDescribeData
        >(
          e.data.results,
          e.data.query,
          (item) => `${item.name} ${item.type} ${item.id}`,
          renderVaultResultLine,
          renderVaultPreview,
          renderVaultScrollback,
          "vaults",
          {
            fetchPreview: this.fetchPreview,
            previewKeyFn: (item) => item.id,
          },
        );
        if (result) {
          this._selected = result.item;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createVaultSearchRenderer(
  mode: OutputMode,
  fetchPreview?: VaultPreviewFetcher,
): VaultSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonVaultSearchRenderer();
    case "log":
      return new InkVaultSearchRenderer(fetchPreview);
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

/** Single-line result for the results list. */
function renderVaultResultLine(item: VaultSearchItem): React.ReactElement {
  return (
    <Text>
      {item.name} <Text dimColor>({item.type})</Text>
    </Text>
  );
}

/** Renders preview content for a vault. */
function renderVaultPreview(
  item: VaultSearchItem,
  detail: VaultDescribeData | undefined,
  _width: number,
  _height: number,
): React.ReactElement {
  if (!detail) {
    // Immediate content from the search item
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>{item.name}</Text>
        <Text dimColor>type: {item.type}</Text>
        <Text dimColor>id: {item.id}</Text>
      </Box>
    );
  }

  // Full detail from fetchPreview
  const configJson = JSON.stringify(detail.config, null, 2);
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{detail.name}</Text>
      <Text dimColor>type: {detail.type}</Text>
      <Text dimColor>id: {detail.id}</Text>
      <Text dimColor>created: {detail.createdAt}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>Config:</Text>
        <Text>{configJson}</Text>
      </Box>
    </Box>
  );
}

/** Produces plain-text scrollback output for a selected vault. */
function renderVaultScrollback(
  item: VaultSearchItem,
  detail: VaultDescribeData | undefined,
): string {
  if (!detail) {
    return `${item.name} (${item.type})\nID: ${item.id}`;
  }

  const lines: string[] = [
    `${detail.name} (${detail.type})`,
    `ID: ${detail.id}`,
    `created: ${detail.createdAt}`,
    "",
    "Config:",
    JSON.stringify(detail.config, null, 2),
  ];

  return lines.join("\n");
}
