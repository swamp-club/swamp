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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CelEvaluator } from "./cel_evaluator.ts";
import { checkExpressionTypes } from "./expression_type_check.ts";

const evaluator = new CelEvaluator();
const CONTEXT = {
  inputs: { n: 2, s: "x", f: false, items: [1, 2] },
  self: { n: 1 },
};

function evaluationThrows(expression: string): boolean {
  try {
    evaluator.evaluate(expression, CONTEXT);
    return false;
  } catch {
    return true;
  }
}

Deno.test("checkExpressionTypes: a function swamp does not provide is refused with the overload reason", () => {
  assertStringIncludes(
    checkExpressionTypes("range(1, 9)") ?? "",
    "found no matching overload for 'range(int, int)'",
  );
  assertStringIncludes(
    checkExpressionTypes("toUpper(inputs.s)") ?? "",
    "found no matching overload for 'toUpper(dyn)'",
  );
});

Deno.test("checkExpressionTypes: an unknown function in a branch no run takes is still refused", () => {
  assert(checkExpressionTypes("false ? range(1, 2) : [1]") !== undefined);
});

Deno.test("checkExpressionTypes: expressions swamp evaluates are accepted", () => {
  for (
    const expression of [
      "[1, 2, 3]",
      '["A1", "A2"]',
      "inputs.items",
      "self.n + 1",
      'data.latest("plate-reader", self.well)',
      'model.method("infra", "check-exists", {"name": inputs.s}).stdout',
      "model.my-model.resource.state.main.attributes.id",
      'literal("${{ github.sha }}")',
      "size(inputs.s)",
      "inputs.f ? 1 : 2",
      "inputs.items.map(x, x * 2)",
      "has(inputs.s) ? inputs.s : 'd'",
      "1 + 2.0",
    ]
  ) {
    assertEquals(checkExpressionTypes(expression), undefined, expression);
  }
});

Deno.test("checkExpressionTypes: text that does not parse is left to the syntax checks", () => {
  assertEquals(checkExpressionTypes("inputs.("), undefined);
});

Deno.test("checkExpressionTypes: refusals that belong to the secret diagnostics are not reported", () => {
  assertEquals(
    checkExpressionTypes("inputs.f ? vault.get('v', 'k') : 1"),
    undefined,
  );
  assertEquals(checkExpressionTypes("size(vault.get('v', 'k'))"), undefined);
});

Deno.test("checkExpressionTypes: an unknown function beside vault.get is still refused", () => {
  assert(
    checkExpressionTypes("range(1, 2) == [] && vault.get('v', 'k') != null") !==
      undefined,
  );
});

Deno.test("checkExpressionTypes: refuses exactly the expressions whose evaluation fails on type", () => {
  const cases = [
    "range(1, 9)",
    "toUpper(inputs.s)",
    "math.greatest(1, 2)",
    "'a' + 1",
    "1 + 2u",
    "1 == 'a'",
    "true ? 'a' : 2",
    "inputs.f && toUpper(inputs.s) == 'S'",
    "[1, 2]",
    "[1, 'a']",
    "{'a': 1, 'b': 'x'}",
    "inputs.n == 'a'",
    "self.n == 1.0",
    "inputs.s.upperAscii()",
    "'a,b'.split(',')",
    "string(1)",
    "int('3')",
    "timestamp('2020-01-01T00:00:00Z')",
    "inputs.?s.orValue('d')",
  ];
  for (const expression of cases) {
    assertEquals(
      checkExpressionTypes(expression) !== undefined,
      evaluationThrows(expression),
      expression,
    );
  }
});
