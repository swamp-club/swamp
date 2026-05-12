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
  DriverTypeSearchData,
  DriverTypeSearchEvent,
  DriverTypeSearchItem,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";

function filterDriverTypes(
  types: DriverTypeSearchItem[],
  query: string,
): DriverTypeSearchItem[] {
  if (!query) return types;
  const lowerQuery = query.toLowerCase();
  return types.filter(
    (t) =>
      t.type.toLowerCase().includes(lowerQuery) ||
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery),
  );
}

export type DriverTypeSearchRenderer = SearchRenderer<
  DriverTypeSearchEvent,
  DriverTypeSearchItem
>;

class JsonDriverTypeSearchRenderer implements DriverTypeSearchRenderer {
  private _selected: DriverTypeSearchItem | undefined;

  selectedItem(): DriverTypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<DriverTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterDriverTypes(e.data.results, e.data.query);
        const output: DriverTypeSearchData = {
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

class InkDriverTypeSearchRenderer implements DriverTypeSearchRenderer {
  private _selected: DriverTypeSearchItem | undefined;

  selectedItem(): DriverTypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<DriverTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<DriverTypeSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.type} ${item.name} ${item.description}`,
          renderDriverTypeResultLine,
          renderDriverTypePreview,
          renderDriverTypeScrollback,
          "driver types",
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

export function createDriverTypeSearchRenderer(
  mode: OutputMode,
): DriverTypeSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonDriverTypeSearchRenderer();
    case "log":
      return new InkDriverTypeSearchRenderer();
  }
}

function renderDriverTypeResultLine(
  item: DriverTypeSearchItem,
): React.ReactElement {
  return (
    <Text>
      {item.type} <Text dimColor>- {item.name}</Text>
    </Text>
  );
}

function renderDriverTypePreview(
  item: DriverTypeSearchItem,
  _detail: DriverTypeSearchItem | undefined,
  _width: number,
  _height: number,
): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{item.type}</Text>
      <Text dimColor>name: {item.name}</Text>
      <Text dimColor>{item.description}</Text>
    </Box>
  );
}

function renderDriverTypeScrollback(
  item: DriverTypeSearchItem,
  _detail: DriverTypeSearchItem | undefined,
): string {
  return `${item.type} - ${item.name}\n${item.description}`;
}
