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
  TypeDescribeData,
  TypeSearchData,
  TypeSearchEvent,
  TypeSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";
import { formatMethodLines } from "./model_get.ts";

const INDENT_4 = "    ";

/**
 * Filters types by a query string (case-insensitive match on raw or normalized).
 */
function filterTypes(
  types: TypeSearchItem[],
  query: string,
): TypeSearchItem[] {
  if (!query) return types;
  const lowerQuery = query.toLowerCase();
  return types.filter(
    (t) =>
      t.raw.toLowerCase().includes(lowerQuery) ||
      t.normalized.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Callback type for fetching type detail data for the preview pane.
 */
export type TypePreviewFetcher = (
  item: TypeSearchItem,
) => Promise<TypeDescribeData>;

export type TypeSearchRenderer = SearchRenderer<
  TypeSearchEvent,
  TypeSearchItem
>;

class JsonTypeSearchRenderer implements TypeSearchRenderer {
  private _selected: TypeSearchItem | undefined;

  selectedItem(): TypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<TypeSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterTypes(e.data.results, e.data.query);
        const output: TypeSearchData = {
          query: e.data.query,
          results: filtered,
        };
        if (filtered.length === 0 && e.data.query) {
          output.hint =
            `No local types matched. Try: swamp extension search ${e.data.query}`;
        }
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkTypeSearchRenderer implements TypeSearchRenderer {
  private _selected: TypeSearchItem | undefined;
  private readonly fetchPreview: TypePreviewFetcher | undefined;

  constructor(fetchPreview?: TypePreviewFetcher) {
    this.fetchPreview = fetchPreview;
  }

  selectedItem(): TypeSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<TypeSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<
          TypeSearchItem,
          TypeDescribeData
        >(
          e.data.results,
          e.data.query,
          (item) => `${item.raw} ${item.normalized}`,
          renderTypeResultLine,
          renderTypePreview,
          renderTypeScrollback,
          "types",
          {
            fetchPreview: this.fetchPreview,
            previewKeyFn: (item) => item.raw,
            emptyHint: (query) => (
              <Text dimColor>
                Tip: run `swamp extension search{" "}
                {query}` to check community extensions
              </Text>
            ),
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

export function createTypeSearchRenderer(
  mode: OutputMode,
  fetchPreview?: TypePreviewFetcher,
): TypeSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonTypeSearchRenderer();
    case "log":
      return new InkTypeSearchRenderer(fetchPreview);
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

/** Single-line result for the results list. */
function renderTypeResultLine(item: TypeSearchItem): React.ReactElement {
  const rawLabel = item.raw !== item.normalized ? ` (${item.raw})` : undefined;
  return (
    <Text>
      {item.normalized}
      {rawLabel !== undefined && <Text dimColor>{rawLabel}</Text>}
    </Text>
  );
}

/** Renders preview content for a type. */
function renderTypePreview(
  item: TypeSearchItem,
  detail: TypeDescribeData | undefined,
  _width: number,
  _height: number,
): React.ReactElement {
  if (!detail) {
    // Immediate content from the search item
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>{item.normalized}</Text>
        {item.raw !== item.normalized && <Text dimColor>raw: {item.raw}</Text>}
      </Box>
    );
  }

  // Full detail from fetchPreview
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{detail.type.normalized}</Text>
      {detail.type.raw !== detail.type.normalized && (
        <Text dimColor>raw: {detail.type.raw}</Text>
      )}
      <Text dimColor>version: {detail.version}</Text>
      {detail.methods && detail.methods.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>Methods:</Text>
          {detail.methods.map((method) => (
            <Box key={method.name} flexDirection="column" marginLeft={1}>
              <Text>
                <Text color="cyan" bold>{method.name}</Text>
                <Text dimColor>- {method.description}</Text>
              </Text>
              {renderMethodArguments(method.arguments)}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Renders JSON Schema arguments as Ink elements for the preview pane. */
function renderMethodArguments(schema: object): React.ReactElement | null {
  const s = schema as {
    properties?: Record<
      string,
      { type?: string; enum?: string[]; description?: string }
    >;
    required?: string[];
  };
  if (!s.properties) return null;

  const required = new Set(s.required ?? []);
  const entries = Object.entries(s.properties);
  if (entries.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color="cyan">Arguments:</Text>
      {entries.map(([name, prop]) => (
        <Text key={name}>
          {INDENT_4}
          {name}
          {prop.type ? <Text dimColor>({prop.type})</Text> : null}
          {prop.enum ? <Text dimColor>[{prop.enum.join(", ")}]</Text> : null}
          {required.has(name) ? <Text dimColor>*required</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

/** Produces plain-text scrollback output for a selected type. */
function renderTypeScrollback(
  item: TypeSearchItem,
  detail: TypeDescribeData | undefined,
): string {
  if (!detail) {
    if (item.raw !== item.normalized) {
      return `${item.normalized} (${item.raw})`;
    }
    return item.normalized;
  }

  const lines: string[] = [
    `${detail.type.normalized} v${detail.version}`,
  ];

  if (detail.type.raw !== detail.type.normalized) {
    lines.push(`raw: ${detail.type.raw}`);
  }

  if (detail.methods && detail.methods.length > 0) {
    lines.push("");
    lines.push("Methods:");
    lines.push(...formatMethodLines(detail.methods));
  }

  return lines.join("\n");
}
