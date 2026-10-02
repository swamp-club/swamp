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

import { assertEquals, assertThrows } from "@std/assert";
import { Environment } from "cel-js";
import { UserError } from "../errors.ts";
import {
  type ASTNode,
  collectLatestRunWorkflows,
  extractModelNameEquality,
  extractWorkflowRunIdLatestRun,
} from "./query_predicate.ts";

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
