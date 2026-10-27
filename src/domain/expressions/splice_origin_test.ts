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
import { keyPath, keySegment, ProvenanceMap } from "./provenance_map.ts";
import {
  attachBindingProvenance,
  bindingMapAt,
  bindingProvenanceOf,
  spliceOrigin,
} from "./splice_origin.ts";

const T = "${{ env.X }}";

function ctx(
  inputs: Record<string, unknown>,
  provenance: Parameters<typeof attachBindingProvenance>[1],
) {
  return attachBindingProvenance(
    {
      model: {
        db: {
          definition: { globalArguments: { url: T } },
          resource: { state: T },
        },
      },
      env: {},
      inputs,
      self: { id: "i", name: "n", version: 1, tags: {}, globalArguments: {} },
    },
    provenance,
  );
}

Deno.test("bindingMapAt: an unmarked binding is authored, data namespaces are data", () => {
  const c = ctx({ a: T }, {});
  assertEquals(bindingMapAt(c, "inputs", ["a"]).isAuthored, true);
  assertEquals(bindingMapAt(c, "self", ["name"]).isAuthored, true);
  assertEquals(bindingMapAt(c, "data", []).isWholeData, true);
  assertEquals(bindingMapAt(c, "steps", ["a"]).isWholeData, true);
  assertEquals(bindingMapAt(c, "env", ["X"]).isWholeData, true);
});

Deno.test("bindingMapAt: model definition fields are authored, resources are data", () => {
  const c = ctx({}, {});
  assertEquals(
    bindingMapAt(c, "model", ["db", "definition", "globalArguments"])
      .isAuthored,
    true,
  );
  assertEquals(bindingMapAt(c, "model", ["db", "resource"]).isWholeData, true);
  const whole = bindingMapAt(c, "model", ["db"]);
  assertEquals(whole.isWholeDataAt("resource"), true);
  assertEquals(whole.hasDataAtOrBelow("definition"), false);
});

Deno.test("bindingMapAt: a forEach item bound over a self field keeps its own map", () => {
  const c = ctx({}, { self: ProvenanceMap.authored().withWholeData("name") });
  assertEquals(bindingMapAt(c, "self", ["name"]).isWholeData, true);
  assertEquals(bindingMapAt(c, "self", ["id"]).isAuthored, true);
});

Deno.test("spliceOrigin: a static read takes the binding map, whatever the value holds", () => {
  const c = ctx({ a: "${{ env.X", b: T }, {
    inputs: ProvenanceMap.authored().withWholeData("a"),
  });
  assertEquals(spliceOrigin("inputs.a", c, "${{ env.X").map.isWholeData, true);
  assertEquals(spliceOrigin("inputs.b", c, T).map.isAuthored, true);
  assertEquals(
    spliceOrigin('inputs["a"]', c, "${{ env.X").map.isWholeData,
    true,
  );
});

Deno.test("spliceOrigin: a computed result over authored bindings only is authored", () => {
  const c = ctx({ b: T }, {});
  assertEquals(spliceOrigin('"x" + inputs.b', c, `x${T}`).map.isAuthored, true);
  assertEquals(spliceOrigin("'a' + 'b'", c, "ab").map.isAuthored, true);
});

Deno.test("spliceOrigin: a computed result reading data is data except vouched occurrences", () => {
  const c = ctx({ a: "data", b: T }, {
    inputs: ProvenanceMap.authored().withWholeData("a"),
  });
  const value = `data${T}`;
  const origin = spliceOrigin("inputs.a + inputs.b", c, value);
  assertEquals(origin.map.overlapsData("", 0, 4), true);
  assertEquals(origin.map.overlapsData("", 4, value.length), false);
  // A data namespace makes a computed result data.
  assertEquals(
    spliceOrigin('data.latest("m", "d").attributes.x + ""', c, "v").map
      .isWholeData,
    true,
  );
});

Deno.test("spliceOrigin: expression text literal() produces is data, even where the same text is authored", () => {
  // The bound input holds T authored, and literal() produces T again.
  const c = ctx({ b: T }, {});
  assertEquals(
    spliceOrigin(`literal('${T}')`, c, T).map.overlapsData("", 0, T.length),
    true,
  );
  const value = `${T} ${T}`;
  const origin = spliceOrigin(`inputs.b + ' ' + literal('${T}')`, c, value);
  assertEquals(
    origin.map.overlapsData("", value.length - T.length, value.length),
    true,
  );
  // literal() text with no expression in it leaves the result authored.
  assertEquals(
    spliceOrigin("literal('{{ x }}')", c, "{{ x }}").map.isAuthored,
    true,
  );
});

Deno.test("attachBindingProvenance: replaces the namespaces it names and keeps the others", () => {
  const c = ctx({}, { inputs: ProvenanceMap.data() });
  attachBindingProvenance(c, { self: ProvenanceMap.data() });
  assertEquals(bindingProvenanceOf(c).inputs?.isWholeData, true);
  assertEquals(bindingProvenanceOf(c).self?.isWholeData, true);
  // Object spread carries it to derived contexts.
  assertEquals(bindingProvenanceOf({ ...c }).inputs?.isWholeData, true);
});

Deno.test("spliceOrigin: vault results remain data after literal-name normalization", () => {
  const c = ctx({}, {});
  for (
    const source of ["vault.get(prod, data)", "vault.get(my//vault, data)"]
  ) {
    assertEquals(
      spliceOrigin(source, c, "reference").map.isWholeData,
      true,
      source,
    );
  }
});

/**
 * A model namespace shaped like ModelResolver.buildContext: each behavior
 * indexed by name and by id (one shared entry), definition fields beside
 * resource and file loaders that replace themselves on first read.
 */
function aliasedModelContext(names: string[]) {
  const loads = { count: 0 };
  const model: Record<string, unknown> = {};
  names.forEach((name, index) => {
    const entry: Record<string, unknown> = {
      input: {
        globalArguments: { url: '${{ vault.get("v", "' + name + '") }}' },
      },
      definition: { globalArguments: { url: "plain" } },
    };
    for (const field of ["resource", "file"]) {
      Object.defineProperty(entry, field, {
        configurable: true,
        enumerable: true,
        get() {
          loads.count++;
          const loaded = { spec: { main: { attributes: { leak: T } } } };
          Object.defineProperty(this, field, {
            value: loaded,
            writable: true,
            configurable: true,
            enumerable: true,
          });
          return loaded;
        },
      });
    }
    model[name] = entry;
    model[`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`] = entry;
  });
  model["not-an-entry"] = "text";
  model["null-entry"] = null;
  return { context: { model, env: {} }, loads };
}

/** The model namespace map as built one withWholeData call per path. */
function incrementalModelMap(model: Record<string, unknown>): ProvenanceMap {
  let map = ProvenanceMap.authored();
  for (const [name, entry] of Object.entries(model)) {
    if (entry === null || typeof entry !== "object") continue;
    for (const field of Object.keys(entry)) {
      if (field === "input" || field === "definition") continue;
      map = map.withWholeData(keyPath(keySegment(name), field));
    }
  }
  return map;
}

Deno.test("bindingMapAt: the whole model namespace map matches one built path by path", () => {
  const { context, loads } = aliasedModelContext([
    "db",
    "web.1",
    "a[0]",
    'q"uote',
    "[x",
    "",
  ]);
  (context.model as Record<string, Record<string, unknown>>).db.execution = {
    status: "ok",
  };
  assertEquals(
    bindingMapAt(context, "model", []).toData(),
    incrementalModelMap(context.model).toData(),
  );
  assertEquals(
    bindingMapAt(context, "model", ["web.1"]).toData(),
    ProvenanceMap.fromEntries(["resource", "file"], []).toData(),
  );
  assertEquals(loads.count, 0);
});

Deno.test("spliceOrigin: a computed model read vouches definition text without loading resources", () => {
  const { context, loads } = aliasedModelContext(["db", "web"]);
  const origin = spliceOrigin(
    'model.db.input.globalArguments.?url.orValue("none")',
    context,
    '${{ vault.get("v", "db") }}',
  );
  assertEquals(loads.count, 0);
  assertEquals(
    [...origin.authoredRaws ?? []].sort(),
    ['${{ vault.get("v", "db") }}', '${{ vault.get("v", "web") }}'],
  );
  // Resource text is data whether or not a loader already ran.
  void (context.model as Record<string, { resource: unknown }>).db.resource;
  const loaded = spliceOrigin(
    'model.db.input.globalArguments.?url.orValue("none")',
    context,
    T,
  );
  assertEquals(loaded.authoredRaws?.has(T), false);
  assertEquals(loaded.map.isWholeData, true);
});

Deno.test("spliceOrigin: a computed model read builds its map without per-path grafts", () => {
  const names = Array.from({ length: 200 }, (_, i) => `m${i}`);
  const { context } = aliasedModelContext(names);
  const graft = ProvenanceMap.prototype.graft;
  let grafts = 0;
  ProvenanceMap.prototype.graft = function (path, sub) {
    grafts++;
    return graft.call(this, path, sub);
  };
  try {
    spliceOrigin(
      'model.m0.input.globalArguments.?url.orValue("none")',
      context,
      "none",
    );
  } finally {
    ProvenanceMap.prototype.graft = graft;
  }
  assertEquals(grafts, 0);
});

Deno.test("spliceOrigin: root maps are reused within a call but refreshed after context mutation", () => {
  const { context } = aliasedModelContext(["db"]);
  let enumerations = 0;
  context.model = new Proxy(context.model, {
    ownKeys(target) {
      enumerations++;
      return Reflect.ownKeys(target);
    },
  });
  const expression = 'model.db.input.globalArguments.?url.orValue("none")';
  spliceOrigin(expression, context, "none");
  // One map construction and one authored-text scan.
  assertEquals(enumerations, 2);
  const entry = context.model.db as Record<string, unknown>;
  entry.execution = { output: T };
  const origin = spliceOrigin(expression, context, T);
  assertEquals(enumerations, 4);
  assertEquals(origin.authoredRaws?.has(T), false);
  assertEquals(origin.map.isWholeData, true);
});

Deno.test("spliceOrigin: partial ranges and data-origin keys preserve authored sibling values", () => {
  const other = "${{ env.Y }}";
  const inputs = { "x.y": [T, `${T} ${other}`], keep: other };
  const map = ProvenanceMap.fromEntries(
    ['["x.y"][0]'],
    [['["x.y"][1]', [[1, 2]]]],
    [""],
  );
  const origin = spliceOrigin(
    'inputs["x.y"] + ""',
    attachBindingProvenance({ inputs }, { inputs: map }),
    `${T} ${other}`,
  );
  assertEquals([...origin.authoredRaws ?? []], [other]);
  assertEquals(origin.map.overlapsData("", 0, T.length), true);
  assertEquals(
    origin.map.overlapsData("", T.length + 1, T.length + 1 + other.length),
    false,
  );
});

Deno.test("spliceOrigin: skips whole-data object properties and array slots before reading them", () => {
  const fail = () => {
    throw new Error("whole-data getter was read");
  };
  const inputs = { list: [T, "unused"], keep: T };
  Object.defineProperty(inputs.list, 1, { get: fail });
  Object.defineProperty(inputs, "data", { enumerable: true, get: fail });
  const origin = spliceOrigin(
    'inputs.keep + ""',
    attachBindingProvenance({ inputs }, {
      inputs: ProvenanceMap.fromEntries(["data", "list[1]"], []),
    }),
    T,
  );
  assertEquals([...origin.authoredRaws ?? []], [T]);
  assertEquals(origin.map.isAuthored, true);
});
