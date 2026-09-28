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
import fc from "fast-check";
import { highlightJson } from "./json_highlight.ts";

// Removes the highlight tags and decodes the entities escapeHtml adds, which
// recovers exactly what the browser displays as text.
function displayed(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function assertRoundTrips(raw: string): void {
  assertEquals(displayed(highlightJson(raw)), raw);
}

// ── text is never altered ───────────────────────────────────────────────

Deno.test("highlightJson: keeps colons inside timestamps", () => {
  const raw = JSON.stringify(
    { executedAt: "2026-09-28T18:43:51.845Z" },
    null,
    2,
  );
  assertRoundTrips(raw);
  assertStringIncludes(
    highlightJson(raw),
    '<span class="code-string">"2026-09-28T18:43:51.845Z"</span>',
  );
});

Deno.test("highlightJson: keeps colon-digit sequences inside strings", () => {
  assertRoundTrips('{"a": "x:12", "b": ":12"}');
});

Deno.test("highlightJson: keeps URLs with ports intact", () => {
  assertRoundTrips('{"url": "https://x.io:8080/a"}');
});

Deno.test("highlightJson: keeps escaped quotes followed by colons", () => {
  assertRoundTrips(JSON.stringify({ q: 'say "hi": 12', r: '\\"k": 1' }));
});

Deno.test("highlightJson: keeps compact JSON compact", () => {
  assertRoundTrips('{"a":1,"b":"x","c":[true,null]}');
});

Deno.test("highlightJson: escapes HTML-significant characters", () => {
  const raw = '{"<b>": "</pre><script>alert(1)</script> & more"}';
  const html = highlightJson(raw);
  assert(!html.includes("<script>"));
  assert(!html.includes("<b>"));
  assertRoundTrips(raw);
});

Deno.test("highlightJson: passes non-JSON text through unchanged", () => {
  for (const raw of ['abc123 "unterminated', "key: v1.2 x9", "", "  \n"]) {
    assertRoundTrips(raw);
  }
});

// ── token classification ────────────────────────────────────────────────

Deno.test("highlightJson: classes keys and string values separately", () => {
  assertEquals(
    highlightJson('{"k" : "v"}'),
    '{<span class="code-key">"k"</span> : <span class="code-string">"v"</span>}',
  );
});

Deno.test("highlightJson: highlights scalars inside arrays", () => {
  assertEquals(
    highlightJson("[-1.5e3,true,false,null]"),
    '[<span class="code-number">-1.5e3</span>,' +
      '<span class="code-boolean">true</span>,' +
      '<span class="code-boolean">false</span>,' +
      '<span class="code-null">null</span>]',
  );
});

Deno.test("highlightJson: never nests spans inside a string", () => {
  const html = highlightJson('{"t": "18:43:51 true null 12"}');
  assertStringIncludes(
    html,
    '<span class="code-string">"18:43:51 true null 12"</span>',
  );
  assertEquals(html.match(/<span/g)?.length, 2);
});

// ── property ────────────────────────────────────────────────────────────

Deno.test("highlightJson: displayed text equals any stringified JSON", () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.boolean(), (value, pretty) => {
      assertRoundTrips(JSON.stringify(value, null, pretty ? 2 : undefined));
    }),
  );
});
