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

import { assert, assertEquals } from "@std/assert";
import { stringify } from "@std/yaml";
import fc from "fast-check";
import { highlightYaml } from "./yaml_highlight.ts";

// Removes the highlight tags and decodes the entities escapeHtml adds, which
// recovers exactly what the browser displays as text.
function displayed(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function assertRoundTrips(raw: string): void {
  assertEquals(displayed(highlightYaml(raw)), raw);
}

// ── text is never altered ───────────────────────────────────────────────

Deno.test("highlightYaml: keeps extra whitespace after a colon", () => {
  assertRoundTrips("count:   12");
  assertEquals(
    highlightYaml("count:   12"),
    '<span class="code-key">count</span>:   <span class="code-number">12</span>',
  );
});

Deno.test("highlightYaml: keeps colons inside quoted and plain values", () => {
  assertRoundTrips("at:  '2026-09-28T18:43:51Z'\nurl: https://x.io:8080/a");
});

Deno.test("highlightYaml: escapes HTML-significant characters", () => {
  const raw = 'k: "</pre><script>alert(1)</script> & more"';
  const html = highlightYaml(raw);
  assert(!html.includes("<script>"));
  assertRoundTrips(raw);
});

Deno.test("highlightYaml: keeps CRLF line endings", () => {
  assertRoundTrips("a: 1\r\nb: true\r\n");
});

// ── token classification ────────────────────────────────────────────────

Deno.test("highlightYaml: highlights sequence items and negatives", () => {
  assertEquals(
    highlightYaml("- -5\n- key: true\n- ~"),
    '- <span class="code-number">-5</span>\n' +
      '- <span class="code-key">key</span>: ' +
      '<span class="code-boolean">true</span>\n' +
      '- <span class="code-null">~</span>',
  );
});

Deno.test("highlightYaml: highlights quoted keys", () => {
  assertEquals(
    highlightYaml('"a: b": 1'),
    '<span class="code-key">"a: b"</span>: <span class="code-number">1</span>',
  );
});

Deno.test("highlightYaml: separates a value from its trailing comment", () => {
  assertEquals(
    highlightYaml("k: 1 # note\ns: 'a # b' # c"),
    '<span class="code-key">k</span>: <span class="code-number">1</span> ' +
      '<span class="code-comment"># note</span>\n' +
      '<span class="code-key">s</span>: ' +
      "<span class=\"code-string\">'a # b'</span> " +
      '<span class="code-comment"># c</span>',
  );
});

Deno.test("highlightYaml: only highlights values that are one whole token", () => {
  assertEquals(
    highlightYaml("t: 12:30\nv: 1.2.3\nw: true story"),
    '<span class="code-key">t</span>: 12:30\n' +
      '<span class="code-key">v</span>: 1.2.3\n' +
      '<span class="code-key">w</span>: true story',
  );
});

Deno.test("highlightYaml: leaves block scalar content unhighlighted", () => {
  const raw = "run: |\n  echo done: 1\n\n  # not a comment\n  x: true\n" +
    "next: null\n- script: >-\n    a: 1\n  b: 2";
  assertRoundTrips(raw);
  assertEquals(
    highlightYaml(raw).split("\n"),
    [
      '<span class="code-key">run</span>: |',
      "  echo done: 1",
      "",
      "  # not a comment",
      "  x: true",
      '<span class="code-key">next</span>: <span class="code-null">null</span>',
      '- <span class="code-key">script</span>: &gt;-',
      "    a: 1",
      '  <span class="code-key">b</span>: <span class="code-number">2</span>',
    ],
  );
});

// ── property ────────────────────────────────────────────────────────────

Deno.test("highlightYaml: displayed text equals any stringified YAML", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      assertRoundTrips(stringify(value));
    }),
  );
});

Deno.test("highlightYaml: displayed text equals any input text", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary" }), (raw) => {
      assertRoundTrips(raw);
    }),
  );
});
