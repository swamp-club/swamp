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
import {
  type ASTNode,
  extractModelNameEquality,
  extractStringEquality,
  selectReadsContent,
  specNameFallbackPredicate,
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

Deno.test("specNameFallbackPredicate: swaps a lone name equality", () => {
  assertEquals(
    specNameFallbackPredicate(ast('name == "classification"')),
    'specName == "classification"',
  );
});

Deno.test("specNameFallbackPredicate: keeps the workflow scoping conjuncts", () => {
  assertEquals(
    specNameFallbackPredicate(
      ast(
        'workflowRunId == "run-1" && jobName == "j" && stepName == "s" && "m" == modelName && name == "classification" && version == 3',
      ),
    ),
    'workflowRunId == "run-1" && jobName == "j" && stepName == "s" && modelName == "m" && specName == "classification" && version == 3',
  );
});

Deno.test("specNameFallbackPredicate: drops conjuncts that are not simple equalities", () => {
  assertEquals(
    specNameFallbackPredicate(
      ast(
        'name == "x" && size > 10 && tags.env == "prod" && !(stepName == "s")',
      ),
    ),
    'specName == "x"',
  );
});

Deno.test("specNameFallbackPredicate: quotes literals so they round-trip", () => {
  const fallback = specNameFallbackPredicate(ast('name == "a\\"b\'c"'));
  assertEquals(fallback, 'specName == "a\\"b\'c"');
  assertEquals(extractStringEquality(ast(fallback!), "specName"), "a\"b'c");
});

Deno.test("specNameFallbackPredicate: null without a top-level name equality", () => {
  assertEquals(specNameFallbackPredicate(ast('modelName == "m"')), null);
  assertEquals(
    specNameFallbackPredicate(ast('name == "a" || name == "b"')),
    null,
  );
  assertEquals(specNameFallbackPredicate(ast('!(name == "a")')), null);
  assertEquals(specNameFallbackPredicate(ast('name.startsWith("a")')), null);
});

Deno.test("specNameFallbackPredicate: null with two name equalities", () => {
  assertEquals(
    specNameFallbackPredicate(ast('name == "a" && name == "b"')),
    null,
  );
});

Deno.test("specNameFallbackPredicate: null when specName is already referenced", () => {
  assertEquals(
    specNameFallbackPredicate(ast('name == "a" && specName != "b"')),
    null,
  );
});

Deno.test("specNameFallbackPredicate: null when name is compared to a non-string", () => {
  assertEquals(specNameFallbackPredicate(ast("name == 3")), null);
});
