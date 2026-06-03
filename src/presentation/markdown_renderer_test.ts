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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  renderMarkdownPlain,
  renderMarkdownToTerminal,
  truncateMarkdownTableCells,
} from "./markdown_renderer.ts";

Deno.test("renderMarkdownToTerminal - renders heading", () => {
  const result = renderMarkdownToTerminal("# Hello World");
  // Should contain the text (formatting may vary with NO_COLOR)
  assertStringIncludes(result, "Hello World");
});

Deno.test("renderMarkdownToTerminal - renders bold text", () => {
  const result = renderMarkdownToTerminal("This is **bold** text");
  assertStringIncludes(result, "bold");
});

Deno.test("renderMarkdownToTerminal - renders JSON code blocks without undefined", () => {
  const md = '```json\n{"region": "us-east-1"}\n```';
  const result = renderMarkdownToTerminal(md);
  assertStringIncludes(result, "region");
  assertStringIncludes(result, "us-east-1");
  const lines = result.split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (line.trim() === "undefined") {
      throw new Error(
        "Rendered markdown contains 'undefined' — likely a LogTape placeholder issue",
      );
    }
  }
});

Deno.test("renderMarkdownPlain - returns markdown unchanged", () => {
  const md = "# Hello\n\nSome **bold** text";
  const result = renderMarkdownPlain(md);
  assertStringIncludes(result, "# Hello");
  assertStringIncludes(result, "**bold**");
});

Deno.test("renderMarkdownPlain - applies maxColWidth to table cells", () => {
  const md =
    "| Name | Description |\n| --- | --- |\n| short | This is a very long description that exceeds the limit |";
  const result = renderMarkdownPlain(md, { maxColWidth: 20 });
  assertStringIncludes(result, "…");
  assertStringIncludes(result, "| short |");
});

Deno.test("truncateMarkdownTableCells: truncates wide cells with ellipsis", () => {
  const md =
    "| Name | Value |\n| --- | --- |\n| ok | abcdefghijklmnopqrstuvwxyz |";
  const result = truncateMarkdownTableCells(md, 10);
  assertStringIncludes(result, "abcdefghi…");
  assertStringIncludes(result, "| ok |");
});

Deno.test("truncateMarkdownTableCells: preserves cells within limit", () => {
  const md = "| A | B |\n| --- | --- |\n| short | tiny |";
  const result = truncateMarkdownTableCells(md, 20);
  assertEquals(result, md);
});

Deno.test("truncateMarkdownTableCells: preserves non-table content", () => {
  const md = "# Title\n\nSome paragraph text that is quite long.\n\n- a list";
  const result = truncateMarkdownTableCells(md, 10);
  assertEquals(result, md);
});

Deno.test("truncateMarkdownTableCells: skips separator rows", () => {
  const md = "| A | B |\n| --- | --- |\n| x | y |";
  const result = truncateMarkdownTableCells(md, 5);
  assertStringIncludes(result, "| --- | --- |");
});

Deno.test("truncateMarkdownTableCells: handles pipes in code spans", () => {
  const md = "| Code | Result |\n| --- | --- |\n| `a|b` | ok |";
  const result = truncateMarkdownTableCells(md, 20);
  assertStringIncludes(result, "`a|b`");
});

Deno.test("renderMarkdownToTerminal - applies maxColWidth before rendering", () => {
  const md =
    "| Name | Description |\n| --- | --- |\n| ok | abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz |";
  const result = renderMarkdownToTerminal(md, { maxColWidth: 15 });
  assertStringIncludes(result, "ok");
});

Deno.test("renderMarkdownToTerminal - default behavior unchanged without options", () => {
  const md = "# Test\n\n**bold**";
  const withOpts = renderMarkdownToTerminal(md);
  const withoutOpts = renderMarkdownToTerminal(md, undefined);
  assertEquals(withOpts, withoutOpts);
});
