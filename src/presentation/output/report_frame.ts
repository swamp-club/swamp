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
 * undefined for empty markdown unless showEmpty: an empty report means not
 * applicable and is not persisted. Verbose output sets showEmpty so readers see
 * which reports ran.
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
