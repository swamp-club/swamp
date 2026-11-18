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
  importedSpecifiersAt,
  importedSpecifiersIn,
  parseExtensionModule,
} from "./imports.ts";

// Statements that hold import-looking text, quotes and backticks but no
// import: each must leave the imports around it read as written.
const noise = fc.constantFrom(
  "var s = \"import x from 'npm:no@1'\";",
  'var t = `import y from "npm:no@1"`;',
  "var r = /'/;",
  'var q = /"/.test("x");',
  "var b = /[`'\"]/g;",
  "var d = 10 / 2 / 1;",
  '// import z from "npm:no@1"\n',
  '/* export * from "npm:no@1" */',
  "var n = `${`${'nested'}`}`;",
  "var o = { import: 1, from: 2 };",
);

const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);

const importOf = fc.tuple(
  fc.constantFrom("npm:", "jsr:@s/", "./", "node:"),
  name,
  fc.constantFrom(
    (spec: string, i: number) => `import v${i} from "${spec}";`,
    (spec: string) => `import "${spec}";`,
    (spec: string) => `export * from '${spec}';`,
    (spec: string, i: number) => `const v${i} = import("${spec}");`,
  ),
);

Deno.test("importedSpecifiersAt: reads exactly the imports among noise", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(noise, importOf), { maxLength: 12 }),
      fc.boolean(),
      (parts, sameLine) => {
        const expected: string[] = [];
        const lines = parts.map((part, i) => {
          if (typeof part === "string") return part;
          const [prefix, n, write] = part;
          const spec = `${prefix}${n}`;
          expected.push(spec);
          return write(spec, i);
        });
        const source = lines.join(sameLine ? " " : "\n") + "\n";
        const sites = importedSpecifiersAt(source, { path: "m.ts" });
        assertEquals(sites?.map((s) => s.specifier), expected);
        for (const site of sites ?? []) {
          assertEquals(
            source.slice(site.start + 1, site.end - 1),
            site.specifier,
          );
        }
      },
    ),
    { numRuns: 2_000 },
  );
});

// Statements that can hold a site anywhere: at the top, nested below a
// declaration, or behind keyword text the pruning must not trust.
const statement = fc.oneof(
  noise.map((text) => () => text),
  fc.constantFrom(
    () => 'import("./top.ts");',
    (i: number) => `export const f${i} = () => import("./f.ts");`,
    (i: number) =>
      `export const d${i} = async () => (await import("./d.ts")).d;`,
    () => 'declare module "m" { export * from "./inner.ts"; }',
    (i: number) => `function g${i}() { import nested from "./n.ts"; }`,
    (i: number) => `type T${i} = typeof import("./t.ts");`,
    (i: number) => `function h${i}(x: typeof import("./p.ts")) {}`,
    (i: number) => `import e${i} = require("./e.ts");`,
    (i: number) => `export const s${i} = "import x from ./not.ts";`,
    (i: number) =>
      `var __export${i} = 1; module.exports = { importKeyPair: 1 };`,
    (i: number) => `export const o${i} = { import: () => import("./o.ts") };`,
    () => "a.import(1);",
    (i: number) => `@dec(import("./dec.ts")) export class C${i} {}`,
    (i: number) => `@dec(import("./cls.ts")) class K${i} {}`,
    (i: number) => `import a${i} from "npm:a@1";`,
    () => 'export * from "./star.ts";',
  ),
);

Deno.test("importedSpecifiersAt: the pruned walk finds what the full walk finds", () => {
  fc.assert(
    fc.property(
      fc.array(statement, { maxLength: 12 }),
      fc.boolean(),
      fc.boolean(),
      (parts, sameLine, withDefault) => {
        const lines = parts.map((write, i) => write(i));
        if (withDefault) {
          lines.push('export default async () => (await import("./x.ts")).x;');
        }
        const source = lines.join(sameLine ? " " : "\n") + "\n";
        const parsed = parseExtensionModule(source, { path: "m.ts" });
        if (!parsed.ok) throw new Error(parsed.reason);
        assertEquals(
          importedSpecifiersAt(source, { path: "m.ts" }),
          importedSpecifiersIn(parsed.program),
        );
      },
    ),
    { numRuns: 2_000 },
  );
});
