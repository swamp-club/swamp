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
import {
  distinctRemedies,
  type ExpressionPathError,
  formatExpressionPathErrors,
} from "./validation_service.ts";

/** Remedies are drawn from these, so each is easy to count in the output. */
const REMEDIES = [
  "REMEDY-ALPHA applies to every error of one form.",
  "REMEDY-BRAVO applies to every error of another form.",
  "REMEDY-CHARLIE applies to every error of a third form.",
];

/**
 * Non-empty single-line text with no surrounding whitespace that cannot
 * contain a remedy sentinel.
 */
const arbLine = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => s.replace(/[\r\n\u2028\u2029]/g, " ").replace(/REMEDY/g, "x"))
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const arbError: fc.Arbitrary<ExpressionPathError> = fc.record(
  {
    expression: arbLine,
    error: arbLine,
    suggestion: arbLine,
    remedy: fc.constantFrom(...REMEDIES),
    availableKeys: fc.array(arbLine, { minLength: 1, maxLength: 3 }),
  },
  { requiredKeys: ["expression", "error"] },
);

const arbErrors = fc.array(arbError, { maxLength: 8 });

Deno.test("formatExpressionPathErrors: contains every expression", () => {
  fc.assert(
    fc.property(arbErrors, (errors) => {
      const lines = formatExpressionPathErrors(errors).split("\n");
      for (const err of errors) {
        assert(lines.includes(`- ${err.expression}`));
      }
    }),
  );
});

Deno.test("formatExpressionPathErrors: prints each present remedy exactly once and no absent one", () => {
  fc.assert(
    fc.property(arbErrors, (errors) => {
      const text = formatExpressionPathErrors(errors);
      const present = new Set(errors.map((e) => e.remedy));
      for (const remedy of REMEDIES) {
        const count = text.split(remedy).length - 1;
        assertEquals(count, present.has(remedy) ? 1 : 0);
      }
    }),
  );
});

Deno.test("formatExpressionPathErrors: every line is an entry, a continuation, or a remedy", () => {
  fc.assert(
    fc.property(arbErrors, (errors) => {
      const remedies = distinctRemedies(errors);
      const text = formatExpressionPathErrors(errors);
      if (errors.length === 0) return assertEquals(text, "");
      for (const line of text.split("\n")) {
        assert(
          line.startsWith("- ") || /^ {2}\S/.test(line) ||
            remedies.includes(line),
          `unexpected line: ${JSON.stringify(line)}`,
        );
      }
    }),
  );
});

Deno.test("distinctRemedies: returns no duplicates, in first-seen order", () => {
  fc.assert(
    fc.property(arbErrors, (errors) => {
      const remedies = distinctRemedies(errors);
      assertEquals(new Set(remedies).size, remedies.length);
      const firstSeen = errors
        .map((e) => e.remedy)
        .filter((r): r is string => r !== undefined)
        .filter((r, i, all) => all.indexOf(r) === i);
      assertEquals(remedies, firstSeen);
    }),
  );
});
