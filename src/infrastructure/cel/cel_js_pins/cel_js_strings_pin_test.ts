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

// Pins for string length, offsets and regular expressions
// (design/enablers/typed-secrets.md Section 4.2, fact 8: "`size(string)` counts
// code points. Ordinary `matches` uses JavaScript RegExp.").
//
// Non-ASCII inputs are built from code points so no editor or formatter can
// normalize them (a precomposed e-acute has size 1; e + U+0301 has size 2).
//
// The regex syntax pins (inline flags, \p{L} without the u flag, \A and \z)
// also depend on the JavaScript engine in the pinned Deno version, not only on
// cel-js. If one fails after a Deno upgrade with cel-js unchanged, the engine
// changed: re-review the design all the same.

import { assertEquals } from "@std/assert";
import { EvaluationError } from "cel-js";
import {
  assertCelError,
  dynEnvironment,
  pin,
} from "./cel_js_pin_test_helpers.ts";

const GRINNING_FACE = String.fromCodePoint(0x1f600);
const PRECOMPOSED_E_ACUTE = String.fromCodePoint(0xe9);
const DECOMPOSED_E_ACUTE = `e${String.fromCodePoint(0x301)}`;

function evaluate(expression: string, bindings: Record<string, unknown> = {}) {
  return dynEnvironment().evaluate(expression, bindings);
}

Deno.test(
  pin("size(string) counts code points, not UTF-16 units or graphemes"),
  () => {
    const face = GRINNING_FACE;
    assertEquals(evaluate("size(s)", { s: face }), 1n);
    assertEquals(evaluate("s.size()", { s: face }), 1n);
    assertEquals(evaluate("size(s)", { s: `a${face}b` }), 3n);
    assertEquals(evaluate("size(s)", { s: PRECOMPOSED_E_ACUTE }), 1n);
    assertEquals(evaluate("size(s)", { s: DECOMPOSED_E_ACUTE }), 2n);
    assertEquals(evaluate("size(bytes(s))", { s: face }), 4n);
  },
);

Deno.test(pin("substring and indexOf use UTF-16 code unit offsets"), () => {
  const s = `a${GRINNING_FACE}b`;
  // Half of a surrogate pair.
  assertEquals(evaluate("s.substring(1, 2)", { s }), "\ud83d");
  assertEquals(evaluate("s.substring(1, 3)", { s }), GRINNING_FACE);
  assertEquals(evaluate("s.indexOf('b')", { s }), 3n);
  assertEquals(evaluate("s.lastIndexOf('b')", { s }), 3n);
});

Deno.test(pin("matches compiles a JavaScript RegExp with no flags"), () => {
  const face = GRINNING_FACE;
  // Without the u flag "." matches one UTF-16 unit.
  assertEquals(evaluate("s.matches('^.$')", { s: face }), false);
  assertEquals(evaluate("s.matches('^..$')", { s: face }), true);
  // Without the u flag \p{L} is a literal "p{L}".
  assertEquals(evaluate("'x'.matches('\\\\p{L}')"), false);
  assertEquals(evaluate("'p{L}'.matches('\\\\p{L}')"), true);
  // Without the m flag ^ and $ anchor the whole input.
  assertEquals(evaluate("s.matches('^b$')", { s: "a\nb" }), false);
  // \A and \z are not anchors in JavaScript.
  assertEquals(evaluate("'ab'.matches('\\\\Aab\\\\z')"), false);
});

Deno.test(
  pin("matches accepts JavaScript-only syntax and rejects RE2-only syntax"),
  () => {
    assertEquals(evaluate("'aaa'.matches('(?<=a)a')"), true);
    assertEquals(evaluate("'abc'.matches('a(?=b)')"), true);
    assertEquals(evaluate("'ab'.matches('(?<n>a)b')"), true);
    for (
      const expression of [
        "'abc'.matches('(?i)ABC')",
        "'ab'.matches('(?m)^b$')",
        "'ab'.matches('(?P<n>a)b')",
        "'['.matches('[')",
      ]
    ) {
      assertCelError(
        () => evaluate(expression),
        EvaluationError,
        "invalid_regular_expression",
      );
    }
  },
);
