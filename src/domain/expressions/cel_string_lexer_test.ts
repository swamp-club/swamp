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
import {
  lexSegments,
  maskLiteralCalls,
  stripStringLiterals,
} from "./cel_string_lexer.ts";

function kinds(text: string): Array<[string, string]> {
  return lexSegments(text).map((s) => [s.kind, text.slice(s.start, s.end)]);
}

Deno.test("lexSegments: splits code, strings and comments", () => {
  assertEquals(kinds(`a + 'b' + "c"`), [
    ["code", "a + "],
    ["string", "'b'"],
    ["code", " + "],
    ["string", '"c"'],
  ]);
  assertEquals(kinds("a // it's\nb"), [
    ["code", "a "],
    ["comment", "// it's\n"],
    ["code", "b"],
  ]);
});

Deno.test("lexSegments: triple-quoted strings span lines and hold single quotes", () => {
  assertEquals(kinds("'''a\n'b' '''+x"), [
    ["string", "'''a\n'b' '''"],
    ["code", "+x"],
  ]);
});

Deno.test("lexSegments: a backslash skips the next character, raw strings included", () => {
  assertEquals(kinds(`'a\\'b'`), [["string", `'a\\'b'`]]);
  // cel-js ends a raw string at the same place as any other string.
  assertEquals(kinds(`r'a\\'b' + c`), [
    ["code", "r"],
    ["string", `'a\\'b'`],
    ["code", " + c"],
  ]);
});

Deno.test("lexSegments: an unterminated string runs to the end", () => {
  assertEquals(kinds("a + 'b"), [["code", "a + "], ["string", "'b"]]);
  assertEquals(kinds("'a\nb'"), [["string", "'a\nb'"]]);
});

Deno.test("stripStringLiterals: replaces strings and normalises member access", () => {
  assertEquals(stripStringLiterals(`self.tags["env"]`), `self.tags[""]`);
  assertEquals(stripStringLiterals("self . tags .? env"), "self.tags.env");
  assertEquals(stripStringLiterals("a  +  b"), "a  +  b");
});

Deno.test("stripStringLiterals: a raw string's escaped quote does not end it", () => {
  // The vault.get is real code: the raw string is 'a\'b'.
  assertEquals(
    stripStringLiterals(`r'a\\'b' + vault.get('v','k')`),
    `r"" + vault.get("","")`,
  );
});

Deno.test("stripStringLiterals: stays linear on long whitespace runs", () => {
  const text = "a" + " ".repeat(200_000) + "b";
  assertEquals(stripStringLiterals(text), text);
});

Deno.test("maskLiteralCalls: blanks the string argument of a bare literal() call", () => {
  assertEquals(
    maskLiteralCalls("inputs.env + literal('{{env.name}}')"),
    `inputs.env + literal("")`,
  );
  assertEquals(maskLiteralCalls(`literal ( r"{{x}}" )`), `literal ( r"" )`);
  assertEquals(
    maskLiteralCalls("literal('''{{a}}''') + literal(\"{{b}}\")"),
    `literal("") + literal("")`,
  );
});

Deno.test("maskLiteralCalls: leaves every other form untouched", () => {
  for (
    const cel of [
      "literal(inputs.x)",
      "literal(vault.get('v', 'k'))",
      "x.literal('{{a}}')",
      "x . literal('{{a}}')",
      "my_literal('{{a}}')",
      "literally('{{a}}')",
      "self.globalArguments.literal",
      "literal('a' + b)",
      "'literal(\"x\")'",
    ]
  ) {
    assertEquals(maskLiteralCalls(cel), cel, cel);
  }
});

Deno.test("maskLiteralCalls: masks the inner call of a nested literal()", () => {
  assertEquals(
    maskLiteralCalls("literal(literal('{{self.x}}'))"),
    `literal(literal(""))`,
  );
});
