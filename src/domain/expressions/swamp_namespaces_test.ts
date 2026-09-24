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
  containsSwampExpression,
  isForeignExpression,
  isSwampExpression,
  type SwampScope,
  WIDEST_SWAMP_SCOPE,
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

Deno.test("isSwampExpression: the widest scope claims every swamp namespace and input", () => {
  for (
    const cel of [
      "inputs.version",
      "steps.build.outputs.sha",
      "workflow.name",
      "vault.get('v', 'k')",
    ]
  ) {
    assertEquals(isSwampExpression(cel, WIDEST_SWAMP_SCOPE), true, cel);
  }
});

Deno.test("isForeignExpression: true for text no swamp evaluation could own", () => {
  for (
    const cel of [
      "github.sha",
      "secrets.TOKEN",
      "matrix.os",
      "github.event.model.foo.resource.x",
    ]
  ) {
    assertEquals(isForeignExpression(cel), true, cel);
  }
});

Deno.test("isForeignExpression: false for text in a swamp namespace", () => {
  // GitHub Actions contexts that share a swamp namespace name stay claimed.
  for (const cel of ["inputs.version", "steps.build.outputs.sha", "env.HOME"]) {
    assertEquals(isForeignExpression(cel), false, cel);
  }
});

Deno.test("isForeignExpression: false for text that does not parse", () => {
  assertEquals(isForeignExpression("not valid cel !!!"), false);
  // What extractExpressions leaves of ${{ "a}}" + inputs.x }}.
  assertEquals(isForeignExpression('"a'), false);
});

Deno.test("containsSwampExpression: false when every expression is foreign", () => {
  assertEquals(containsSwampExpression("deploy ${{ github.sha }}"), false);
  assertEquals(
    containsSwampExpression({ a: ["${{ matrix.os }}", "{{host.name}}"] }),
    false,
  );
  assertEquals(containsSwampExpression("plain text"), false);
});

Deno.test("containsSwampExpression: true when any nested expression is not foreign", () => {
  assertEquals(
    containsSwampExpression({
      a: ["${{ github.sha }}", "${{ inputs.region }}"],
    }),
    true,
  );
  assertEquals(containsSwampExpression('${{ vault.get("v", "k") }}'), true);
  assertEquals(containsSwampExpression('${{ "a}}" + inputs.x }}'), true);
});
