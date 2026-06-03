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
  TypeDescribeData,
  TypeSearchData,
  TypeSearchEvent,
  TypeSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { renderInteractivePicker } from "./components/search_picker.tsx";
import { formatMethodLines, formatSchemaType } from "./model_get.ts";

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
  width: number,
  _height: number,
): React.ReactElement {
  const innerWidth = Math.max(10, width - 1);
  if (!detail) {
    return (
      <Box flexDirection="column" marginLeft={1} width={innerWidth}>
        <Text bold wrap="truncate-end">{item.normalized}</Text>
        {item.raw !== item.normalized && (
          <Text dimColor wrap="truncate-end">raw: {item.raw}</Text>
        )}
      </Box>
    );
  }

  const lines: React.ReactElement[] = [
    <Text key="name" bold wrap="truncate-end">
      {detail.type.normalized}
    </Text>,
  ];
  if (detail.type.raw !== detail.type.normalized) {
    lines.push(
      <Text key="raw" dimColor wrap="truncate-end">
        raw: {detail.type.raw}
      </Text>,
    );
  }
  lines.push(
    <Text key="version" dimColor wrap="truncate-end">
      version: {detail.version}
    </Text>,
  );
  if (detail.methods && detail.methods.length > 0) {
    lines.push(<Text key="mhdr" />);
    lines.push(
      <Text key="methods" color="cyan" bold wrap="truncate-end">
        Methods:
      </Text>,
    );
    for (const method of detail.methods) {
      lines.push(
        <Text key={`m-${method.name}`} wrap="truncate-end">
          {"  "}
          <Text color="cyan" bold>{method.name}</Text>
          <Text dimColor>- {method.description}</Text>
        </Text>,
      );
      const schema = method.arguments as {
        properties?: Record<
          string,
          {
            type?: string | string[];
            enum?: string[];
          }
        >;
        required?: string[];
      };
      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        for (const [name, prop] of Object.entries(schema.properties)) {
          const formatted = formatSchemaType(prop.type);
          const parts = [name];
          if (formatted) parts.push(`(${formatted})`);
          if (prop.enum) parts.push(`[${prop.enum.join(", ")}]`);
          if (required.has(name)) parts.push("*required");
          lines.push(
            <Text key={`a-${method.name}-${name}`} dimColor wrap="truncate-end">
              {"    " + parts.join(" ")}
            </Text>,
          );
        }
      }
    }
  }

  return (
    <Box flexDirection="column" marginLeft={1} width={innerWidth}>
      {lines}
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
