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

import { Marked } from "marked";
import TerminalRenderer from "marked-terminal";

const terminalMarked = new Marked();
terminalMarked.setOptions({
  // deno-lint-ignore no-explicit-any
  renderer: new (TerminalRenderer as any)(),
});

/**
 * Renders markdown to terminal-formatted text with syntax highlighting.
 * chalk (used by marked-terminal) auto-respects NO_COLOR env var.
 */
export function renderMarkdownToTerminal(markdown: string): string {
  const result = terminalMarked.parse(markdown);
  if (typeof result === "string") {
    return result;
  }
  // marked can return a Promise when async extensions are used, but
  // we don't use any, so this should always be sync.
  return markdown;
}

/**
 * Returns markdown as-is (plain text fallback).
 */
export function renderMarkdownPlain(markdown: string): string {
  return markdown;
}
