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

import { assertEquals } from "@std/assert";
import { parseRippleContent, RIPPLE_TEMPLATE } from "./issue_ripple.ts";

Deno.test("parseRippleContent: returns null for empty content", () => {
  assertEquals(parseRippleContent(""), null);
  assertEquals(parseRippleContent("   \n  \t\n"), null);
});

Deno.test("parseRippleContent: returns null when only the template remains", () => {
  assertEquals(parseRippleContent(RIPPLE_TEMPLATE), null);
});

Deno.test("parseRippleContent: returns null when only HTML comments remain", () => {
  const content = `<!-- one comment -->
<!-- another -->
   <!-- and another -->
`;
  assertEquals(parseRippleContent(content), null);
});

Deno.test("parseRippleContent: strips HTML comment lines and returns trimmed content", () => {
  const content = `<!-- hint -->
This is the actual ripple body.
<!-- another comment -->

It can have multiple lines.
`;
  assertEquals(
    parseRippleContent(content),
    "This is the actual ripple body.\n\nIt can have multiple lines.",
  );
});

Deno.test("parseRippleContent: preserves inline HTML comments within content lines", () => {
  // The filter only matches lines that are entirely an HTML comment;
  // inline `<!-- ... -->` within prose stays untouched.
  const content = `Here is some <!-- inline --> content.
`;
  assertEquals(
    parseRippleContent(content),
    "Here is some <!-- inline --> content.",
  );
});

Deno.test("parseRippleContent: preserves markdown formatting", () => {
  const content = `<!-- hint -->
# Heading

- bullet 1
- bullet 2

\`\`\`ts
const x = 1;
\`\`\`
`;
  const parsed = parseRippleContent(content);
  assertEquals(
    parsed,
    "# Heading\n\n- bullet 1\n- bullet 2\n\n```ts\nconst x = 1;\n```",
  );
});
