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
  analyzeContentExpressions,
  analyzeExpression,
  definitionRetargetSourcesChanged,
  expressionsAddedByEdit,
} from "./expression_references.ts";

function targets(cel: string) {
  const r = analyzeExpression(cel);
  return {
    data: [...r.dataTargets].sort(),
    model: [...r.modelTargets].sort(),
    dataWide: r.dataWide,
  };
}

Deno.test("analyzeExpression: model-scoped data accessors name their model", () => {
  for (
    const cel of [
      'data.latest("prod-db", "result").attributes.stdout',
      'data.version("prod-db", "result", 2)',
      'data.listVersions("prod-db", "result")',
      'data.findBySpec("prod-db", "result")',
    ]
  ) {
    assertEquals(targets(cel), {
      data: ["prod-db"],
      model: [],
      dataWide: false,
    }, cel);
  }
});

Deno.test("analyzeExpression: a namespaced target keeps its prefix", () => {
  assertEquals(targets('data.latest("ops:prod-db", "x")').data, [
    "ops:prod-db",
  ]);
});

Deno.test("analyzeExpression: a computed model argument reads any data", () => {
  for (
    const cel of [
      'data.latest(inputs.target, "x")',
      'data.latest("prod-" + "db", "x")',
      'data.latest(self.globalArguments.target, "x")',
      'data.latest("", "x")',
    ]
  ) {
    assertEquals(analyzeExpression(cel).dataWide, true, cel);
  }
});

Deno.test("analyzeExpression: cross-model accessors read any data", () => {
  assertEquals(
    analyzeExpression('data.query("modelName == \\"a\\"")').dataWide,
    true,
  );
  assertEquals(
    analyzeExpression('data.findByTag("env", "prod")').dataWide,
    true,
  );
});

Deno.test("analyzeExpression: an unknown data accessor fails closed", () => {
  assertEquals(
    analyzeExpression('data.somethingNew("prod-db")').dataWide,
    true,
  );
});

Deno.test("analyzeExpression: model map entries by dot, bracket and hyphen", () => {
  assertEquals(targets("model.prod.resource.state.x"), {
    data: ["prod"],
    model: [],
    dataWide: false,
  });
  assertEquals(targets("model.prod-db.resource.state.x").data, ["prod-db"]);
  assertEquals(targets('model["prod-db"].file.x').data, ["prod-db"]);
  assertEquals(targets('model[?"prod-db"].resource').data, ["prod-db"]);
});

Deno.test("analyzeExpression: definition accessors read the model, not its data", () => {
  assertEquals(targets("model.prod.input.globalArguments.x"), {
    data: [],
    model: ["prod"],
    dataWide: false,
  });
  assertEquals(targets("model.prod.definition.name").model, ["prod"]);
});

Deno.test("analyzeExpression: a whole model entry reads both", () => {
  assertEquals(targets('model["prod"]'), {
    data: ["prod"],
    model: ["prod"],
    dataWide: false,
  });
});

Deno.test("analyzeExpression: the model map with a computed key or whole reads any data", () => {
  for (
    const cel of [
      "model[inputs.target].resource",
      "model.map(m, m)",
      "size(model) > 0",
      'cel.bind(m, model, m["prod"].resource)',
    ]
  ) {
    assertEquals(analyzeExpression(cel).dataWide, true, cel);
  }
});

Deno.test("analyzeExpression: an aliased data namespace reads any data", () => {
  assertEquals(
    analyzeExpression('cel.bind(d, data, d.latest("prod", "x"))').dataWide,
    true,
  );
});

Deno.test("analyzeExpression: a bound variable shadows a namespace", () => {
  const r = analyzeExpression("[1].map(data, data + 1)");
  assertEquals(r.dataWide, false);
  const env = analyzeExpression('cel.bind(env, "x", env + "y")');
  assertEquals(env.usesEnv, false);
});

Deno.test("analyzeExpression: file.contents names its model", () => {
  assertEquals(targets('file.contents("prod", "log")').data, ["prod"]);
  assertEquals(
    analyzeExpression('file.contents(inputs.m, "log")').dataWide,
    true,
  );
});

Deno.test("analyzeExpression: model.method with literals names the method it runs", () => {
  const r = analyzeExpression('model.method("prod", "destroy", {"a": 1})');
  assertEquals(r.runTargets, [{ model: "prod", method: "destroy" }]);
  assertEquals(r.runsComputed, false);
  assertEquals([...r.dataTargets], ["prod"]);
});

Deno.test("analyzeExpression: model.method with a computed model or method runs any model", () => {
  for (
    const cel of [
      'model.method(inputs.m, "destroy")',
      'model.method("prod", inputs.method)',
      'model.other("prod", "x")',
    ]
  ) {
    const r = analyzeExpression(cel);
    assertEquals(r.runsComputed, true, cel);
    assertEquals(r.dataWide, true, cel);
  }
});

Deno.test("analyzeExpression: env reads are reported", () => {
  assertEquals(analyzeExpression("env.AWS_SECRET_ACCESS_KEY").usesEnv, true);
  assertEquals(analyzeExpression('env["X"] + "y"').usesEnv, true);
  assertEquals(analyzeExpression("self.name").usesEnv, false);
});

Deno.test("analyzeExpression: self and inputs reads are reported", () => {
  assertEquals(
    analyzeExpression("self.globalArguments.x").readsSelfOrInputs,
    true,
  );
  assertEquals(analyzeExpression("inputs.x").readsSelfOrInputs, true);
  assertEquals(analyzeExpression('"x"').readsSelfOrInputs, false);
});

Deno.test("analyzeExpression: nested references are all found", () => {
  const r = analyzeExpression(
    'data.latest(data.latest("cfg", "x").attributes.target, "y")',
  );
  assertEquals([...r.dataTargets], ["cfg"]);
  assertEquals(r.dataWide, true);
});

Deno.test("analyzeExpression: text that does not parse fails closed", () => {
  assertEquals(analyzeExpression("data.latest(").dataWide, true);
});

Deno.test("analyzeExpression: a constant reads nothing", () => {
  const r = analyzeExpression('literal("{{ model.x.resource }}")');
  assertEquals(r.dataWide, false);
  assertEquals(r.dataTargets.size, 0);
});

Deno.test("analyzeContentExpressions: keys each expression by its raw text", () => {
  const analyzed = analyzeContentExpressions(
    {
      globalArguments: {
        a: '${{ data.latest("prod", "x") }}',
        b: "plain",
        c: "${{ env.HOME }}-${{ env.HOME }}",
      },
    },
    [{ raw: "1 == 1", celExpression: "1 == 1", path: "assert" }],
  );
  assertEquals(analyzed.map((a) => a.raw).sort(), [
    '${{ data.latest("prod", "x") }}',
    "${{ env.HOME }}",
    "1 == 1",
  ]);
});

const contentOf = analyzeContentExpressions;

Deno.test("expressionsAddedByEdit: only expressions the stored content lacks", () => {
  const prod = '${{ data.latest("prod", "s") }}';
  const dev = '${{ data.latest("dev", "s") }}';
  const added = expressionsAddedByEdit(
    contentOf({ a: prod, note: "v1" }),
    contentOf({ a: prod, b: dev, note: "v1" }),
    false,
  );
  assertEquals(added.map((e) => e.raw), [dev]);
});

Deno.test("expressionsAddedByEdit: a rewritten expression is new even if its targets match", () => {
  const added = expressionsAddedByEdit(
    contentOf({ q: '${{ data.query("modelName == \\"dev\\"") }}' }),
    contentOf({ q: '${{ data.query("modelName == \\"prod\\"") }}' }),
    false,
  );
  assertEquals(added.length, 1);
});

Deno.test("expressionsAddedByEdit: a retarget re-checks only self- or inputs-computed data-wide expressions", () => {
  const computed = '${{ data.latest(self.globalArguments.t, "s") }}';
  const literal = '${{ data.latest("prod", "s") }}';
  const before = contentOf({ t: "dev", c: computed, l: literal });
  const after = contentOf({ t: "prod", c: computed, l: literal });
  assertEquals(
    expressionsAddedByEdit(before, after, true).map((e) => e.raw),
    [computed],
  );
  assertEquals(expressionsAddedByEdit(before, after, false), []);
});

Deno.test("expressionsAddedByEdit: a self-computed expression at a new path is checked", () => {
  const computed = '${{ data.latest(self.item, "s") }}';
  const literal = '${{ data.latest("dev", "s") }}';
  const before = contentOf({ a: computed, b: literal });
  // The same text copied to another place, where self may differ.
  const after = contentOf({ a: computed, c: computed, b: literal, d: literal });
  assertEquals(
    expressionsAddedByEdit(before, after, false).map((e) => e.raw),
    [computed],
  );
});

Deno.test("definitionRetargetSourcesChanged: what self and inputs read, expression text included", () => {
  const base = {
    name: "m",
    tags: {},
    globalArguments: { target: '${{ "public" }}' },
    methods: { run: { arguments: { x: "1" } } },
  };
  assertEquals(
    definitionRetargetSourcesChanged(base, {
      ...base,
      globalArguments: { target: '${{ "secret" }}' },
    }),
    true,
  );
  assertEquals(
    definitionRetargetSourcesChanged(base, { ...base, tags: { a: "b" } }),
    true,
  );
  // Method arguments are not part of self.
  assertEquals(
    definitionRetargetSourcesChanged(base, {
      ...base,
      methods: { run: { arguments: { x: "2" } } },
    }),
    false,
  );
  // Key order is not a change.
  assertEquals(
    definitionRetargetSourcesChanged(
      { ...base, globalArguments: { a: "1", b: "2" } },
      { ...base, globalArguments: { b: "2", a: "1" } },
    ),
    false,
  );
});

Deno.test("analyzeExpression: text that does not parse is assumed to read everything", () => {
  const r = analyzeExpression("env.(");
  assertEquals(r.dataWide, true);
  assertEquals(r.usesEnv, true);
  assertEquals(r.readsSelfOrInputs, true);
  assertEquals(r.runsComputed, true);
});
