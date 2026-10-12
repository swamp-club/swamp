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
import { ProvenanceMap } from "./provenance_map.ts";
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

Deno.test("attachBindingProvenance: replaces the namespaces it names and keeps the others", () => {
  const c = ctx({}, { inputs: ProvenanceMap.data() });
  attachBindingProvenance(c, { self: ProvenanceMap.data() });
  assertEquals(bindingProvenanceOf(c).inputs?.isWholeData, true);
  assertEquals(bindingProvenanceOf(c).self?.isWholeData, true);
  // Object spread carries it to derived contexts.
  assertEquals(bindingProvenanceOf({ ...c }).inputs?.isWholeData, true);
});
