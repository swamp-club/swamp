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
import { CelEvaluator } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  isSwampExpression,
  parsesAsCel,
  type SwampScope,
} from "./swamp_namespaces.ts";

// A CLI run: no steps/run/webhook bound; the definition declares two inputs.
const cliScope: SwampScope = {
  isBound: (root) => ["model", "self", "inputs", "data", "file"].includes(root),
  declaredInputs: new Set(["cidrBlock", "cfg"]),
};

Deno.test("isSwampExpression: true for expressions swamp owns", () => {
  for (
    const cel of [
      "inputs.cidrBlock",
      "inputs['cfg'].nope",
      "data.latest('producer', 'log').nope",
      "model.web-1a.resource.state.main.attributes.id",
      "self.globalArguments.target + '-' + inputs.cidrBlock",
      "1 + 'a'",
    ]
  ) {
    assertEquals(isSwampExpression(cel, cliScope), true, cel);
  }
});

Deno.test("isSwampExpression: false for another templating system's expressions", () => {
  for (
    const cel of [
      "github.sha",
      "secrets.TOKEN",
      "matrix.os",
      "inputs.cidrBlock + github.sha",
      // GitHub Actions contexts that share a swamp namespace name.
      "inputs.version",
      "steps.build.outputs.sha",
    ]
  ) {
    assertEquals(isSwampExpression(cel, cliScope), false, cel);
  }
});

Deno.test("isSwampExpression: steps is swamp's where the run binds it", () => {
  assertEquals(
    isSwampExpression("steps.build.outputs.sha", {
      ...cliScope,
      isBound: (root) => root === "steps",
    }),
    true,
  );
});

Deno.test("isSwampExpression: inputs that name no single input are not attributed", () => {
  assertEquals(isSwampExpression("inputs[self.key]", cliScope), false);
  assertEquals(isSwampExpression("size(inputs)", cliScope), false);
});

Deno.test("isSwampExpression: macro-bound variables are not roots", () => {
  assertEquals(
    isSwampExpression("inputs.cfg.map(h, h + '.local')", cliScope),
    true,
  );
  assertEquals(
    isSwampExpression("cel.bind(v, inputs.cidrBlock, v + 1)", cliScope),
    true,
  );
  // The bound name only shadows inside the macro body.
  assertEquals(
    isSwampExpression("inputs.cfg.map(h, h) + h", cliScope),
    false,
  );
});

Deno.test("isSwampExpression: false when the expression does not parse", () => {
  assertEquals(isSwampExpression("not valid cel !!!", cliScope), false);
});

Deno.test("parsesAsCel: parses text as evaluation does", () => {
  for (
    const cel of [
      "self.name",
      // Parses only once the hyphenated model ref is rewritten.
      "model.web-1a.resource.state.main.attributes.id",
      "'{{host.name}}'",
      "{'a': {'b': 1}}",
      // Optional syntax, which the top-level cel-js parse rejects.
      "data.latest('m', 'rec').?attributes.?name.orValue('{{')",
      "inputs.cfg[?'k'].orValue(1)",
    ]
  ) {
    assertEquals(parsesAsCel(cel), true, cel);
  }
});

Deno.test("parsesAsCel: agrees with the evaluator's own syntax check", () => {
  const evaluator = new CelEvaluator();
  for (
    const cel of [
      "self.name",
      "model.web-1a.resource.state.main.attributes.id",
      "data.latest('m', 'rec').?attributes.?name.orValue('')",
      "inputs.cfg[?'k'].orValue(1)",
      "cel.bind(v, inputs.cidrBlock, v + 1)",
      "'{{host.name",
      "self.name } && ls",
      "self.?name } && ls",
      "if eq(parameters.env, 'prod')",
    ]
  ) {
    assertEquals(parsesAsCel(cel), evaluator.validate(cel).valid, cel);
  }
});

Deno.test("parsesAsCel: false for text that is not CEL", () => {
  for (
    const cel of [
      "'{{host.name",
      "self.name } && ls",
      "if eq(parameters.env, 'prod')",
      "...",
      "",
    ]
  ) {
    assertEquals(parsesAsCel(cel), false, cel);
  }
});
