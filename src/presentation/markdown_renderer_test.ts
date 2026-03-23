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

import { assertStringIncludes } from "@std/assert";
import {
  renderMarkdownPlain,
  renderMarkdownToTerminal,
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
