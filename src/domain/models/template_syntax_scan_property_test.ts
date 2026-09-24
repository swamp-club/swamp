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
import fc from "fast-check";
import { scanTemplateSyntax } from "./template_syntax_scan.ts";

/**
 * Strings built from template-like fragments, so matches, near-matches and
 * unparseable inner text are common rather than rare.
 */
const arbTemplateText = fc.oneof(
  fc.array(
    fc.constantFrom(
      "{{",
      "}}",
      "{{{",
      "${",
      "${{",
      "{",
      "}",
      "$",
      "#",
      "/",
      ".",
      " ",
      "'",
      '"',
      "(",
      ")",
      "-",
      "|",
      "host",
      "self",
      "env",
      "inputs",
      "model",
      "value",
      "is_alert",
      "1",
    ),
    { maxLength: 24 },
  ).map((parts) => parts.join("")),
  fc.string(),
  fc.unicodeString(),
);

const FIELDS = [
  "globalArguments.a",
  "globalArguments.b",
  "methods.m.arguments.c",
] as const;

Deno.test("scanTemplateSyntax: never throws, and every finding is text from the value", () => {
  fc.assert(
    fc.property(arbTemplateText, (value) => {
      const scan = scanTemplateSyntax({ v: value }, {
        declaredInputs: new Set(["env"]),
      });
      for (const finding of [...scan.malformed, ...scan.foreign]) {
        assertEquals(finding.path, "v");
        assert(value.includes(finding.text));
      }
    }),
    { numRuns: 500 },
  );
});

Deno.test("scanTemplateSyntax: reports only broken expressions at or below a declared foreign template path", () => {
  fc.assert(
    fc.property(
      arbTemplateText,
      arbTemplateText,
      arbTemplateText,
      fc.subarray([...FIELDS]),
      (a, b, c, declared) => {
        const scan = scanTemplateSyntax({
          globalArguments: { a, b: { nested: b } },
          methods: { m: { arguments: { c: [c] } } },
        }, {
          declaredInputs: new Set(),
          isDeclaredForeign: (path) =>
            declared.some((d) =>
              path === d || path.startsWith(`${d}.`) ||
              path.startsWith(`${d}[`)
            ),
        });
        const reportable = [
          ...scan.malformed.filter((f) =>
            f.form !== "inside-expression" && f.form !== "unclosed-expression"
          ),
          ...scan.foreign,
        ];
        for (const finding of reportable) {
          assert(
            !declared.some((d) =>
              finding.path === d || finding.path.startsWith(`${d}.`) ||
              finding.path.startsWith(`${d}[`)
            ),
            `reported declared path ${finding.path}`,
          );
        }
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("scanTemplateSyntax: text with no ${{ has no unclosed expression", () => {
  fc.assert(
    fc.property(arbTemplateText, (value) => {
      fc.pre(!value.includes("${{"));
      const scan = scanTemplateSyntax({ v: value }, {
        declaredInputs: new Set(),
      });
      assertEquals(
        scan.malformed.filter((f) => f.form === "unclosed-expression"),
        [],
      );
    }),
    { numRuns: 300 },
  );
});

/** Expressions that parse, some holding braces inside a CEL string. */
const arbSoundExpression = fc.constantFrom(
  "${{ self.name }}",
  "${{ '{{' }}",
  "${{ '{' + '{host.name}' + '}' }}",
  "${{ {'a': {'b': 1} } }}",
  "${{ model.web-1a.resource.state.main.attributes.id }}",
  '${{ "${HOME}" }}',
);

/** Foreign text with no `$`, so it can never open or extend an expression. */
const arbForeignText = fc.array(
  fc.constantFrom("{{", "}}", "{", "}", " ", "'", '"', "host.name", "\n"),
  { maxLength: 8 },
).map((parts) => parts.join(""));

Deno.test("scanTemplateSyntax: expressions that parse are never reported as broken", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(arbForeignText, arbSoundExpression), { maxLength: 4 }),
      arbForeignText,
      (pairs, tail) => {
        const value = pairs.map(([text, expr]) => text + expr).join("") + tail;
        const scan = scanTemplateSyntax({ v: value }, {
          declaredInputs: new Set(),
          isDeclaredForeign: () => true,
        });
        assertEquals(scan.malformed, [], value);
      },
    ),
    { numRuns: 300 },
  );
});
