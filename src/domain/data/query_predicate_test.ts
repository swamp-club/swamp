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
import { Environment } from "cel-js";
import { type ASTNode, extractModelNameEquality } from "./query_predicate.ts";

const env = new Environment({
  unlistedVariablesAreDyn: true,
  homogeneousAggregateLiterals: false,
});

function ast(expr: string): ASTNode {
  return env.parse(expr).ast as ASTNode;
}

Deno.test("extractModelNameEquality: simple equality", () => {
  assertEquals(extractModelNameEquality(ast('modelName == "foo"')), "foo");
});

Deno.test("extractModelNameEquality: reversed operand order", () => {
  assertEquals(extractModelNameEquality(ast('"bar" == modelName')), "bar");
});

Deno.test("extractModelNameEquality: nested in AND", () => {
  assertEquals(
    extractModelNameEquality(ast('modelName == "m1" && specName == "s1"')),
    "m1",
  );
});

Deno.test("extractModelNameEquality: deeply nested AND", () => {
  assertEquals(
    extractModelNameEquality(
      ast('size > 100 && modelName == "deep" && specName == "s"'),
    ),
    "deep",
  );
});

Deno.test("extractModelNameEquality: OR returns null", () => {
  assertEquals(
    extractModelNameEquality(ast('modelName == "a" || modelName == "b"')),
    null,
  );
});

Deno.test("extractModelNameEquality: no modelName returns null", () => {
  assertEquals(
    extractModelNameEquality(ast('specName == "result"')),
    null,
  );
});

Deno.test("extractModelNameEquality: modelName compared to non-literal returns null", () => {
  assertEquals(
    extractModelNameEquality(ast("modelName == specName")),
    null,
  );
});

Deno.test("extractModelNameEquality: true literal returns null", () => {
  assertEquals(extractModelNameEquality(ast("true")), null);
});

Deno.test("extractModelNameEquality: false literal returns null", () => {
  assertEquals(extractModelNameEquality(ast("false")), null);
});
