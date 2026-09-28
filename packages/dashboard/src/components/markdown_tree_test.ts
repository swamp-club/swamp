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

import { assertEquals } from "@std/assert";
import {
  decodeEntities,
  type MdBlock,
  parseMarkdown,
  safeHref,
} from "./markdown_tree.ts";

const BASE = "https://ops.example.com/dashboard/models/m/data/d";

/** Every string in the tree, to check nothing executable survives as markup. */
function collectTypes(nodes: unknown): string[] {
  const types: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.type === "string") types.push(record.type);
      Object.values(record).forEach(walk);
    }
  };
  walk(nodes);
  return types;
}

Deno.test("parseMarkdown: raw html is kept as text, never markup", () => {
  const tree = parseMarkdown(
    '<script>alert(1)</script>\n\nhi <img src=x onerror="alert(1)">',
    BASE,
  );
  assertEquals(tree[0], { type: "text", text: "<script>alert(1)</script>" });
  assertEquals(tree[1], {
    type: "paragraph",
    children: [
      { type: "text", text: "hi " },
      { type: "text", text: '<img src=x onerror="alert(1)">' },
    ],
  });
});

Deno.test("parseMarkdown: javascript and data links render as plain text", () => {
  for (
    const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
    ]
  ) {
    const tree = parseMarkdown(`[click](${href})`, BASE);
    assertEquals(
      collectTypes(tree).includes("link"),
      false,
      `${href} must not become a link`,
    );
  }
});

Deno.test("parseMarkdown: images are never loaded, only linked by alt text", () => {
  const tree = parseMarkdown("![diagram](https://tracker.example/p.png)", BASE);
  assertEquals(tree, [{
    type: "paragraph",
    children: [{
      type: "link",
      href: "https://tracker.example/p.png",
      external: true,
      children: [{ type: "text", text: "diagram" }],
    }],
  }]);
  assertEquals(collectTypes(tree).includes("image"), false);
});

Deno.test("safeHref: allows http, https and mailto only", () => {
  assertEquals(safeHref("https://a.example/x", BASE), {
    href: "https://a.example/x",
    external: true,
  });
  assertEquals(safeHref("mailto:ops@example.com", BASE)?.external, true);
  assertEquals(safeHref("javascript:alert(1)", BASE), null);
  assertEquals(safeHref(" javascript:alert(1)", BASE), null);
  assertEquals(safeHref("java\tscript:alert(1)", BASE), null);
  assertEquals(safeHref("java\nscript:alert(1)", BASE), null);
  assertEquals(safeHref("http://[bad", BASE), null);
});

Deno.test("safeHref: relative links resolve against the page and stay internal", () => {
  assertEquals(safeHref("../other", BASE), {
    href: "https://ops.example.com/dashboard/models/m/other",
    external: false,
  });
});

Deno.test("safeHref: protocol-relative links resolve to their own host", () => {
  assertEquals(safeHref("//evil.example/x", BASE), {
    href: "https://evil.example/x",
    external: true,
  });
});

Deno.test("parseMarkdown: inline text and code spans show < & and quotes literally", () => {
  const tree = parseMarkdown('run `a < b && echo "hi"` then x & y < z', BASE);
  assertEquals(tree, [{
    type: "paragraph",
    children: [
      { type: "text", text: "run " },
      { type: "codespan", text: 'a < b && echo "hi"' },
      { type: "text", text: " then x & y < z" },
    ],
  }]);
});

Deno.test("parseMarkdown: fenced code keeps its text verbatim", () => {
  const tree = parseMarkdown('```json\n{"a": "&amp; <x>"}\n```', BASE);
  assertEquals(tree, [{
    type: "code",
    lang: "json",
    text: '{"a": "&amp; <x>"}',
  }]);
});

Deno.test("parseMarkdown: GFM tables keep alignment and decode cells", () => {
  const tree = parseMarkdown(
    "| Step | Status |\n|:-----|-------:|\n| `a&b` | x<y |",
    BASE,
  );
  assertEquals(tree, [{
    type: "table",
    align: ["left", "right"],
    header: [
      [{ type: "text", text: "Step" }],
      [{ type: "text", text: "Status" }],
    ],
    rows: [[
      [{ type: "codespan", text: "a&b" }],
      [{ type: "text", text: "x<y" }],
    ]],
  }]);
});

Deno.test("parseMarkdown: task lists and ordered starts", () => {
  const tree = parseMarkdown(
    "- [x] done\n- [ ] todo\n\n3. third\n4. fourth",
    BASE,
  );
  const expected: MdBlock[] = [
    {
      type: "list",
      ordered: false,
      items: [
        {
          checked: true,
          children: [{
            type: "paragraph",
            children: [{ type: "text", text: "done" }],
          }],
        },
        {
          checked: false,
          children: [{
            type: "paragraph",
            children: [{ type: "text", text: "todo" }],
          }],
        },
      ],
    },
    {
      type: "list",
      ordered: true,
      start: 3,
      items: [
        {
          children: [{
            type: "paragraph",
            children: [{ type: "text", text: "third" }],
          }],
        },
        {
          children: [{
            type: "paragraph",
            children: [{ type: "text", text: "fourth" }],
          }],
        },
      ],
    },
  ];
  assertEquals(tree, expected);
});

Deno.test("parseMarkdown: headings, emphasis, quotes and rules", () => {
  const tree = parseMarkdown(
    "## Result **ok** _now_ ~~old~~\n\n> quoted\n\n---",
    BASE,
  );
  assertEquals(tree, [
    {
      type: "heading",
      depth: 2,
      children: [
        { type: "text", text: "Result " },
        { type: "strong", children: [{ type: "text", text: "ok" }] },
        { type: "text", text: " " },
        { type: "em", children: [{ type: "text", text: "now" }] },
        { type: "text", text: " " },
        { type: "del", children: [{ type: "text", text: "old" }] },
      ],
    },
    {
      type: "blockquote",
      children: [{
        type: "paragraph",
        children: [{ type: "text", text: "quoted" }],
      }],
    },
    { type: "hr" },
  ]);
});

Deno.test("decodeEntities: decodes only marked's escapes, once", () => {
  assertEquals(
    decodeEntities("&amp;lt; &lt;b&gt; &quot;&#39;"),
    "&lt; <b> \"'",
  );
});
