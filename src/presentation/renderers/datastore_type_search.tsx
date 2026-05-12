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
  DatastoreTypeSearchData,
  DatastoreTypeSearchEvent,
  DatastoreTypeSearchItem,
  EventHandlers,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";

function filterDatastoreTypes(
  types: DatastoreTypeSearchItem[],
  query: string,
): DatastoreTypeSearchItem[] {
  if (!query) return types;
  const lowerQuery = query.toLowerCase();
  return types.filter(
    (t) =>
      t.type.toLowerCase().includes(lowerQuery) ||
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery),
  );
}

export type DatastoreTypeSearchRenderer = SearchRenderer<
  DatastoreTypeSearchEvent,
  DatastoreTypeSearchItem
>;

class JsonDatastoreTypeSearchRenderer implements DatastoreTypeSearchRenderer {
  private _selected: DatastoreTypeSearchItem | undefined;

  selectedItem(): DatastoreTypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<DatastoreTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterDatastoreTypes(e.data.results, e.data.query);
        const output: DatastoreTypeSearchData = {
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

class InkDatastoreTypeSearchRenderer implements DatastoreTypeSearchRenderer {
  private _selected: DatastoreTypeSearchItem | undefined;

  selectedItem(): DatastoreTypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<DatastoreTypeSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<DatastoreTypeSearchItem>(
          e.data.results,
          e.data.query,
          (item) => `${item.type} ${item.name} ${item.description}`,
          renderDatastoreTypeResultLine,
          renderDatastoreTypePreview,
          renderDatastoreTypeScrollback,
          "datastore types",
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

export function createDatastoreTypeSearchRenderer(
  mode: OutputMode,
): DatastoreTypeSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonDatastoreTypeSearchRenderer();
    case "log":
      return new InkDatastoreTypeSearchRenderer();
  }
}

function renderDatastoreTypeResultLine(
  item: DatastoreTypeSearchItem,
): React.ReactElement {
  return (
    <Text>
      {item.type} <Text dimColor>- {item.name}</Text>
    </Text>
  );
}

function renderDatastoreTypePreview(
  item: DatastoreTypeSearchItem,
  _detail: DatastoreTypeSearchItem | undefined,
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

function renderDatastoreTypeScrollback(
  item: DatastoreTypeSearchItem,
  _detail: DatastoreTypeSearchItem | undefined,
): string {
  return `${item.type} - ${item.name}\n${item.description}`;
}
