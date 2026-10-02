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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { Environment } from "cel-js";
import {
  type ASTNode,
  collectModelReferences,
  extractModelCall,
  extractModelNameEquality,
  extractNameEquality,
  MAX_MODEL_REFERENCES,
  validateFieldReferences,
} from "./query_predicate.ts";
import { UserError } from "../errors.ts";

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

Deno.test("extractNameEquality: top-level and AND-nested name equality", () => {
  assertEquals(extractNameEquality(ast('name == "old"')), "old");
  assertEquals(extractNameEquality(ast('"old" == name')), "old");
  assertEquals(
    extractNameEquality(ast('modelName == "m" && name == "old"')),
    "old",
  );
});

Deno.test("extractNameEquality: ignores OR, negation, in and modelName", () => {
  assertEquals(extractNameEquality(ast('name == "a" || name == "b"')), null);
  assertEquals(extractNameEquality(ast('!(name == "a")')), null);
  assertEquals(extractNameEquality(ast('name in ["a"]')), null);
  assertEquals(extractNameEquality(ast('modelName == "a"')), null);
});

Deno.test("collectModelReferences: returns distinct literals in first-seen order", () => {
  assertEquals(
    collectModelReferences(
      ast('model("b") && (model("a") || !model("b")) && name == "x"'),
    ),
    ["b", "a"],
  );
});

Deno.test("collectModelReferences: finds calls inside ternaries, lists and receiver calls", () => {
  assertEquals(
    collectModelReferences(
      ast(
        '(model("a") ? [model("b")] : []).size() > 0 && name.startsWith("x")',
      ),
    ),
    ["a", "b"],
  );
});

Deno.test("collectModelReferences: no model() calls yields an empty list", () => {
  assertEquals(collectModelReferences(ast('modelName == "model"')), []);
});

Deno.test("collectModelReferences: rejects a non-literal or wrong-arity argument", () => {
  for (
    const expr of ["model(name)", "model(1)", 'model("a", "b")', "model()"]
  ) {
    const error = assertThrows(
      () => collectModelReferences(ast(expr)),
      UserError,
    );
    assertStringIncludes(error.message, "exactly one string literal");
  }
});

Deno.test("collectModelReferences: caps the number of distinct references", () => {
  const atCap = Array.from(
    { length: MAX_MODEL_REFERENCES },
    (_, i) => `model("m${i}")`,
  ).join(" || ");
  assertEquals(collectModelReferences(ast(atCap)).length, MAX_MODEL_REFERENCES);
  // Repeats of one reference count once.
  assertEquals(
    collectModelReferences(ast(`${atCap} || model("m0")`)).length,
    MAX_MODEL_REFERENCES,
  );
  assertThrows(
    () => collectModelReferences(ast(`${atCap} || model("over")`)),
    UserError,
    `at most ${MAX_MODEL_REFERENCES} models`,
  );
});

Deno.test("extractModelCall: top-level and AND-nested model() only", () => {
  assertEquals(extractModelCall(ast('model("a")')), "a");
  assertEquals(extractModelCall(ast('name == "x" && model("a")')), "a");
  assertEquals(extractModelCall(ast('model("a") || model("b")')), null);
  assertEquals(extractModelCall(ast('!model("a")')), null);
  assertEquals(extractModelCall(ast('name == "x"')), null);
});

Deno.test("validateFieldReferences: unknown-field error names the model() function", () => {
  const error = assertThrows(
    () => validateFieldReferences(["nope"]),
    UserError,
  );
  assertStringIncludes(error.message, 'model("<model name or definition id>")');
});
