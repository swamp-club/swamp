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
import { UserError } from "../errors.ts";
import {
  type ASTNode,
  buildSpecNameFallback,
  collectLatestRunWorkflows,
  collectModelReferences,
  extractModelCall,
  extractModelNameEquality,
  extractStringEquality,
  extractWorkflowRunIdLatestRun,
  MAX_MODEL_REFERENCES,
  selectReadsContent,
  validateFieldReferences,
} from "./query_predicate.ts";

const env = new Environment({
  unlistedVariablesAreDyn: true,
  homogeneousAggregateLiterals: false,
});

function ast(expr: string): ASTNode {
  return env.parse(expr).ast as ASTNode;
}

function specNamePredicateOf(node: ASTNode): string | null {
  return buildSpecNameFallback(node)?.specNamePredicate ?? null;
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

Deno.test("selectReadsContent: true for content or contentEncoding at root", () => {
  assertEquals(selectReadsContent(ast("content")), true);
  assertEquals(selectReadsContent(ast("contentEncoding")), true);
  assertEquals(
    selectReadsContent(
      ast('{"content": content, "contentEncoding": contentEncoding}'),
    ),
    true,
  );
});

Deno.test("selectReadsContent: false for other fields and string literals", () => {
  assertEquals(selectReadsContent(ast("name")), false);
  assertEquals(selectReadsContent(ast("attributes.content")), false);
  assertEquals(selectReadsContent(ast('"content"')), false);
});

Deno.test("extractStringEquality: finds the named field among AND conjuncts", () => {
  assertEquals(
    extractStringEquality(
      ast('modelName == "m" && specName == "s"'),
      "specName",
    ),
    "s",
  );
});

Deno.test("extractStringEquality: ignores a non-string literal", () => {
  assertEquals(extractStringEquality(ast("specName == 3"), "specName"), null);
});

Deno.test("buildSpecNameFallback: swaps a lone name equality", () => {
  assertEquals(
    specNamePredicateOf(ast('name == "classification"')),
    'specName == "classification"',
  );
});

Deno.test("buildSpecNameFallback: keeps the workflow scoping conjuncts", () => {
  assertEquals(
    specNamePredicateOf(
      ast(
        'workflowRunId == "run-1" && jobName == "j" && stepName == "s" && "m" == modelName && name == "classification" && version == 3',
      ),
    ),
    'workflowRunId == "run-1" && jobName == "j" && stepName == "s" && modelName == "m" && specName == "classification" && version == 3',
  );
});

Deno.test("buildSpecNameFallback: drops conjuncts that are not simple equalities", () => {
  assertEquals(
    specNamePredicateOf(
      ast(
        'name == "x" && size > 10 && tags.env == "prod" && !(stepName == "s")',
      ),
    ),
    'specName == "x"',
  );
});

Deno.test("buildSpecNameFallback: quotes literals so they round-trip", () => {
  const fallback = specNamePredicateOf(ast('name == "a\\"b\'c"'));
  assertEquals(fallback, 'specName == "a\\"b\'c"');
  assertEquals(extractStringEquality(ast(fallback!), "specName"), "a\"b'c");
});

Deno.test("buildSpecNameFallback: null without a top-level name equality", () => {
  assertEquals(specNamePredicateOf(ast('modelName == "m"')), null);
  assertEquals(
    specNamePredicateOf(ast('name == "a" || name == "b"')),
    null,
  );
  assertEquals(specNamePredicateOf(ast('!(name == "a")')), null);
  assertEquals(specNamePredicateOf(ast('name.startsWith("a")')), null);
});

Deno.test("buildSpecNameFallback: null with two name equalities", () => {
  assertEquals(
    specNamePredicateOf(ast('name == "a" && name == "b"')),
    null,
  );
});

Deno.test("buildSpecNameFallback: null when specName is already referenced", () => {
  assertEquals(
    specNamePredicateOf(ast('name == "a" && specName != "b"')),
    null,
  );
});

Deno.test("buildSpecNameFallback: null when name is compared to a non-string", () => {
  assertEquals(specNamePredicateOf(ast("name == 3")), null);
});

Deno.test("buildSpecNameFallback: namePredicate keeps the same scope by name", () => {
  assertEquals(
    buildSpecNameFallback(
      ast('workflowRunId == "run-1" && name == "result" && tags.env == "prod"'),
    ),
    {
      specNamePredicate: 'workflowRunId == "run-1" && specName == "result"',
      namePredicate: 'workflowRunId == "run-1" && name == "result"',
      droppedConjuncts: true,
    },
  );
});

Deno.test("buildSpecNameFallback: droppedConjuncts is false when every conjunct is kept", () => {
  assertEquals(
    buildSpecNameFallback(
      ast('modelName == "m" && name == "x" && version == 2'),
    )
      ?.droppedConjuncts,
    false,
  );
});

Deno.test("collectLatestRunWorkflows: returns the literal argument", () => {
  assertEquals(
    collectLatestRunWorkflows(ast('workflowRunId == latestRun("deploy")')),
    ["deploy"],
  );
});

Deno.test("collectLatestRunWorkflows: returns each workflow once", () => {
  assertEquals(
    collectLatestRunWorkflows(
      ast(
        'workflowRunId == latestRun("a") || workflowRunId == latestRun("b") || workflowRunId == latestRun("a")',
      ),
    ),
    ["a", "b"],
  );
});

Deno.test("collectLatestRunWorkflows: finds calls under NOT, ternaries, lists, maps and macros", () => {
  for (
    const expr of [
      '!(workflowRunId == latestRun("w"))',
      'true ? workflowRunId == latestRun("w") : false',
      'workflowRunId in [latestRun("w")]',
      '{"k": latestRun("w")}.k == workflowRunId',
      'tags.all(k, workflowRunId == latestRun("w"))',
      'size(latestRun("w")) > 0',
    ]
  ) {
    assertEquals(collectLatestRunWorkflows(ast(expr)), ["w"], expr);
  }
});

Deno.test("collectLatestRunWorkflows: returns nothing when latestRun is not called", () => {
  assertEquals(
    collectLatestRunWorkflows(ast('name == "latestRun" && latestRun == 1')),
    [],
  );
});

Deno.test("collectLatestRunWorkflows: rejects an argument that is not one non-empty string literal", () => {
  for (
    const expr of [
      "workflowRunId == latestRun(workflowName)",
      "workflowRunId == latestRun()",
      'workflowRunId == latestRun("a", "b")',
      "workflowRunId == latestRun(1)",
      'workflowRunId == latestRun("")',
      'workflowRunId == latestRun(latestRun("a"))',
    ]
  ) {
    assertThrows(
      () => collectLatestRunWorkflows(ast(expr)),
      UserError,
      "string literal",
      expr,
    );
  }
});

Deno.test("collectLatestRunWorkflows: rejects the receiver form", () => {
  assertThrows(
    () => collectLatestRunWorkflows(ast('workflowRunId == "w".latestRun()')),
    UserError,
    'latestRun("<workflow>")',
  );
});

Deno.test("extractWorkflowRunIdLatestRun: equality in either operand order", () => {
  assertEquals(
    extractWorkflowRunIdLatestRun(ast('workflowRunId == latestRun("w")')),
    "w",
  );
  assertEquals(
    extractWorkflowRunIdLatestRun(ast('latestRun("w") == workflowRunId')),
    "w",
  );
});

Deno.test("extractWorkflowRunIdLatestRun: nested in AND", () => {
  assertEquals(
    extractWorkflowRunIdLatestRun(
      ast(
        'name == "out" && (stepName == "s" && workflowRunId == latestRun("w"))',
      ),
    ),
    "w",
  );
});

Deno.test("extractWorkflowRunIdLatestRun: never descends into OR or NOT", () => {
  for (
    const expr of [
      'workflowRunId == latestRun("w") || name == "out"',
      '!(workflowRunId == latestRun("w"))',
      'workflowRunId != latestRun("w")',
      'stepName == latestRun("w")',
      'workflowRunId == "run-1"',
    ]
  ) {
    assertEquals(extractWorkflowRunIdLatestRun(ast(expr)), null, expr);
  }
});

Deno.test("collectModelReferences: returns distinct literals in first-seen order", () => {
  assertEquals(
    collectModelReferences(
      ast('model("b") && (model("a") || !model("b")) && name == "x"'),
    ),
    ["b", "a"],
  );
});

Deno.test("collectModelReferences: finds calls inside ternaries and lists", () => {
  assertEquals(
    collectModelReferences(
      ast('(model("a") ? [model("b")] : []).size() > 0'),
    ),
    ["a", "b"],
  );
});

Deno.test("collectModelReferences: no model() calls yields an empty list", () => {
  assertEquals(collectModelReferences(ast('modelName == "model"')), []);
});

Deno.test("collectModelReferences: rejects an argument that is not one non-empty string literal", () => {
  for (
    const expr of [
      "model(name)",
      "model(1)",
      'model("a", "b")',
      "model()",
      'model("")',
    ]
  ) {
    assertThrows(
      () => collectModelReferences(ast(expr)),
      UserError,
      "one model name or definition id",
    );
  }
});

Deno.test("collectModelReferences: rejects the receiver form", () => {
  assertThrows(
    () => collectModelReferences(ast('"x".model()')),
    UserError,
    'write model("<model>")',
  );
});

Deno.test("collectModelReferences: caps the number of distinct models", () => {
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

Deno.test("validateFieldReferences: unknown-field error names the query functions", () => {
  const error = assertThrows(
    () => validateFieldReferences(["nope"]),
    UserError,
  );
  assertStringIncludes(error.message, 'latestRun("<workflow>")');
  assertStringIncludes(error.message, 'model("<model name or definition id>")');
});

Deno.test("buildSpecNameFallback: keeps a model() scope, in both predicates", () => {
  const fallback = buildSpecNameFallback(
    ast('model("scanner") && name == "classification"'),
  );
  assertEquals(fallback, {
    specNamePredicate: 'model("scanner") && specName == "classification"',
    namePredicate: 'model("scanner") && name == "classification"',
    droppedConjuncts: false,
  });
});
