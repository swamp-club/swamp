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
import { parsesAsCel } from "./cel_grammar.ts";
import { scanExpressions, type ScanWork } from "./expression_scanner.ts";

/** The boundary every expression had before the scanner was quote-aware. */
const LEGACY_PATTERN = /\$\{\{\s*(.+?)\s*\}\}/gs;

function legacySpans(value: string): Array<{ raw: string; inner: string }> {
  return [...value.matchAll(LEGACY_PATTERN)].map((m) => ({
    raw: m[0],
    inner: m[1].trim(),
  }));
}

/** Text built from fragments that stress quotes, comments and braces. */
const arbValue = fc.array(
  fc.constantFrom(
    "${{",
    "}}",
    "{{",
    "'",
    '"',
    "'''",
    "\\",
    "//",
    "\n",
    " ",
    "a",
    "self.x",
    "literal(",
    ")",
    "+",
  ),
  { maxLength: 30 },
).map((parts) => parts.join(""));

Deno.test("scanExpressions: matches the legacy boundaries whenever every legacy expression parses", () => {
  fc.assert(
    fc.property(arbValue, (value) => {
      const legacy = legacySpans(value);
      fc.pre(legacy.every((s) => parsesAsCel(s.inner)));
      assertEquals(
        scanExpressions(value).map((s) => ({ raw: s.raw, inner: s.inner })),
        legacy,
      );
    }),
    { numRuns: 1000 },
  );
});

Deno.test("scanExpressions: every span parses or ends at its legacy boundary", () => {
  fc.assert(
    fc.property(arbValue, (value) => {
      for (const span of scanExpressions(value)) {
        const legacyEnd = value.indexOf("}}", span.start + 4) + 2;
        assert(parsesAsCel(span.inner) || span.end === legacyEnd, span.raw);
      }
    }),
    { numRuns: 1000 },
  );
});

Deno.test("scanExpressions: a literal() of text holding braces is one expression", () => {
  const arbText = fc.array(
    fc.constantFrom("{{", "}}", "{", "}", "host.name", " ", "$", ".", "x"),
    { minLength: 1, maxLength: 12 },
  ).map((parts) => parts.join(""));
  fc.assert(
    fc.property(arbText, fc.constantFrom("'", '"'), (text, quote) => {
      const inner = `literal(${quote}${text}${quote})`;
      const value = `pre \${{ inputs.env }} mid \${{ ${inner} }} post`;
      assertEquals(scanExpressions(value).map((s) => s.inner), [
        "inputs.env",
        inner,
      ]);
    }),
    { numRuns: 500 },
  );
});

Deno.test("scanExpressions: lexer steps and parsed characters stay linear", () => {
  const arbRepeated = fc.tuple(arbValue, fc.integer({ min: 1, max: 200 }))
    .map(([unit, n]) => unit.repeat(n));
  fc.assert(
    fc.property(arbRepeated, (value) => {
      const work: ScanWork = { lexSteps: 0, parsedChars: 0 };
      scanExpressions(value, work);
      assert(work.lexSteps <= 7 * value.length + 7);
      // Rejected walks visit each (position, state) pair once — six states —
      // cover at most three characters per step, and are parsed at most twice.
      assert(work.parsedChars <= 36 * value.length + 36);
    }),
    { numRuns: 300 },
  );
});
