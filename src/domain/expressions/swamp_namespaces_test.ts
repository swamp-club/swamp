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
  containsSwampExpression,
  failedOnForeignRoot,
  foreignRootsBesideVault,
  isForeignExpression,
  isSwampExpression,
  misspeltSwampNamespace,
  parsesAsCel,
  readsSwampBinding,
  type SwampScope,
  unresolvableVaultArguments,
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
  for (
    const cel of [
      "inputs.version",
      "steps.build.outputs.sha",
      "env.HOME",
      // inputs read whole or with a computed key.
      "inputs[env.STAGE]",
      'inputs["region-" + env.STAGE]',
      "size(inputs)",
      "inputs",
    ]
  ) {
    assertEquals(isForeignExpression(cel), false, cel);
  }
});

Deno.test("isForeignExpression: false for text that does not parse", () => {
  assertEquals(isForeignExpression("not valid cel !!!"), false);
  // An unterminated string, as a malformed expression arrives.
  assertEquals(isForeignExpression('"a'), false);
  // Optional syntax parses for evaluation (parsesAsCel) but not for
  // isSwampExpression, so it cannot be attributed and stays claimed.
  assertEquals(parsesAsCel("github.?sha"), true);
  assertEquals(isForeignExpression("github.?sha"), false);
  assertEquals(isForeignExpression("inputs.?version"), false);
});

Deno.test("readsSwampBinding: true when any root is a swamp namespace", () => {
  for (
    const cel of [
      'vault.get("v", "k")',
      "vault.get(v, k)",
      "self.name",
      '"label-" + self.name',
      "inputs.region",
      "env.HOME",
      'file.contents("m", "f")',
      'data.latest("m", "d")',
      "model.other.resource.x",
      "steps.build.outputs.sha",
      // A foreign root does not hide a swamp one.
      'github.sha || data.latest("m", "d")',
      "[1].exists(x, self.name == x)",
    ]
  ) {
    assertEquals(readsSwampBinding(cel), true, cel);
  }
});

Deno.test("readsSwampBinding: true for text the attribution grammar cannot parse", () => {
  assertEquals(readsSwampBinding("not valid cel !!!"), true);
  assertEquals(readsSwampBinding('"a'), true);
  assertEquals(readsSwampBinding("inputs.?x"), true);
  assertEquals(readsSwampBinding("github.?sha"), true);
});

Deno.test("readsSwampBinding: false when every root is foreign or there is none", () => {
  for (
    const cel of [
      "github.sha",
      "secrets.TOKEN",
      "matrix.os",
      // Macro-bound variables are not roots.
      "[1, 2].map(x, x + 1)",
      "1",
      '"a" + "b"',
    ]
  ) {
    assertEquals(readsSwampBinding(cel), false, cel);
  }
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

Deno.test("isSwampExpression: a bare-token vault.get argument is a literal name, as the resolver reads it (swamp-club#3360)", () => {
  for (
    const cel of [
      "vault.get(t, KEY)",
      "vault.get(my-vault, API_KEY)",
      "vault.get('t', KEY)",
      'vault.get(t, "KEY")',
      "vault.get( t , KEY )",
      '"pre-" + vault.get(t, KEY)',
      "vault.get(a, b) + vault.get(c, d)",
      "vault.get(my/vault, a@b)",
      "vault.get(`t`, `KEY`)",
      "vault.get(`my vault`, KEY) + '-x'",
    ]
  ) {
    assertEquals(isSwampExpression(cel, WIDEST_SWAMP_SCOPE), true, cel);
    assertEquals(isForeignExpression(cel), false, cel);
    assertEquals(readsSwampBinding(cel), true, cel);
    assertEquals(containsSwampExpression("${{ " + cel + " }}"), true, cel);
  }
});

Deno.test("isSwampExpression: a dotted bare vault.get argument is CEL and keeps its roots", () => {
  assertEquals(
    isSwampExpression("vault.get(inputs.v, inputs.k)", WIDEST_SWAMP_SCOPE),
    true,
  );
  // The scope declares cfg, and no input named v.
  const scope: SwampScope = {
    isBound: () => true,
    declaredInputs: cliScope.declaredInputs,
  };
  assertEquals(isSwampExpression("vault.get(inputs.v, KEY)", scope), false);
  assertEquals(isSwampExpression("vault.get(inputs.cfg, KEY)", scope), true);
});

Deno.test("isForeignExpression: a dotted bare vault.get argument that reads nothing swamp provides is not another system's text", () => {
  // The resolver evaluates it and fails; nothing passes through.
  for (
    const cel of [
      "vault.get(t, db.password)",
      "vault.get(github.repo, KEY)",
      "vault.get(t.x, a.b)",
      "vault.get(t, db..x)",
    ]
  ) {
    assertEquals(isForeignExpression(cel), false, cel);
    assertEquals(isSwampExpression(cel, WIDEST_SWAMP_SCOPE), true, cel);
    assertEquals(containsSwampExpression("${{ " + cel + " }}"), true, cel);
  }
});

Deno.test("unresolvableVaultArguments: names dotted bare arguments that read nothing swamp provides", () => {
  assertEquals(unresolvableVaultArguments("vault.get(t, db.password)"), [
    "db.password",
  ]);
  assertEquals(unresolvableVaultArguments("vault.get(t.x, github.repo)"), [
    "t.x",
    "github.repo",
  ]);
  for (
    const cel of [
      "vault.get(t, KEY)",
      "vault.get('t', 'db.password')",
      "vault.get(inputs.v, self.name)",
      "vault.get(t, model.my-vpc.resource.vpc.main.attributes.key)",
      "literal('vault.get(t, db.password)')",
      "github.sha",
    ]
  ) {
    assertEquals(unresolvableVaultArguments(cel), [], cel);
  }
});

Deno.test("isForeignExpression: never true for text that reads vault, whatever else it reads (swamp-club#3360)", () => {
  // The runtime pass resolves and evaluates every such expression, so it
  // fails on the other root instead of passing through.
  for (
    const cel of [
      "vault.get(t, KEY) + github.sha",
      "vault.get('t', 'KEY') + github.sha",
      "github.sha + vault.get(t, KEY)",
      "vault.get('t') + github.sha",
      "cel.bind(v, vault, github.sha)",
    ]
  ) {
    assertEquals(isForeignExpression(cel), false, cel);
    assertEquals(containsSwampExpression("${{ " + cel + " }}"), true, cel);
    // The every-root rule is unchanged: it is not all swamp's.
    assertEquals(isSwampExpression(cel, WIDEST_SWAMP_SCOPE), false, cel);
  }
  // vault reached through a member, or named only in text, is not the
  // namespace.
  assertEquals(isForeignExpression("github.vault.get(t, KEY)"), true);
  assertEquals(isForeignExpression("github.sha + 'vault.get(t, KEY)'"), true);
  assertEquals(isForeignExpression("t + KEY"), true);
});

Deno.test("foreignRootsBesideVault: names the roots swamp does not provide in an expression that reads vault", () => {
  assertEquals(foreignRootsBesideVault("vault.get(t, KEY) + github.sha"), [
    "github",
  ]);
  assertEquals(
    foreignRootsBesideVault("matrix.os + vault.get('t', 'KEY') + github.sha"),
    ["matrix", "github"],
  );
  for (
    const cel of [
      "vault.get(t, KEY)",
      "vault.get(t, KEY) + self.name + inputs.region",
      "vault.get(t, db.password)",
      "github.sha",
      "vault.get(t, KEY) +",
    ]
  ) {
    assertEquals(foreignRootsBesideVault(cel), [], cel);
  }
});

Deno.test("misspeltSwampNamespace: names the namespace a root nearly spells", () => {
  const cases: [string, string, string][] = [
    ["input.region", "input", "inputs"],
    ["modle.vpc.resource", "modle", "model"],
    ["vualt.get('v', 'k')", "vualt", "vault"],
    ["step.build.outputs.sha", "step", "steps"],
    ["envs.HOME", "envs", "env"],
    ["self.h + input.region", "input", "inputs"],
  ];
  for (const [cel, root, namespace] of cases) {
    assertEquals(misspeltSwampNamespace(cel), { root, namespace }, cel);
  }
});

Deno.test("misspeltSwampNamespace: undefined for swamp's own roots, other systems' roots and text that does not parse", () => {
  const cases = [
    "inputs.region",
    "self.h + steps.build.outputs.sha",
    // What GitHub Actions binds and swamp does not.
    "github.sha",
    "matrix.os",
    "secrets.TOKEN",
    "vars.REGION",
    "needs.build.outputs.sha",
    "runner.os",
    "job.status",
    "strategy.fail-fast",
    // Ordinary words near a namespace.
    "event.name",
    "ref.name",
    "node.name",
    "stats.count",
    "date.year",
    "mode.name",
    "files.changed",
    '"unclosed',
  ];
  for (const cel of cases) {
    assertEquals(misspeltSwampNamespace(cel), undefined, cel);
  }
});

Deno.test("failedOnForeignRoot: true only for an unknown variable that is not a swamp namespace", () => {
  assertEquals(
    failedOnForeignRoot(new Error("Unknown variable: github")),
    true,
  );
  // Found through the cause chain of a wrapping error.
  assertEquals(
    failedOnForeignRoot(
      new Error("Invalid expression", {
        cause: new Error("Unknown variable: matrix"),
      }),
    ),
    true,
  );
  assertEquals(
    failedOnForeignRoot(new Error("Unknown variable: inputs")),
    false,
  );
  assertEquals(failedOnForeignRoot(new Error("datastore unreachable")), false);
  assertEquals(failedOnForeignRoot("Unknown variable: github"), false);
});
