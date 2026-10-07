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
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { quoteShellWord } from "../../domain/shell_word.ts";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";
import { Table } from "@cliffy/table";
import { bold, dim } from "@std/fmt/colors";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Formats a cell value for a markdown table. Complex values become
 * inline JSON code spans.
 */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    return "`" + JSON.stringify(value) + "`";
  }
  return String(value);
}

/**
 * Builds a markdown table string from column headers and rows.
 */
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
 * Renders the default DataRecord table (no --select).
 *
 * Builds the table directly with Cliffy's Table primitive and returns
 * already-rendered terminal text. The earlier implementation returned
 * markdown that was then parsed by `marked` + `marked-terminal`, which
 * scaled at ~3ms per row — fine for the TUI's bounded result set, fatal
 * for `--limit 100000` on a real catalog.
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

/**
 * Renders projected scalar values.
 */
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

/**
 * Renders projected map values as a markdown table.
 */
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

/**
 * Renders projected list values as a markdown table (no headers).
 */
function renderListTable(
  projected: Extract<ProjectedData, { shape: "list" }>,
): string {
  if (projected.rows.length === 0) {
    return "No matching data found.";
  }

  const maxCols = maxOf(projected.rows.map((r) => r.length)) ?? 0;
  const headers = Array.from({ length: maxCols }, (_, i) => String(i + 1));
  const rows = projected.rows.map((row) => row.map((cell) => formatCell(cell)));

  return markdownTable(headers, rows);
}

/**
 * Renders projected data as markdown based on shape.
 */
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

/**
 * Transforms a DataRecord for JSON output: moves the payload from
 * `attributes` to `content` (matching `data get --json`) and strips
 * the internal `attributes` key.
 */
function recordToJsonOutput(
  record: DataRecord,
): Record<string, unknown> {
  const { attributes, content: _rawContent, ...rest } = record;
  return {
    ...rest,
    content: record.contentType === "application/json" ? attributes : "",
  };
}

/**
 * Renders a single-result query's one match as a bare JSON value: the record
 * (the same object the envelope carries as `results[0]`) or, with `--select`,
 * its projected value.
 */
function renderSingleJson(data: DataQueryData): void {
  let value: unknown;
  if (data.projected) {
    value = data.projected.shape === "scalar"
      ? data.projected.values[0]
      : data.projected.rows[0];
  } else {
    value = recordToJsonOutput(data.results[0]);
  }
  writeOutput(JSON.stringify(value ?? null, null, 2));
}

/**
 * Renders JSON output for the completed event.
 */
function renderJson(data: DataQueryData, single: boolean): void {
  if (single) {
    renderSingleJson(data);
    return;
  }
  if (data.projected) {
    const results = data.projected.shape === "scalar"
      ? data.projected.values
      : data.projected.rows;
    writeOutput(JSON.stringify(
      {
        results,
        total: data.total,
        limited: data.limited,
        ...(data.specNameHint && { specNameHint: data.specNameHint }),
      },
      null,
      2,
    ));
  } else {
    writeOutput(JSON.stringify(
      {
        predicate: data.predicate,
        results: data.results.map(recordToJsonOutput),
        total: data.total,
        limited: data.limited,
        ...(data.specNameHint && { specNameHint: data.specNameHint }),
      },
      null,
      2,
    ));
  }
}

/**
 * Renders query results as a markdown string. Only used for the projected
 * (`--select`) path; the default table path bypasses markdown entirely and
 * builds ANSI output directly via {@link renderQueryResultsTerminal}.
 */
export function renderQueryResultsMarkdown(
  data: DataQueryData,
  showNamespace = false,
): string {
  return data.projected
    ? renderProjected(data)
    : renderDefaultTable(data, showNamespace);
}

/**
 * Renders query results as pre-formatted terminal text. The default
 * (non-projected) path uses Cliffy's Table primitive directly; the
 * projected path still flows through `marked` since its output shapes
 * (scalar/map/list) are easier to express as markdown.
 *
 * Used by both the non-interactive CLI renderer and the interactive TUI.
 * The default-table branch scales linearly in row count; the projected
 * branch is bounded by the markdown parser and should only be used for
 * small result sets.
 */
export function renderQueryResultsTerminal(
  data: DataQueryData,
  showNamespace = false,
): string {
  if (data.projected) {
    return renderMarkdownToTerminal(
      renderQueryResultsMarkdown(data, showNamespace),
    );
  }
  return renderDefaultTable(data, showNamespace);
}

/**
 * Renders the follow-up for a query that matched no instance name but
 * whose spec-name counterpart matches: the reason, then the command to run.
 */
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
  options: { single?: boolean } = {},
): { handlers: () => EventHandlers<DataQueryEvent> } {
  return {
    handlers: () => ({
      resolving: () => {},
      match: () => {},
      projected_match: () => {},
      completed: (event: DataQueryEvent & { kind: "completed" }) => {
        if (outputMode === "json") {
          renderJson(event.data, options.single ?? false);
          return;
        }
        writeOutput(renderQueryResultsTerminal(event.data, showNamespace));
        if (event.data.specNameHint) {
          writeOutput(renderSpecNameHint(event.data.specNameHint));
        }
      },
      error: (event: DataQueryEvent & { kind: "error" }) => {
        throw userErrorFromSwampError(event.error);
      },
    }),
  };
}
