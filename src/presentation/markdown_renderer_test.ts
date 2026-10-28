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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import {
  LINK_REMOVED,
  renderMarkdownPlain,
  renderMarkdownToTerminal,
  renderUntrustedMarkdownToTerminal,
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

const OSC_8 = "\x1b]8;";

Deno.test("renderUntrustedMarkdownToTerminal: a link shows its target beside its text", () => {
  const result = renderUntrustedMarkdownToTerminal(
    "See [swamp-club.com](https://elsewhere.example/login) now.",
  );
  assertStringIncludes(
    stripAnsiCode(result),
    "swamp-club.com (https://elsewhere.example/login)",
  );
  assert(!result.includes(OSC_8));
});

Deno.test("renderUntrustedMarkdownToTerminal: a link that is not https prints its text and link removed", () => {
  for (
    const href of [
      "javascript:alert(1)",
      "http://swamp-club.com/update",
      "/relative/path",
      "mailto:a@evil.example",
    ]
  ) {
    const result = stripAnsiCode(
      renderUntrustedMarkdownToTerminal(`[click](${href})`),
    );
    assertStringIncludes(result, `click ${LINK_REMOVED}`, href);
    assert(!result.includes(href), href);
  }
});

Deno.test("renderUntrustedMarkdownToTerminal: a bare www or email autolink prints as written", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      "Visit www.swamp-club.com or write to team@swamp-club.com.",
    ),
  );
  assertStringIncludes(
    result,
    "Visit www.swamp-club.com or write to team@swamp-club.com.",
  );
  assert(!result.includes(LINK_REMOVED));
  assert(!result.includes("http://"));
  assert(!result.includes("mailto:"));
});

Deno.test("renderUntrustedMarkdownToTerminal: a bare www autolink with a look-alike host prints as punycode", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      "Visit www.sw\u0430mp-club.com/update now.",
    ),
  );
  assertStringIncludes(result, "Visit www.xn--swmp-club-1yh.com/update now.");
  assert(!result.includes("\u0430"));
});

Deno.test("renderUntrustedMarkdownToTerminal: an email link whose address is not plain ASCII is removed", () => {
  // GFM links only an ASCII bare address, so the written-out form is the one
  // that reaches the renderer with a look-alike host.
  const address = "team@sw\u0430mp-club.com";
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      `Write to [${address}](mailto:${address}).`,
    ),
  );
  assertStringIncludes(result, LINK_REMOVED);
  assert(!result.includes("mailto:"));
});

Deno.test("renderUntrustedMarkdownToTerminal: an http link whose text differs from its target is still removed", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      "[www.swamp-club.com](http://evil.example)",
    ),
  );
  assertStringIncludes(result, `www.swamp-club.com ${LINK_REMOVED}`);
  assert(!result.includes("evil.example"));
});

Deno.test("renderUntrustedMarkdownToTerminal: a look-alike host prints as punycode", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      "[Update](https://sw\u0430mp-club.com/update)",
    ),
  );
  assertStringIncludes(
    result,
    "Update (https://xn--swmp-club-1yh.com/update)",
  );
  assert(!result.includes("\u0430"));
});

Deno.test("renderUntrustedMarkdownToTerminal: a link with a username or password is removed", () => {
  for (
    const md of [
      "<https://swamp-club.com@evil.example>",
      "[x](https://swamp-club.com@evil.example/)",
      "[x](https://u:p@evil.example/)",
    ]
  ) {
    const result = stripAnsiCode(renderUntrustedMarkdownToTerminal(md));
    assertStringIncludes(result, LINK_REMOVED, md);
    assert(!result.includes("evil.example/"), md);
  }
});

Deno.test("renderUntrustedMarkdownToTerminal: a zero-width character in a host never prints", () => {
  const result = renderUntrustedMarkdownToTerminal(
    "[x](https://swamp\u200b-club.com)",
  );
  assert(!result.includes("\u200b"));
});

Deno.test("renderUntrustedMarkdownToTerminal: a reference link follows the same rule", () => {
  const removed = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      "[x][r]\n\n[r]: http://evil.example/a",
    ),
  );
  assertStringIncludes(removed, `x ${LINK_REMOVED}`);
  const kept = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      "[x][r]\n\n[r]: https://sw\u0430mp-club.com/a",
    ),
  );
  assertStringIncludes(kept, "x (https://xn--swmp-club-1yh.com/a)");
});

Deno.test("renderUntrustedMarkdownToTerminal: an autolink with a look-alike host prints as punycode", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal("<https://sw\u0430mp-club.com/a>"),
  );
  assertStringIncludes(result, "https://xn--swmp-club-1yh.com/a");
  assert(!result.includes("\u0430"));
});

Deno.test("renderUntrustedMarkdownToTerminal: an autolink prints its URL once", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal("Go to https://swamp-club.com/lab"),
  );
  assertStringIncludes(result, "https://swamp-club.com/lab");
  assert(!result.includes("(https://swamp-club.com/lab)"));
});

Deno.test("renderUntrustedMarkdownToTerminal: formatted link text keeps its target", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      "[**release notes**](https://x.example/n)",
    ),
  );
  assertStringIncludes(result, "release notes (https://x.example/n)");
});

Deno.test("renderUntrustedMarkdownToTerminal: an image shows its source", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal("![logo](https://x.example/logo.png)"),
  );
  assertStringIncludes(result, "https://x.example/logo.png");
});

Deno.test("renderUntrustedMarkdownToTerminal: an image follows the link rule", () => {
  const removed = stripAnsiCode(
    renderUntrustedMarkdownToTerminal("![logo](http://evil.example/l.png)"),
  );
  assertStringIncludes(removed, LINK_REMOVED);
  assert(!removed.includes("evil.example"));
  const punycode = stripAnsiCode(
    renderUntrustedMarkdownToTerminal(
      "![logo](https://sw\u0430mp-club.com/l.png)",
    ),
  );
  assertStringIncludes(punycode, "https://xn--swmp-club-1yh.com/l.png");
});

Deno.test("renderUntrustedMarkdownToTerminal: wraps to the given width", () => {
  const result = stripAnsiCode(
    renderUntrustedMarkdownToTerminal("word ".repeat(40), { maxWidth: 30 }),
  );
  for (const line of result.split("\n")) {
    assert(line.length <= 30, line);
  }
});
