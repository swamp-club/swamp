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
import { findDynamicCodeExecution } from "./dynamic_code_detector.ts";

/** Statements with no dynamic code, covering regex, division and templates. */
const arbCleanStatement = fc.constantFrom(
  "const a = 1;",
  "let b = a / 2 / c;",
  "const r = /[/`'\"]+/g.test(s);",
  "const t = `x${a + 1}y`;",
  "function f(cb: Function): number { return cb.length; }",
  "class C { eval(n: number): number { return n; } }",
  "const o = { eval(x) { return x; }, key: { nested: [1, 2] } };",
  "if (a) { b(); } else { c(); }",
  "type T = { eval(n: Node): Value };",
  "label: for (const x of xs) { break label; }",
  "const q = c ? { a: 1 } : [2];",
);

// Each statement gets its own block so repeated declarations stay valid.
const arbClean = fc.array(arbCleanStatement.map((s) => `{ ${s} }`), {
  maxLength: 8,
});

/** Text that would be dynamic code if it were read as code. */
const arbHostileText = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "eval(x)",
    "new Function('a')",
    "globalThis.eval(x)",
    "(0, eval)(x)",
    "Function('a')",
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

/** Identifiers that are not global-object names. */
const arbObjectName = fc
  .stringMatching(/^[a-z_$][a-zA-Z0-9_$]{0,10}$/)
  .filter((name) =>
    ![
      "globalThis",
      "window",
      "self",
      "global",
      "frames",
      "parent",
      "top",
    ].includes(name)
  );

Deno.test("findDynamicCodeExecution property: never throws on any input", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (source) => {
      findDynamicCodeExecution(source);
    }),
    { numRuns: 2000 },
  );
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "`",
          "${",
          "}",
          "{",
          "(",
          ")",
          "[",
          "]",
          "/",
          "*",
          "'",
          '"',
          "\\",
          "\\u",
          "\n",
          "eval",
          ".",
          ":",
          "?",
          "=",
          "class",
          "type",
          "#",
        ),
        { maxLength: 60 },
      ),
      (parts) => {
        findDynamicCodeExecution(parts.join(""));
      },
    ),
    { numRuns: 2000 },
  );
});

Deno.test("findDynamicCodeExecution property: comments and strings are inert", () => {
  fc.assert(
    fc.property(arbClean, arbInert, arbClean, (before, inert, after) => {
      const source = `${before.join("\n")}\n${inert}${after.join("\n")}\n`;
      assertEquals(findDynamicCodeExecution(source), []);
    }),
    { numRuns: 1000 },
  );
});

Deno.test("findDynamicCodeExecution property: members named eval are always flagged", () => {
  fc.assert(
    fc.property(
      arbObjectName,
      fc.array(arbObjectName, { maxLength: 3 }),
      fc.boolean(),
      (object, args, optional) => {
        const source = `${object}${optional ? "?." : "."}eval(${
          args.join(", ")
        });`;
        const kinds = findDynamicCodeExecution(source).map((f) => f.kind);
        assertEquals(kinds, ["eval-member"]);
      },
    ),
    { numRuns: 1000 },
  );
});

Deno.test("findDynamicCodeExecution property: an inserted eval call is found at its line", () => {
  fc.assert(
    fc.property(arbClean, arbClean, (before, after) => {
      const lines = [...before, "eval(x);", ...after];
      const findings = findDynamicCodeExecution(lines.join("\n"));
      assertEquals(findings, [
        { line: before.length + 1, column: 1, kind: "eval-reference" },
      ]);
    }),
    { numRuns: 1000 },
  );
});
