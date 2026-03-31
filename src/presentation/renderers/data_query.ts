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

import type {
  DataQueryData,
  DataQueryEvent,
  EventHandlers,
  ProjectedData,
} from "../../libswamp/mod.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";

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
 */
function renderDefaultTable(data: DataQueryData): string {
  if (data.results.length === 0) {
    return "No matching data found.";
  }

  const headers = [
    "name",
    "modelName",
    "specName",
    "dataType",
    "version",
    "size",
  ];
  const rows = data.results.map((r) => [
    r.name,
    r.modelName,
    r.specName,
    r.dataType,
    String(r.version),
    formatSize(r.size),
  ]);

  let md = markdownTable(headers, rows);
  if (data.limited) {
    md += `\n\n*Showing ${data.total} results (limit reached)*`;
  } else {
    md += `\n\n${data.total} result${data.total === 1 ? "" : "s"}`;
  }
  return md;
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

  const maxCols = Math.max(...projected.rows.map((r) => r.length));
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
 * Renders JSON output for the completed event.
 */
function renderJson(data: DataQueryData): void {
  if (data.projected) {
    switch (data.projected.shape) {
      case "scalar":
        writeOutput(JSON.stringify(data.projected.values, null, 2));
        break;
      case "map":
        writeOutput(JSON.stringify(data.projected.rows, null, 2));
        break;
      case "list":
        writeOutput(JSON.stringify(data.projected.rows, null, 2));
        break;
    }
  } else {
    writeOutput(JSON.stringify(data, null, 2));
  }
}

export function createDataQueryRenderer(
  outputMode: OutputMode,
): { handlers: () => EventHandlers<DataQueryEvent> } {
  return {
    handlers: () => ({
      resolving: () => {},
      match: () => {},
      projected_match: () => {},
      completed: (event: DataQueryEvent & { kind: "completed" }) => {
        if (outputMode === "json") {
          renderJson(event.data);
        } else {
          const md = event.data.projected
            ? renderProjected(event.data)
            : renderDefaultTable(event.data);
          writeOutput(renderMarkdownToTerminal(md));
        }
      },
      error: (event: DataQueryEvent & { kind: "error" }) => {
        throw new UserError(event.error.message);
      },
    }),
  };
}
