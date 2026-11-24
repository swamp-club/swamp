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

import type {
  DataQueryData,
  DataQueryEvent,
  ProjectedData,
  SpecNameHint,
} from "../../libswamp/data/query.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type { OutputMode } from "../output/output.ts";
import { maxOf } from "../../domain/array_extrema.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";
import {
  prettyJsonChunks,
  type Sink,
  withNewline,
  writeJsonValue,
  writeTextChunks,
} from "../output/json_stream.ts";
import { Table } from "@cliffy/table";
import { bold, dim } from "@std/fmt/colors";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    return "`" + JSON.stringify(value) + "`";
  }
  return String(value);
}

function markdownTable(
  headers: string[],
  rows: string[][],
): string {
  const lines: string[] = [];
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("| " + headers.map(() => "---").join(" | ") + " |");
  for (const row of rows) {
    lines.push("| " + row.join(" | ") + " |");
  }
  return lines.join("\n");
}

/**
 * builds the table directly with Cliffy's Table: rendering markdown through
 * marked scales too poorly per row for a large --limit.
 */
function renderDefaultTable(
  data: DataQueryData,
  showNamespace = false,
): string {
  if (data.results.length === 0) {
    return "No matching data found.";
  }

  const hasNamespace = showNamespace &&
    data.results.some((r) => r.namespace !== "");

  const headers = hasNamespace
    ? [
      "namespace",
      "name",
      "modelName",
      "specName",
      "dataType",
      "version",
      "size",
    ]
    : ["name", "modelName", "specName", "dataType", "version", "size"];

  const rows = data.results.map((r) => {
    const base = [
      r.name,
      r.modelName,
      r.specName,
      r.dataType,
      String(r.version),
      formatSize(r.size),
    ];
    return hasNamespace ? [r.namespace, ...base] : base;
  });

  const table = new Table()
    .header(headers.map((h) => bold(h)))
    .body(rows)
    .border(true)
    .padding(1);

  let out = table.toString();
  if (data.limited) {
    out += `\n\nShowing ${data.total} results (limit reached)`;
  } else {
    out += `\n\n${data.total} result${data.total === 1 ? "" : "s"}`;
  }
  return out;
}

function renderScalars(
  projected: Extract<ProjectedData, { shape: "scalar" }>,
): string {
  return projected.values.map((v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      return "```json\n" + JSON.stringify(v, null, 2) + "\n```";
    }
    return String(v);
  }).join("\n");
}

function renderMapTable(
  projected: Extract<ProjectedData, { shape: "map" }>,
): string {
  if (projected.rows.length === 0) {
    return "No matching data found.";
  }

  const rows = projected.rows.map((row) =>
    projected.columns.map((col) => formatCell(row[col]))
  );

  return markdownTable(projected.columns, rows);
}

function renderListTable(
  projected: Extract<ProjectedData, { shape: "list" }>,
): string {
  if (projected.rows.length === 0) {
    return "No matching data found.";
  }

  // a failed projection arrives as null, and the shape is classified from the
  // first non-null value only, so a row need not be an array
  const cells = projected.rows.map((row: unknown) =>
    Array.isArray(row) ? row : row === null || row === undefined ? [] : [row]
  );
  const maxCols = maxOf(cells.map((r) => r.length)) ?? 0;
  const headers = Array.from({ length: maxCols }, (_, i) => String(i + 1));
  const rows = cells.map((row) => row.map((cell) => formatCell(cell)));

  return markdownTable(headers, rows);
}

function renderProjected(data: DataQueryData): string {
  if (!data.projected) {
    return "No matching data found.";
  }

  let md: string;
  switch (data.projected.shape) {
    case "scalar":
      md = renderScalars(data.projected);
      break;
    case "map":
      md = renderMapTable(data.projected);
      break;
    case "list":
      md = renderListTable(data.projected);
      break;
  }

  if (data.limited) {
    md += `\n\n*Showing ${data.total} results (limit reached)*`;
  }
  return md;
}

function recordToJsonOutput(
  record: DataRecord,
): Record<string, unknown> {
  const { attributes, content: _rawContent, ...rest } = record;
  return {
    ...rest,
    content: record.contentType === "application/json" ? attributes : "",
  };
}

function singleJsonValue(data: DataQueryData): unknown {
  if (data.projected) {
    const value = data.projected.shape === "scalar"
      ? data.projected.values[0]
      : data.projected.rows[0];
    return value ?? null;
  }
  return recordToJsonOutput(data.results[0]) ?? null;
}

function jsonEnvelope(data: DataQueryData): Record<string, unknown> {
  const tail = {
    total: data.total,
    limited: data.limited,
    ...(data.specNameHint && { specNameHint: data.specNameHint }),
    ...(data.nextCursor && { nextCursor: data.nextCursor }),
  };
  if (data.projected) {
    const results = data.projected.shape === "scalar"
      ? data.projected.values
      : data.projected.rows;
    return { results, ...tail };
  }
  return {
    predicate: data.predicate,
    results: data.results.map(recordToJsonOutput),
    ...tail,
  };
}

// written in pieces: the selected content of many records can pass V8's
// maximum string length
async function renderJson(
  data: DataQueryData,
  single: boolean,
  sink: Sink | undefined,
): Promise<void> {
  await writeJsonValue(
    single ? singleJsonValue(data) : jsonEnvelope(data),
    sink,
  );
}

export function renderQueryResultsMarkdown(
  data: DataQueryData,
  showNamespace = false,
): string {
  return data.projected
    ? renderProjected(data)
    : renderDefaultTable(data, showNamespace);
}

function isNested(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

// longer than a table can lay out; marked overflows its stack on such a line
const MAX_TABLE_CELL_CHARS = 1024 * 1024;

function fitsTable(cell: unknown): boolean {
  return !isNested(cell) &&
    !(typeof cell === "string" && cell.length > MAX_TABLE_CELL_CHARS);
}

function rowsFitTable(
  projected: Extract<ProjectedData, { shape: "map" | "list" }>,
): boolean {
  for (const row of projected.rows) {
    if (row == null) continue;
    // a list row that is not an array is one cell, but a map row that is not a
    // record fits no column; Object.values would list a string's characters
    if (typeof row !== "object") {
      if (projected.shape === "map" || !fitsTable(row)) return false;
      continue;
    }
    const cells = Array.isArray(row) ? row : Object.values(row);
    for (const cell of cells) {
      if (!fitsTable(cell)) return false;
    }
  }
  return true;
}

/**
 * projected values are data, not markdown: marked would restyle markdown syntax
 * in the content and overflows its stack on a multi-megabyte line
 */
function* valuesPlainChunks(
  values: readonly unknown[],
  data: DataQueryData,
  separator = "\n",
): Generator<string> {
  for (let i = 0; i < values.length; i++) {
    if (i > 0) yield separator;
    const v = values[i];
    if (v === null || v === undefined) continue;
    if (typeof v === "object") yield* prettyJsonChunks(v);
    else yield String(v);
  }
  if (data.limited) {
    yield `\n\nShowing ${data.total} results (limit reached)`;
  }
}

/**
 * the pieces of renderQueryResultsTerminal, so plain values too large to join
 * into one string still print
 */
function* queryResultsTerminalChunks(
  data: DataQueryData,
  showNamespace: boolean,
): Generator<string> {
  if (data.projected?.shape === "scalar") {
    yield* valuesPlainChunks(data.projected.values, data);
    return;
  }
  // one cell a table cannot hold makes the whole result plain values: a table is
  // as wide as its widest cell, and a half-table listing reads worse than either
  if (data.projected && !rowsFitTable(data.projected)) {
    yield* valuesPlainChunks(data.projected.rows, data, "\n\n");
    return;
  }
  if (data.projected) {
    yield renderMarkdownToTerminal(
      renderQueryResultsMarkdown(data, showNamespace),
    );
    return;
  }
  yield renderDefaultTable(data, showNamespace);
}

/**
 * the default table scales linearly in rows; the flat map/list table is bounded
 * by the markdown parser, so it suits only small result sets
 */
export function renderQueryResultsTerminal(
  data: DataQueryData,
  showNamespace = false,
): string {
  return [...queryResultsTerminalChunks(data, showNamespace)].join("");
}

function renderSpecNameHint(hint: SpecNameHint): string {
  const lines = [
    "",
    "No data matched that instance name, but data with that spec name exists. Query it with:",
    `  swamp data query ${quoteShellWord(hint.suggestedPredicate)}`,
  ];
  if (hint.otherFiltersDropped) {
    lines.push(
      dim("  (some conditions from your query were not carried over)"),
    );
  }
  return lines.join("\n");
}

export function createDataQueryRenderer(
  outputMode: OutputMode,
  showNamespace = false,
  options: { single?: boolean; sink?: Sink } = {},
): { handlers: () => EventHandlers<DataQueryEvent> } {
  return {
    handlers: () => ({
      resolving: () => {},
      match: () => {},
      projected_match: () => {},
      completed: async (event: DataQueryEvent & { kind: "completed" }) => {
        if (outputMode === "json") {
          await renderJson(event.data, options.single ?? false, options.sink);
          return;
        }
        await writeTextChunks(
          withNewline(queryResultsTerminalChunks(event.data, showNamespace)),
          options.sink,
        );
        const trailer: string[] = [];
        if (event.data.specNameHint) {
          trailer.push(renderSpecNameHint(event.data.specNameHint), "\n");
        }
        if (event.data.nextCursor) {
          trailer.push(
            `\nNext page: re-run with --cursor ${event.data.nextCursor}\n`,
          );
        }
        await writeTextChunks(trailer, options.sink);
      },
      error: (event: DataQueryEvent & { kind: "error" }) => {
        throw userErrorFromSwampError(event.error);
      },
    }),
  };
}
