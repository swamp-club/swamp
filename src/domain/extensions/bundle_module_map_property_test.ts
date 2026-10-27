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
import {
  BundleModuleMap,
  dependencyLabel,
  isDependencyModulePath,
} from "./bundle_module_map.ts";
import { parseExtensionSourceWithComments } from "./extension_source_ast.ts";

const arbSegment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/);

const arbAuthorPath = fc.tuple(
  fc.array(arbSegment, { minLength: 0, maxLength: 3 }),
  arbSegment,
).map(([dirs, file]) => [...dirs, `${file}.ts`].join("/"))
  // A generated segment can spell a cache dir (`deno_dir`); such a path is
  // a dependency's by design, not an author's.
  .filter((path) => !isDependencyModulePath(path));

const arbCachePrefix = fc.constantFrom(
  "../../.swamp/deno-cache",
  "../../../Library/Caches/deno",
  "../.cache/deno",
  "..\\AppData\\Local\\deno",
);

const arbNpmTail = fc.tuple(arbSegment, arbSegment).map(([pkg, file]) =>
  `${pkg}/1.0.0/${file}.js`
);

const arbDependencyPath = fc.tuple(arbCachePrefix, arbNpmTail).map((
  [prefix, tail],
) => `${prefix}/npm/registry.npmjs.org/${tail}`);

const arbModule = fc.record({
  dependency: fc.boolean(),
  author: arbAuthorPath,
  dep: arbDependencyPath,
  // Statements in the module's body.
  body: fc.integer({ min: 1, max: 4 }),
});

Deno.test("BundleModuleMap.moduleAt: every body line maps to the module whose comment precedes it", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 3 }),
      fc.array(arbModule, { minLength: 1, maxLength: 8 }),
      (prelude, modules) => {
        const lines: string[] = [];
        const expected: Array<
          { line: number; path?: string; dependency?: boolean }
        > = [];
        for (let i = 0; i < prelude; i++) {
          lines.push(`var p${i} = ${i};`);
          expected.push({ line: lines.length });
        }
        modules.forEach((m, mi) => {
          const path = m.dependency ? m.dep : m.author;
          lines.push(`// ${path}`);
          for (let i = 0; i < m.body; i++) {
            lines.push(`var m${mi}_${i} = ${i};`);
            expected.push({
              line: lines.length,
              path,
              dependency: m.dependency,
            });
          }
        });
        const source = lines.join("\n");
        const parsed = parseExtensionSourceWithComments(source);
        if (!parsed) throw new Error("generated bundle does not parse");
        for (
          const map of [
            BundleModuleMap.fromComments(source, parsed.comments),
            BundleModuleMap.fromText(source),
          ]
        ) {
          assertEquals(map.moduleCount, modules.length);
          for (const e of expected) {
            const got = map.moduleAt(e.line);
            if (e.path === undefined) {
              assertEquals(got, { origin: "unattributed" });
            } else {
              assertEquals(got, {
                path: e.path,
                origin: e.dependency ? "dependency" : "author",
              });
            }
          }
        }
      },
    ),
  );
});

Deno.test("dependencyLabel: one dependency reads alike from any cache location", () => {
  fc.assert(
    fc.property(arbCachePrefix, arbCachePrefix, arbNpmTail, (a, b, tail) => {
      assertEquals(
        dependencyLabel(`${a}/npm/registry.npmjs.org/${tail}`),
        dependencyLabel(`${b}/npm/registry.npmjs.org/${tail}`),
      );
      assertEquals(
        dependencyLabel(`${a}/npm/registry.npmjs.org/${tail}`),
        `npm:${tail}`,
      );
    }),
  );
});
