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
import { Environment } from "cel-js";
import {
  type ASTNode,
  collectModelReferences,
  extractModelCall,
} from "./query_predicate.ts";

// The same options DataQueryService parses predicates with.
const env = new Environment({
  unlistedVariablesAreDyn: true,
  homogeneousAggregateLiterals: false,
});

function ast(expr: string): ASTNode {
  return env.parse(expr).ast as ASTNode;
}

/** A model() call on any string, written as a CEL literal (JSON escapes). */
const arbCall = fc.string({ minLength: 1, maxLength: 12 }).map((ref) => ({
  ref,
  expr: `model(${JSON.stringify(ref)})`,
}));

/** Joins calls with random operators, negations and other terms. */
const arbPredicate = fc.array(
  fc.tuple(
    arbCall,
    fc.constantFrom("&&", "||"),
    fc.boolean(),
    fc.boolean(),
  ),
  { minLength: 1, maxLength: 8 },
);

Deno.test("collectModelReferences: returns each referenced literal once, in first-seen order", () => {
  fc.assert(
    fc.property(arbPredicate, (parts) => {
      const expr = parts.map(([call, op, negate, withTerm], i) => {
        const term = withTerm ? `(${call.expr} && name == "x")` : call.expr;
        return `${i === 0 ? "" : ` ${op} `}${negate ? "!" : ""}${term}`;
      }).join("");
      const expected = [...new Set(parts.map(([call]) => call.ref))];
      assertEquals(collectModelReferences(ast(expr)), expected);
    }),
  );
});

Deno.test("extractModelCall: finds a model() conjunct under any AND nesting", () => {
  fc.assert(
    fc.property(
      arbCall,
      fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
      fc.boolean(),
      (call, names, callFirst) => {
        const others = names.map((n) => `name != ${JSON.stringify(n)}`);
        const terms = callFirst
          ? [call.expr, ...others]
          : [...others, call.expr];
        assertEquals(extractModelCall(ast(terms.join(" && "))), call.ref);
      },
    ),
  );
});
