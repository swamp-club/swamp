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
  freeRoots,
  isBlankConstant,
  parsesAsCel,
  transformHyphenatedModelRefs,
  typeChecksAsConstant,
} from "./cel_grammar.ts";

Deno.test("transformHyphenatedModelRefs: rewrites hyphenated model names in code", () => {
  assertEquals(
    transformHyphenatedModelRefs(
      "model.web-1a.resource.x + model.a-b-c.definition.y",
    ),
    'model["web-1a"].resource.x + model["a-b-c"].definition.y',
  );
  assertEquals(
    transformHyphenatedModelRefs("model.plain.resource.x"),
    "model.plain.resource.x",
  );
});

Deno.test("transformHyphenatedModelRefs: leaves string literals verbatim", () => {
  assertEquals(
    transformHyphenatedModelRefs("literal('{{ model.my-app.resource.x }}')"),
    "literal('{{ model.my-app.resource.x }}')",
  );
});

Deno.test("transformHyphenatedModelRefs: is linear on a long hyphenated name that fails to match", () => {
  // The older nested-quantifier pattern backtracked exponentially here.
  const text = "model.a" + "-a".repeat(5000) + "!";
  assertEquals(transformHyphenatedModelRefs(text), text);
  assertEquals(parsesAsCel(text), false);
});

Deno.test("parsesAsCel: accepts the evaluation grammar", () => {
  assertEquals(parsesAsCel("inputs.?x.orValue('')"), true);
  assertEquals(parsesAsCel("model.web-1a.resource.x"), true);
  assertEquals(parsesAsCel("literal('{{host.name}}')"), true);
  assertEquals(parsesAsCel("self.name // it's a comment"), true);
  assertEquals(parsesAsCel("literal('{{host.name"), false);
});

Deno.test("freeRoots: reports the roots an expression reads", () => {
  assertEquals(freeRoots("literal('{{host.name}}')"), new Set());
  assertEquals(freeRoots("'a' + 'b'"), new Set());
  assertEquals(freeRoots("inputs.?token.orValue('')"), new Set(["inputs"]));
  assertEquals(
    freeRoots("[1].map(x, x + self.n)"),
    new Set(["self"]),
  );
  assertEquals(freeRoots("vault.get('v', 'k')"), new Set(["vault"]));
  assertEquals(freeRoots("not cel ("), undefined);
});

Deno.test("isBlankConstant: true only for the empty string and null", () => {
  for (const cel of ["''", '""', "null", "literal('')", 'literal("")']) {
    assertEquals(isBlankConstant(cel), true, cel);
  }
  for (const cel of ["' '", "literal(' ')", "'x'", "0", "false", "inputs.x"]) {
    assertEquals(isBlankConstant(cel), false, cel);
  }
});

Deno.test("typeChecksAsConstant: rejects calls the evaluator does not have", () => {
  for (
    const cel of [
      "literal('{{a}}')",
      "literal('{{a}}') + ' on-call'",
      "size('abc')",
    ]
  ) {
    assertEquals(typeChecksAsConstant(cel), true, cel);
  }
  for (
    const cel of ["now()", "lookup('env', 'HOME')", "literal(123)", "'a'.foo()"]
  ) {
    assertEquals(typeChecksAsConstant(cel), false, cel);
  }
});
