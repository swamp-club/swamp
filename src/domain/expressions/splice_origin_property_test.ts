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
import { indexPath, keyPath, ProvenanceMap } from "./provenance_map.ts";
import { attachBindingProvenance, spliceOrigin } from "./splice_origin.ts";

// Keys that stress path spelling: plain, dotted, bracketed, quoted, empty.
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

/** The authored raws of `value` as found before the scan skipped data. */
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

/** Real node paths, including container ancestors and keys needing quoting. */
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
        // Data paths drawn from the paths the value actually has, plus
        // their ancestors, so whole-data subtrees nest and overlap.
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
