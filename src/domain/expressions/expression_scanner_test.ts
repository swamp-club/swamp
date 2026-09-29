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
import {
  isExpressionsOnly,
  matchSingleExpression,
  replaceExpressionSpans,
  scanExpressions,
  type ScanWork,
} from "./expression_scanner.ts";

function raws(value: string): string[] {
  return scanExpressions(value).map((s) => s.raw);
}

function inners(value: string): string[] {
  return scanExpressions(value).map((s) => s.inner);
}

Deno.test("scanExpressions: finds each expression with its trimmed inner text", () => {
  assertEquals(scanExpressions("a ${{ x }} b ${{y}}"), [
    { start: 2, end: 10, raw: "${{ x }}", inner: "x" },
    { start: 13, end: 19, raw: "${{y}}", inner: "y" },
  ]);
  assertEquals(scanExpressions("no expressions {{ here }}"), []);
});

Deno.test("scanExpressions: keeps the legacy edge cases", () => {
  // No inner character, so `${{}}` is not an expression.
  assertEquals(raws("${{}}"), []);
  assertEquals(inners("${{ }}"), [""]);
  assertEquals(inners("${{}}}"), ["}"]);
  assertEquals(raws("${{{ a }}}"), ["${{{ a }}"]);
  // An opener with no close after it is not an expression.
  assertEquals(raws("${{ a"), []);
  assertEquals(raws("${{ a }} ${{ b"), ["${{ a }}"]);
});

Deno.test("scanExpressions: a }} inside a CEL string does not end the expression", () => {
  assertEquals(inners(`\${{ '{{host.name}}' }}`), [`'{{host.name}}'`]);
  assertEquals(inners(`\${{ "{{host.name}}" }}`), [`"{{host.name}}"`]);
  assertEquals(
    inners(
      "${{ inputs.env }} alert, crashed on ${{ literal('{{host.name}}') }}",
    ),
    ["inputs.env", "literal('{{host.name}}')"],
  );
  assertEquals(inners(`\${{ '''{{a}}''' }}`), [`'''{{a}}'''`]);
  assertEquals(inners(`\${{ r'{{a}}' }}`), [`r'{{a}}'`]);
  assertEquals(inners(`\${{ 'it\\'s }}' }}`), [`'it\\'s }}'`]);
});

Deno.test("scanExpressions: an expression that parses at the first }} keeps that boundary", () => {
  // Comments parse, and a }} in a comment still ends the expression.
  const value = "echo ${{ self.name // model name }}\necho ${{ self.id }}";
  assertEquals(inners(value), ["self.name // model name", "self.id"]);
  // Quotes after an expression are ordinary text.
  assertEquals(inners("${{ self.name }}'s file"), ["self.name"]);
  assertEquals(inners(`echo '\${{ self.name }}' "x"`), ["self.name"]);
});

Deno.test("scanExpressions: malformed text keeps the legacy boundary", () => {
  // An unterminated string.
  assertEquals(raws(`\${{ "abc }} secret`), [`\${{ "abc }}`]);
  // Unparseable text whose quote-aware boundary does not parse either.
  assertEquals(raws("${{ it's }} SECRET don't }}"), ["${{ it's }}"]);
  // A line break ends a single-quoted string's chance to close.
  assertEquals(raws("${{ 'a }}\n' }}"), ["${{ 'a }}"]);
});

Deno.test("scanExpressions: a quoted string holding a later expression becomes one literal", () => {
  // The whole quoted text parses as one CEL string, so the inner expression
  // is part of it rather than a second expression.
  assertEquals(inners("${{ 'a }} b ${{ inputs.x }} c' }}"), [
    "'a }} b ${{ inputs.x }} c'",
  ]);
});

Deno.test("scanExpressions: a walk that reaches a rejected walk's state keeps the legacy boundary", () => {
  // The first opener's walk is rejected and passes the newline in the Code
  // state. The second opener's walk leaves its comment on the same newline,
  // meets the rejected state, and so keeps its legacy boundary, even though
  // its own quote-aware text would parse.
  const value = `\${{ z'}}\${{ "}}'//"\n}}`;
  assertEquals(raws(value), ["${{ z'}}", `\${{ "}}`]);
});

Deno.test("scanExpressions: work stays linear on adversarial input", () => {
  const cases = [
    `\${{ "}}"`.repeat(2000),
    "${{ // }}".repeat(2000),
    "${{ \\'}}".repeat(2000) + "' }}",
    "${{ '}} ".repeat(2000) + "}}",
  ];
  for (const value of cases) {
    const work: ScanWork = { lexSteps: 0, parsedChars: 0 };
    scanExpressions(value, work);
    assert(
      work.lexSteps <= 7 * value.length,
      `lexSteps ${work.lexSteps} for length ${value.length}`,
    );
    assert(
      work.parsedChars <= 36 * value.length,
      `parsedChars ${work.parsedChars} for length ${value.length}`,
    );
  }
});

Deno.test("matchSingleExpression: matches one whole-value expression", () => {
  assertEquals(matchSingleExpression("${{ a }}")?.inner, "a");
  assertEquals(matchSingleExpression("${{ a }}  \n")?.raw, "${{ a }}");
  assertEquals(matchSingleExpression("${{ a }}  ", { exact: true }), null);
  assertEquals(matchSingleExpression("${{ a }} and ${{ b }}"), null);
  assertEquals(matchSingleExpression(" ${{ a }}"), null);
  assertEquals(
    matchSingleExpression("${{ literal('{{x}}') }}")?.inner,
    "literal('{{x}}')",
  );
});

Deno.test("isExpressionsOnly: true only when every non-expression character is whitespace", () => {
  assertEquals(isExpressionsOnly("${{ a }} ${{ b }}"), true);
  assertEquals(isExpressionsOnly("${{ 'a }}secret' }}"), true);
  assertEquals(isExpressionsOnly("x-${{ a }}"), false);
  assertEquals(isExpressionsOnly(`\${{ "abc }} secret`), false);
  assertEquals(isExpressionsOnly("plain"), false);
});

Deno.test("replaceExpressionSpans: replaces by position", () => {
  assertEquals(
    replaceExpressionSpans(
      "a ${{ x }} b ${{ y }}",
      (s) => s.inner.toUpperCase(),
    ),
    "a X b Y",
  );
});
