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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type {
  EventHandlers,
  VaultTypeSearchData,
  VaultTypeSearchEvent,
  VaultTypeSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";

/**
 * Filters vault types by a query string (case-insensitive match on type, name,
 * or description).
 */
function filterVaultTypes(
  types: VaultTypeSearchItem[],
  query: string,
): VaultTypeSearchItem[] {
  if (!query) return types;
  const lowerQuery = query.toLowerCase();
  return types.filter(
    (t) =>
      t.type.toLowerCase().includes(lowerQuery) ||
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery),
  );
}

export type VaultTypeSearchRenderer = SearchRenderer<
  VaultTypeSearchEvent,
  VaultTypeSearchItem
>;

class JsonVaultTypeSearchRenderer implements VaultTypeSearchRenderer {
  private _selected: VaultTypeSearchItem | undefined;

  selectedItem(): VaultTypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<VaultTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterVaultTypes(e.data.results, e.data.query);
        const output: VaultTypeSearchData = {
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

class InkVaultTypeSearchRenderer implements VaultTypeSearchRenderer {
  private _selected: VaultTypeSearchItem | undefined;

  selectedItem(): VaultTypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<VaultTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<VaultTypeSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.type} ${item.name} ${item.description}`,
          renderVaultTypeResultLine,
          renderVaultTypePreview,
          renderVaultTypeScrollback,
          "vault types",
          {
            previewKeyFn: (item) => item.type,
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

export function createVaultTypeSearchRenderer(
  mode: OutputMode,
): VaultTypeSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonVaultTypeSearchRenderer();
    case "log":
      return new InkVaultTypeSearchRenderer();
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

/** Single-line result for the results list. */
function renderVaultTypeResultLine(
  item: VaultTypeSearchItem,
): React.ReactElement {
  return (
    <Text>
      {item.type} <Text dimColor>- {item.name}</Text>
    </Text>
  );
}

/** Renders preview content for a vault type. */
function renderVaultTypePreview(
  item: VaultTypeSearchItem,
  _detail: VaultTypeSearchItem | undefined,
  width: number,
  _height: number,
): React.ReactElement {
  const innerWidth = Math.max(10, width - 1);
  return (
    <Box flexDirection="column" marginLeft={1} width={innerWidth}>
      <Text bold wrap="truncate-end">{item.type}</Text>
      <Text dimColor wrap="truncate-end">name: {item.name}</Text>
      <Text dimColor wrap="truncate-end">{item.description}</Text>
    </Box>
  );
}

/** Produces plain-text scrollback output for a selected vault type. */
function renderVaultTypeScrollback(
  item: VaultTypeSearchItem,
  _detail: VaultTypeSearchItem | undefined,
): string {
  return `${item.type} - ${item.name}\n${item.description}`;
}
