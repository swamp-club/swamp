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
import { findDenoCommandUse } from "./deno_command_detector.ts";

/** Statements with no Deno.Command use, covering regex, division and templates. */
const arbCleanStatement = fc.constantFrom(
  "const a = 1;",
  "let b = a / 2 / c;",
  "const r = /[/`'\"]+/g.test(s);",
  "const t = `x${a + 1}y`;",
  "const v = Deno.env.get(name);",
  'if (typeof Deno !== "undefined") { a(); }',
  "const cmd = new cli.Command();",
  "const o = { Command: 1, Deno: 2 };",
  "type T = { c: Deno.Command };",
  "label: for (const x of xs) { break label; }",
);

// Each statement gets its own block so repeated declarations stay valid.
const arbClean = fc.array(arbCleanStatement.map((s) => `{ ${s} }`), {
  maxLength: 8,
});

/** Text that would use Deno.Command if it were read as code. */
const arbHostileText = fc.oneof(
  fc.string(),
  fc.constantFrom(
    'new Deno.Command("ls")',
    "Deno.Command(",
    'Deno["Command"]',
    "const { Command } = Deno",
    "const d = Deno; new d.Command(x)",
  ),
);

function escapeForString(text: string, quote: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll(quote, `\\${quote}`)
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** Wraps text so that it is inert: a comment or a properly escaped literal. */
const arbInert = fc
  .tuple(
    arbHostileText,
    fc.constantFrom("line", "block", "single", "double", "template"),
  )
  .map(([text, form]) => {
    switch (form) {
      case "line":
        return `// ${text.replace(/[\n\r\u2028\u2029]/g, " ")}\n`;
      case "block":
        return `/* ${text.replaceAll("*/", "* /")} */\n`;
      case "single":
        return `const s = '${escapeForString(text, "'")}';\n`;
      case "double":
        return `const s = "${escapeForString(text, '"')}";\n`;
      default:
        return `const s = \`${
          escapeForString(text, "`").replaceAll("${", "\\${")
        }\`;\n`;
    }
  });

Deno.test("findDenoCommandUse property: never throws on any input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (source) => {
      findDenoCommandUse(source);
    }),
    { numRuns: 2000 },
  );
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "Deno",
          "Command",
          "globalThis",
          ".",
          "?.",
          "[",
          "]",
          "(",
          ")",
          "{",
          "}",
          "=",
          "const ",
          "import ",
          "new ",
          "`",
          "'",
          '"',
          "/",
          "\n",
        ),
        { maxLength: 60 },
      ),
      (parts) => {
        findDenoCommandUse(parts.join(""));
      },
    ),
    { numRuns: 2000 },
  );
});

Deno.test("findDenoCommandUse property: comments and strings are inert", () => {
  fc.assert(
    fc.property(arbClean, arbInert, arbClean, (before, inert, after) => {
      const source = `${before.join("\n")}\n${inert}${after.join("\n")}\n`;
      assertEquals(findDenoCommandUse(source), []);
    }),
    { numRuns: 1000 },
  );
});

Deno.test("findDenoCommandUse property: an inserted construction is found at its line", () => {
  fc.assert(
    fc.property(arbClean, arbClean, (before, after) => {
      const lines = [...before, 'new Deno.Command("ls");', ...after];
      assertEquals(findDenoCommandUse(lines.join("\n")), [
        { line: before.length + 1, column: 10, kind: "command-reference" },
      ]);
    }),
    { numRuns: 1000 },
  );
});
