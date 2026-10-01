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

import { renderMarkdownToTerminal } from "../markdown_renderer.ts";

/**
 * Formats a report's markdown as the framed block that log-mode run renderers
 * print after a method or workflow: a `── Report: <name> ───` header rule, the
 * markdown rendered for the terminal, and a closing rule. Both rules span
 * `columns`, so they match each other and the terminal width.
 *
 * Returns `undefined` when the markdown is empty or only whitespace, unless
 * `showEmpty` is set. A report signals "not applicable to this method" that
 * way, and the report execution service skips persisting it, so by default
 * there is nothing to show. Verbose output sets `showEmpty` so a reader can
 * see which reports ran.
 */
export function formatReportFrame(
  reportName: string,
  markdown: string,
  columns: number,
  options: { showEmpty?: boolean } = {},
): string | undefined {
  if (!options.showEmpty && markdown.trim() === "") return undefined;
  const headerPrefix = `── Report: ${reportName} `;
  const header = headerPrefix +
    "─".repeat(Math.max(0, columns - headerPrefix.length));
  const separator = "─".repeat(columns);
  return `${header}\n${
    renderMarkdownToTerminal(markdown, { maxWidth: columns })
  }\n${separator}`;
}
