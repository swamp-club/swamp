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
import fc from "fast-check";
import { extractExpressions, readSetMap } from "./expression_parser.ts";
import {
  indexPath,
  keyPath,
  keySegment,
  ProvenanceMap,
} from "./provenance_map.ts";
import {
  attachBindingProvenance,
  bindingMapAt,
  spliceOrigin,
} from "./splice_origin.ts";

const key = fc.constantFrom(
  "a",
  "b",
  "x.y",
  "[0]",
  "[x",
  'q"',
  "",
  "__proto__",
);
const text = fc.array(
  fc.constantFrom(
    "plain",
    "${{ env.X }}",
    "${{ inputs.a }}",
    "${{ env.X",
    " }}",
    "${{ literal('}}') }}",
  ),
  { maxLength: 4 },
).map((parts) => parts.join(" "));
const tree = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    text,
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.array(tie("node"), { maxLength: 3 }),
    fc.array(fc.tuple(key, tie("node")), { maxLength: 3 }).map((entries) => {
      const record = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of entries) record[k] = v;
      return record;
    }),
  ),
})).node;

function referenceRaws(value: unknown, map: ProvenanceMap): Set<string> {
  const raws = new Set<string>();
  if (map.isWholeData) return raws;
  for (const expr of extractExpressions(value)) {
    if (!map.overlapsData(expr.path, expr.start!, expr.end!)) {
      raws.add(expr.raw);
    }
  }
  return raws;
}

function nodePaths(
  value: unknown,
  path = "",
): { all: string[]; objects: string[] } {
  const all = [path];
  const objects: string[] = [];
  const children: Array<[string, unknown]> = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => children.push([indexPath(path, i), item]));
  } else if (value !== null && typeof value === "object") {
    objects.push(path);
    for (const [key, item] of Object.entries(value)) {
      children.push([keyPath(path, key), item]);
    }
  }
  for (const [childPath, item] of children) {
    const child = nodePaths(item, childPath);
    all.push(...child.all);
    objects.push(...child.objects);
  }
  return { all, objects };
}

Deno.test("spliceOrigin: the authored raws of a computed read match the unskipped scan", () => {
  fc.assert(
    fc.property(
      tree,
      fc.array(fc.nat(), { maxLength: 4 }),
      fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { maxLength: 4 }),
      fc.array(fc.nat(), { maxLength: 4 }),
      (inputs, wholePicks, rangePicks, keyPicks) => {
        const paths = extractExpressions(inputs).map((e) => e.path);
        const nodes = nodePaths(inputs);
        const whole = wholePicks.map((i) => nodes.all[i % nodes.all.length]);
        const ranges = paths.length === 0 ? [] : rangePicks.map((
          [i, s, len],
        ) => [paths[i % paths.length], [[s % 20, s % 20 + len % 10]]] as const);
        const keys = nodes.objects.length === 0
          ? []
          : keyPicks.map((i) => nodes.objects[i % nodes.objects.length]);
        const map = ProvenanceMap.fromEntries(whole, ranges, keys);
        const context = attachBindingProvenance(
          { inputs: inputs as Record<string, unknown>, env: {}, model: {} },
          { inputs: map },
        );
        const result = { copied: inputs, text: "${{ env.X }} ${{ inputs.a }}" };
        const origin = spliceOrigin('inputs.a + ""', context, result);
        const expected = map.isAuthored
          ? undefined
          : referenceRaws(inputs, map);
        assertEquals(
          origin.authoredRaws === undefined
            ? undefined
            : [...origin.authoredRaws].sort(),
          expected === undefined ? undefined : [...expected].sort(),
        );
        assertEquals(
          origin.map.toData(),
          (expected === undefined
            ? ProvenanceMap.authored()
            : readSetMap(result, expected)).toData(),
        );
      },
    ),
    { numRuns: 2000 },
  );
});

const modelName = fc.constantFrom("db", "web.1", "a[0]", 'q"x', "", "[x");
const modelField = fc.constantFrom(
  "definition",
  "input",
  "resource",
  "file",
  "execution",
  "x.y",
);
const modelNamespace = fc.array(
  fc.tuple(
    modelName,
    fc.oneof(
      fc.array(fc.tuple(modelField, tree), { maxLength: 4 }),
      fc.constantFrom(null, "text"),
    ),
    fc.boolean(),
  ),
  { maxLength: 4 },
);

function buildModelNamespace(
  entries: [string, [string, unknown][] | null | string, boolean][],
) {
  const plain: Record<string, unknown> = {};
  const lazy: Record<string, unknown> = {};
  const loads = { count: 0 };
  entries.forEach(([name, fields, alias], i) => {
    let plainEntry: unknown = fields;
    let lazyEntry: unknown = fields;
    if (Array.isArray(fields)) {
      const p: Record<string, unknown> = {};
      const l: Record<string, unknown> = {};
      for (const [field, value] of fields) {
        p[field] = value;
        if (field === "definition" || field === "input") {
          l[field] = value;
        } else {
          Object.defineProperty(l, field, {
            enumerable: true,
            configurable: true,
            get() {
              loads.count++;
              return value;
            },
          });
        }
      }
      plainEntry = p;
      lazyEntry = l;
    }
    plain[name] = plainEntry;
    lazy[name] = lazyEntry;
    if (alias) {
      plain[`id-${i}`] = plainEntry;
      lazy[`id-${i}`] = lazyEntry;
    }
  });
  return { plain, lazy, loads };
}

function incrementalModelMap(
  model: Record<string, unknown>,
  only?: string,
): ProvenanceMap {
  let map = ProvenanceMap.authored();
  for (const name of only === undefined ? Object.keys(model) : [only]) {
    const entry = model[name];
    if (entry === null || typeof entry !== "object") continue;
    for (const field of Object.keys(entry)) {
      if (field === "definition" || field === "input") continue;
      map = map.withWholeData(
        only === undefined
          ? keyPath(keySegment(name), field)
          : keySegment(field),
      );
    }
  }
  return map;
}

Deno.test("spliceOrigin: a model read matches the unskipped scan and reads no data field", () => {
  fc.assert(
    fc.property(
      modelNamespace,
      fc.constantFrom<[string, boolean]>(
        ['model.db.input.?url.orValue("") + ""', false],
        ["string(size(model))", false],
        ['model[env.K].definition + ""', true],
        ["model.(", true],
      ),
      tree,
      (entries, [celExpression, readsOtherData], value) => {
        const { plain, lazy, loads } = buildModelNamespace(entries);
        const context = { model: lazy, env: {} };
        assertEquals(
          bindingMapAt(context, "model", []).toData(),
          incrementalModelMap(plain).toData(),
        );
        for (const name of Object.keys(plain)) {
          assertEquals(
            bindingMapAt(context, "model", [name]).toData(),
            incrementalModelMap(plain, name).toData(),
          );
        }
        const origin = spliceOrigin(celExpression, context, value);
        const modelMap = incrementalModelMap(plain);
        if (modelMap.isAuthored && !readsOtherData) {
          assertEquals(origin.authoredRaws, undefined);
          assertEquals(origin.map.isAuthored, true);
        } else {
          const expected = referenceRaws(plain, modelMap);
          for (const expr of extractExpressions(celExpression)) {
            expected.add(expr.raw);
          }
          assertEquals(
            [...origin.authoredRaws ?? []].sort(),
            [...expected].sort(),
          );
          assertEquals(
            origin.map.toData(),
            readSetMap(value, expected).toData(),
          );
        }
        for (const name of Object.keys(plain)) {
          const direct = spliceOrigin(
            `model[${JSON.stringify(name)}]`,
            context,
            lazy[name],
          );
          const map = incrementalModelMap(plain, name);
          assertEquals(direct.map.toData(), map.toData());
          assertEquals(
            [...direct.authoredRaws ?? []].sort(),
            map.isAuthored ? [] : [...referenceRaws(plain[name], map)].sort(),
          );
        }
        assertEquals(loads.count, 0);
      },
    ),
    { numRuns: 1000 },
  );
});
