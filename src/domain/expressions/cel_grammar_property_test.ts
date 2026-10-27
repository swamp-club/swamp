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
import { literalOccurrence } from "./cel_grammar.ts";
import { scanExpressions } from "./expression_scanner.ts";
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";

/** Text built from what a CEL string or the expression scanner treats specially. */
const arbText = fc.oneof(
  fc.array(
    fc.constantFrom(
      "${{",
      "}}",
      "'",
      '"',
      "'''",
      "\\",
      "\\'",
      "\\n",
      "\n",
      "\r",
      "\t",
      "//",
      " ",
      "a",
      "github.sha",
      "literal(",
      ")",
      "\u{1F600}",
      "\ud800",
    ),
    { maxLength: 30 },
  ).map((parts) => parts.join("")),
  fc.string({ unit: "binary", maxLength: 40 }),
);

Deno.test("literalOccurrence: the scanner finds the whole occurrence, and evaluating it gives back the text", async () => {
  const evaluator = new CelEvaluator();
  await fc.assert(
    fc.asyncProperty(arbText, async (text) => {
      const occurrence = literalOccurrence(text);
      const spans = scanExpressions(occurrence);
      assertEquals(spans.length, 1);
      assertEquals(spans[0].start, 0);
      assertEquals(spans[0].end, occurrence.length);
      assertEquals(await evaluator.evaluateAsync(spans[0].inner, {}), text);
    }),
    { numRuns: 500 },
  );
});

Deno.test("literalOccurrence: text around an occurrence does not move its bounds", () => {
  const arbAround = fc.string({ maxLength: 10 }).filter((s) =>
    !s.includes("${{") && !s.endsWith("$")
  );
  fc.assert(
    fc.property(arbAround, arbText, arbAround, (before, text, after) => {
      const occurrence = literalOccurrence(text);
      const [span] = scanExpressions(before + occurrence + after);
      assertEquals(span.start, before.length);
      assertEquals(span.end, before.length + occurrence.length);
    }),
    { numRuns: 500 },
  );
});
