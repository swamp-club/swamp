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
  ModelGetData,
  ModelSearchData,
  ModelSearchEvent,
  ModelSearchItem,
} from "../../libswamp/mod.ts";
import type { SearchRenderer } from "./search_renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import {
  type PickerResult,
  renderInteractivePicker,
} from "./components/search_picker.tsx";
import {
  formatMethodLines,
  formatSchemaAttributes,
  formatSchemaType,
} from "./model_get.ts";

const INDENT_2 = "  ";
const INDENT_4 = "    ";

/**
 * Filters models by a query string (case-insensitive match on name, type, or id).
 */
export function filterModels(
  models: ModelSearchItem[],
  query: string,
): ModelSearchItem[] {
  if (!query) return models;
  const lowerQuery = query.toLowerCase();
  return models.filter(
    (m) =>
      m.name.toLowerCase().includes(lowerQuery) ||
      m.type.toLowerCase().includes(lowerQuery) ||
      m.id.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Callback type for fetching model detail data for the preview pane.
 */
export type ModelPreviewFetcher = (
  item: ModelSearchItem,
) => Promise<ModelGetData>;

export type ModelSearchRenderer = SearchRenderer<
  ModelSearchEvent,
  ModelSearchItem
>;

class JsonModelSearchRenderer implements ModelSearchRenderer {
  private _selected: ModelSearchItem | undefined;

  selectedItem(): ModelSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ModelSearchEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const filtered = filterModels(e.data.results, e.data.query);
        // Auto-select when query matches exactly one model
        if (e.data.query && filtered.length === 1) {
          this._selected = filtered[0];
        } else {
          const output: ModelSearchData = {
            query: e.data.query,
            results: filtered,
          };
          console.log(JSON.stringify(output, null, 2));
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class InkModelSearchRenderer implements ModelSearchRenderer {
  private _selected: ModelSearchItem | undefined;
  private readonly fetchPreview: ModelPreviewFetcher | undefined;

  constructor(fetchPreview?: ModelPreviewFetcher) {
    this.fetchPreview = fetchPreview;
  }

  selectedItem(): ModelSearchItem | undefined {
    return this._selected;
  }

  handlers(): EventHandlers<ModelSearchEvent> {
    return {
      resolving: () => {},
      completed: async (e) => {
        const result = await renderInteractivePicker<
          ModelSearchItem,
          ModelGetData
        >(
          e.data.results,
          e.data.query,
          (item) => `${item.name} ${item.type} ${item.id}`,
          renderModelResultLine,
          renderModelPreview,
          renderModelScrollback,
          "models",
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

/**
 * Creates a model search renderer for the given output mode.
 *
 * @param mode - Output mode (log for interactive, json for machine-readable).
 * @param fetchPreview - Optional callback to fetch model detail for the preview
 *   pane. When provided, the picker shows full method/argument detail. When
 *   omitted, only the model name and type are shown in the preview.
 */
export function createModelSearchRenderer(
  mode: OutputMode,
  fetchPreview?: ModelPreviewFetcher,
): ModelSearchRenderer {
  switch (mode) {
    case "json":
      return new JsonModelSearchRenderer();
    case "log":
      return new InkModelSearchRenderer(fetchPreview);
  }
}

// ---------------------------------------------------------------------------
// Rendering callbacks for the SearchPicker
// ---------------------------------------------------------------------------

/** Single-line result for the results list. */
function renderModelResultLine(item: ModelSearchItem): React.ReactElement {
  return (
    <Text>
      {item.name} <Text dimColor>({item.type})</Text>
    </Text>
  );
}

/**
 * Renders preview content for a model. Shows immediate metadata from the search
 * item, and when detail is available, shows methods with argument signatures.
 */
function renderModelPreview(
  item: ModelSearchItem,
  detail: ModelGetData | undefined,
  _width: number,
  _height: number,
): React.ReactElement {
  if (!detail) {
    // Immediate content from the search item
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>{item.name}</Text>
        <Text dimColor>type: {item.type}</Text>
      </Box>
    );
  }

  // Full detail from fetchPreview
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>{detail.name}</Text>
      <Text dimColor>type: {detail.type}</Text>
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
              {method.dataOutputSpecs && method.dataOutputSpecs.length > 0 && (
                <Box flexDirection="column" marginLeft={2}>
                  <Text color="cyan">Data Outputs:</Text>
                  {method.dataOutputSpecs.map((spec) => (
                    <Text key={spec.specName} dimColor>
                      {INDENT_2}
                      {spec.specName} [{spec.kind}]
                      {spec.description ? ` - ${spec.description}` : ""}
                    </Text>
                  ))}
                </Box>
              )}
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
      { type?: string | string[]; enum?: string[]; description?: string }
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
      {entries.map(([name, prop]) => {
        const formatted = formatSchemaType(prop.type);
        return (
          <Text key={name}>
            {INDENT_4}
            {name}
            {formatted ? <Text dimColor>({formatted})</Text> : null}
            {prop.enum ? <Text dimColor>[{prop.enum.join(", ")}]</Text> : null}
            {required.has(name) ? <Text dimColor>*required</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Produces plain-text scrollback output for a selected model.
 * Reuses the same formatMethodLines/formatSchemaAttributes from model_get.ts.
 */
function renderModelScrollback(
  item: ModelSearchItem,
  detail: ModelGetData | undefined,
): string {
  if (!detail) {
    return `${item.name} (${item.type})`;
  }

  const lines: string[] = [
    `${detail.name} (${detail.type}) v${detail.version}`,
  ];

  if (detail.methods && detail.methods.length > 0) {
    lines.push("");
    lines.push("Methods:");
    lines.push(...formatMethodLines(detail.methods));
  }

  if (detail.globalArgumentsSchema) {
    const schemaAttrs = formatSchemaAttributes(
      detail.globalArgumentsSchema,
      "  ",
    );
    if (schemaAttrs.length > 0) {
      lines.push("");
      lines.push("Global Arguments Schema:");
      lines.push(...schemaAttrs);
    }
  }

  return lines.join("\n");
}

// Re-export PickerResult for use by the command handler
export type { PickerResult };
