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
import fc from "fast-check";
import {
  EXPORT_DECLARATION_PATTERNS,
  findExportDeclaration,
} from "./export_declaration.ts";
import { stripCommentsAndStrings } from "./extension_quality_checker.ts";

const MODEL = EXPORT_DECLARATION_PATTERNS.model;

/** Fixture text: a declaration with an arbitrary type, plus noise. */
const arbFixtureBody = fc
  .tuple(
    fc.stringOf(fc.constantFrom(..."abz@/-_.".split("")), {
      minLength: 1,
      maxLength: 12,
    }),
    fc.stringOf(fc.constantFrom(..."ab {}:;=\n".split("")), { maxLength: 20 }),
  )
  .map(([type, noise]) =>
    `export const model = {\n  type: "${type}",\n};${noise}`
  );

/**
 * Code lines holding regex literals whose bodies look like the start of a
 * template or comment, which a tokenizer without regex support misreads.
 */
const arbRegexLine = fc.constantFrom(
  'const esc = (s: string) => s.replace(/[`$"\\\\]/g, "");\n',
  "const slashes = /^\\/*$/;\n",
  "function f(x: string) { return /`/.test(x); }\n",
  "const half = total / 2;\n",
);

/** Wraps fixture text in each literal or comment form TypeScript has. */
const arbWrapped = fc
  .tuple(
    arbFixtureBody,
    fc.constantFrom("template", "block", "double", "single", "line"),
  )
  .map(([body, form]) => {
    switch (form) {
      case "template":
        return `const f = \`${body.replaceAll("`", "")}\`;\n`;
      case "block":
        return `/* ${body.replaceAll("*/", "")} */\n`;
      case "double":
        return `const f = "${
          body.replaceAll('"', "'").replaceAll("\n", "\\n")
        }";\n`;
      case "single":
        return `const f = '${
          body.replaceAll("'", '"').replaceAll("\n", "\\n")
        }';\n`;
      default:
        return body.split("\n").map((l) => `// ${l}`).join("\n") + "\n";
    }
  });

Deno.test("findExportDeclaration: never finds a declaration inside a literal or comment", () => {
  fc.assert(
    fc.property(
      fc.array(arbWrapped, { minLength: 1, maxLength: 4 }),
      (parts) => {
        assertEquals(findExportDeclaration(parts.join(""), MODEL), -1);
      },
    ),
  );
});

Deno.test("findExportDeclaration: finds a real declaration at its raw offset after any fixtures", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(arbWrapped, arbRegexLine), { maxLength: 6 }),
      (parts) => {
        const prefix = parts.join("");
        const source =
          `${prefix}export const model = {\n  type: "@real/model",\n};\n`;
        assertEquals(findExportDeclaration(source, MODEL), prefix.length);
      },
    ),
  );
});

Deno.test("stripCommentsAndStrings: preserves length and line breaks", () => {
  fc.assert(
    fc.property(
      fc.array(arbWrapped, { maxLength: 4 }),
      fc.string(),
      (parts, tail) => {
        const source = parts.join("") + tail;
        const stripped = stripCommentsAndStrings(source);
        assertEquals(stripped.length, source.length);
        assertEquals(stripped.split("\n").length, source.split("\n").length);
      },
    ),
  );
});
