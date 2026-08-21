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
import { timingSafeEqual } from "./timing_safe_equal.ts";

/**
 * `fc.fullUnicodeString` builds strings from whole code points, so it never
 * emits a lone surrogate — two distinct lone surrogates would both encode to
 * U+FFFD and compare equal by bytes, which is a property of UTF-8 encoding
 * rather than of this comparison.
 */
const arbText = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.fullUnicodeString({ maxLength: 20 }),
  fc.hexaString({ minLength: 32, maxLength: 64 }),
);

Deno.test("timingSafeEqual: agrees with === for arbitrary strings", () => {
  fc.assert(
    fc.property(arbText, arbText, (a, b) => {
      assertEquals(timingSafeEqual(a, b), a === b);
      assertEquals(timingSafeEqual(b, a), a === b);
    }),
    { numRuns: 500 },
  );
});

Deno.test("timingSafeEqual: is true for a string against itself", () => {
  fc.assert(
    fc.property(arbText, (a) => {
      assert(timingSafeEqual(a, a));
      // Comparing against an independently built copy behaves the same.
      assert(timingSafeEqual(a, `${a}`));
    }),
    { numRuns: 500 },
  );
});

Deno.test("timingSafeEqual: is false whenever the lengths differ", () => {
  fc.assert(
    fc.property(
      arbText,
      fc.string({ minLength: 1, maxLength: 10 }),
      (a, extra) => {
        assertEquals(timingSafeEqual(a, a + extra), false);
        assertEquals(timingSafeEqual(a + extra, a), false);
      },
    ),
    { numRuns: 500 },
  );
});

Deno.test("timingSafeEqual: a single flipped character breaks equality", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 40 }),
      fc.nat(),
      (a, index) => {
        const position = index % a.length;
        const original = a[position];
        const replacement = original === "a" ? "b" : "a";
        const mutated = a.slice(0, position) + replacement +
          a.slice(position + 1);
        assertEquals(timingSafeEqual(a, mutated), false);
      },
    ),
    { numRuns: 500 },
  );
});

Deno.test("timingSafeEqual: handles empty strings", () => {
  assert(timingSafeEqual("", ""));
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 20 }), (a) => {
      assertEquals(timingSafeEqual("", a), false);
      assertEquals(timingSafeEqual(a, ""), false);
    }),
    { numRuns: 200 },
  );
});
