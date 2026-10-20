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
  inputNamesRead,
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

Deno.test("inputNamesRead: names each input an expression reads", () => {
  const read = (cel: string) => {
    const { names, opaque } = inputNamesRead(cel);
    return { names: [...names].sort(), opaque };
  };
  assertEquals(read("inputs.target"), { names: ["target"], opaque: false });
  assertEquals(read('inputs["target"] + inputs.region'), {
    names: ["region", "target"],
    opaque: false,
  });
  assertEquals(read("inputs.?token.orValue('')"), {
    names: ["token"],
    opaque: false,
  });
  assertEquals(read("has(inputs.force)"), { names: ["force"], opaque: false });
  assertEquals(read("self.name + 'x'"), { names: [], opaque: false });
});

Deno.test("inputNamesRead: inputs read whole, by computed key, or unparsed is opaque", () => {
  assertEquals(inputNamesRead("inputs").opaque, true);
  assertEquals(inputNamesRead("inputs[self.key]").opaque, true);
  assertEquals(inputNamesRead("size(inputs) > 0").opaque, true);
  assertEquals(inputNamesRead("not cel (").opaque, true);
});

Deno.test("inputNamesRead: reads through run.inputs count, other run fields do not", () => {
  assertEquals(inputNamesRead("run.inputs.target"), {
    names: new Set(["target"]),
    opaque: false,
  });
  assertEquals(inputNamesRead('run.inputs["target"]'), {
    names: new Set(["target"]),
    opaque: false,
  });
  assertEquals(inputNamesRead("run.id + run.workflowName"), {
    names: new Set(),
    opaque: false,
  });
  assertEquals(inputNamesRead("run.inputs").opaque, true);
  assertEquals(inputNamesRead("run.inputs[self.key]").opaque, true);
  assertEquals(inputNamesRead("run[self.field]").opaque, true);
  assertEquals(inputNamesRead("string(run)").opaque, true);
  assertEquals(inputNamesRead("[1].map(run, run.inputs)").opaque, false);
});

Deno.test("inputNamesRead: an inputs variable a macro binds is not the workflow's", () => {
  assertEquals(inputNamesRead("[1].map(inputs, inputs + 1)"), {
    names: new Set(),
    opaque: false,
  });
  assertEquals(inputNamesRead("cel.bind(inputs, 1, inputs + 1)"), {
    names: new Set(),
    opaque: false,
  });
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
