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

import { assert } from "@std/assert";
import fc from "fast-check";
import { CelEvaluator } from "./cel_evaluator.ts";
import { checkExpressionTypes } from "./expression_type_check.ts";

const evaluator = new CelEvaluator();
const CONTEXT = { inputs: { n: 2, s: "x" }, self: { item: "y" } };

const arbArgument = fc.oneof(
  fc.integer({ min: -5, max: 5 }).map(String),
  fc.constantFrom("'a'", "'b,c'", "1.5", "true", "null", "[1, 2]"),
  fc.constantFrom("inputs.n", "inputs.s", "self.item"),
);

const arbCall = fc.tuple(
  fc.constantFrom(
    "size",
    "string",
    "int",
    "double",
    "range",
    "toUpper",
    "len",
    "keys",
  ),
  fc.array(arbArgument, { minLength: 1, maxLength: 2 }),
).map(([name, args]) => `${name}(${args.join(", ")})`);

const arbExpression = fc.oneof(
  arbCall,
  fc.tuple(arbCall, fc.constantFrom("+", "==", "&&"), arbArgument).map(
    ([left, op, right]) => `${left} ${op} ${right}`,
  ),
  fc.tuple(arbArgument, arbCall, arbCall).map(
    ([condition, a, b]) => `${condition} == 1 ? ${a} : ${b}`,
  ),
);

Deno.test("checkExpressionTypes: every refused expression fails when a run evaluates it", () => {
  fc.assert(
    fc.property(arbExpression, (expression) => {
      if (checkExpressionTypes(expression) === undefined) return;
      let threw = false;
      try {
        evaluator.evaluate(expression, CONTEXT);
      } catch {
        threw = true;
      }
      assert(threw, `refused but evaluated: ${expression}`);
    }),
    { numRuns: 300 },
  );
});
