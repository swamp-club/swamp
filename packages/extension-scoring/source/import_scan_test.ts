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
import { statementsWithNestedImports } from "./import_scan.ts";
import { parseExtensionModule, type SyntaxNode } from "./parse.ts";

// The source lines of the statements picked for a deep walk.
function picked(lines: string[], path = "m.ts"): string[] {
  const source = lines.join("\n");
  const parsed = parseExtensionModule(source, { path });
  if (!parsed.ok) throw new Error(parsed.reason);
  const body = parsed.program.body as SyntaxNode[];
  return [...statementsWithNestedImports(body, source)].sort((a, b) => a - b)
    .map((i) => source.slice(body[i].start!, body[i].end!));
}

Deno.test("statementsWithNestedImports: top-level declarations are read at their top", () => {
  assertEquals(
    picked([
      'import a from "npm:a@1";',
      'import "./side.ts";',
      'export { b } from "./b.ts";',
      'export * from "./star.ts";',
      "export const c = 1;",
      "export default function d() {}",
      "const e = 2;",
    ]),
    [],
  );
});

Deno.test("statementsWithNestedImports: a top-level import() statement is walked", () => {
  assertEquals(picked(['import("./x.ts");', "const y = 1;"]), [
    'import("./x.ts");',
  ]);
});

Deno.test("statementsWithNestedImports: a declaration holding import() is walked", () => {
  assertEquals(
    picked([
      'export const f = () => import("./f.ts");',
      'export default async () => (await import("./g.ts")).g;',
      "const h = 3;",
    ]),
    [
      'export const f = () => import("./f.ts");',
      'export default async () => (await import("./g.ts")).g;',
    ],
  );
});

Deno.test("statementsWithNestedImports: nested declarations and import types are walked", () => {
  assertEquals(
    picked([
      'declare module "m" { export * from "./inner.ts"; }',
      'function f() { import nested from "./n.ts"; }',
      'type T = typeof import("./t.ts");',
      'function g(x: typeof import("./p.ts")) {}',
      'import e = require("./e.ts");',
    ]),
    [
      'declare module "m" { export * from "./inner.ts"; }',
      'function f() { import nested from "./n.ts"; }',
      'type T = typeof import("./t.ts");',
      'function g(x: typeof import("./p.ts")) {}',
      'import e = require("./e.ts");',
    ],
  );
});

Deno.test("statementsWithNestedImports: keyword text inside a statement is walked, between statements is not", () => {
  assertEquals(
    picked([
      '// import x from "./comment.ts"',
      '/* export * from "./block.ts" */',
      'const s = "import x from ./string.ts";',
      "const o = { import: 1 };",
      "const v = 1;",
    ]),
    ['const s = "import x from ./string.ts";', "const o = { import: 1 };"],
  );
});

Deno.test("statementsWithNestedImports: keyword text in a longer ASCII name is not a keyword", () => {
  assertEquals(
    picked([
      "var __export = (t, a) => t;",
      "module.exports = { importKeyPair: 1, reexport: 2, export$: 3 };",
      "const _import = 1, import_ = 2, import2 = 3;",
    ], "m.js"),
    [],
  );
});

Deno.test("statementsWithNestedImports: a member named import or a non-ASCII neighbour is walked", () => {
  assertEquals(
    picked([
      "a.import(1);",
      "const éimport = 1;",
      "const v = 1;",
    ]),
    ["a.import(1);", "const éimport = 1;"],
  );
});
