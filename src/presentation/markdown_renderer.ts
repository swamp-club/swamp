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

import { Marked } from "marked";
import TerminalRenderer from "marked-terminal";

const terminalMarked = new Marked();
terminalMarked.setOptions({
  // deno-lint-ignore no-explicit-any
  renderer: new (TerminalRenderer as any)(),
});

export interface WidthOptions {
  maxWidth?: number;
  maxColWidth?: number;
}

export function renderMarkdownToTerminal(
  markdown: string,
  options?: WidthOptions,
): string {
  let md = markdown;
  if (options?.maxColWidth) {
    md = truncateMarkdownTableCells(md, options.maxColWidth);
  }

  if (options?.maxWidth) {
    const widthMarked = new Marked();
    widthMarked.setOptions({
      // deno-lint-ignore no-explicit-any
      renderer: new (TerminalRenderer as any)({
        width: options.maxWidth,
        reflowText: true,
        tableOptions: { wordWrap: true },
      }),
    });
    const result = widthMarked.parse(md);
    if (typeof result === "string") {
      return result;
    }
    return md;
  }

  const result = terminalMarked.parse(md);
  if (typeof result === "string") {
    return result;
  }
  return md;
}

export function renderMarkdownPlain(
  markdown: string,
  options?: WidthOptions,
): string {
  if (options?.maxColWidth) {
    return truncateMarkdownTableCells(markdown, options.maxColWidth);
  }
  return markdown;
}

const TABLE_SEPARATOR_RE = /^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?\s*$/;

export function truncateMarkdownTableCells(
  markdown: string,
  maxColWidth: number,
): string {
  const lines = markdown.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed.startsWith("|") ||
      TABLE_SEPARATOR_RE.test(trimmed)
    ) {
      result.push(line);
      continue;
    }

    const cells = splitTableRow(trimmed);
    const truncated = cells.map((cell) => {
      const stripped = cell.trim();
      if (stripped.length <= maxColWidth) return cell;
      return " " + stripped.slice(0, maxColWidth - 1) + "…" + " ";
    });
    result.push("|" + truncated.join("|") + "|");
  }

  return result.join("\n");
}

function splitTableRow(row: string): string[] {
  let inner = row;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let inCode = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "`") {
      inCode = !inCode;
      current += ch;
    } else if (ch === "\\" && i + 1 < inner.length) {
      current += ch + inner[i + 1];
      i++;
    } else if (ch === "|" && !inCode) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
