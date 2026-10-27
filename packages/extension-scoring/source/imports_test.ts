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
import { importedSpecifiers, importedSpecifiersAt } from "./imports.ts";

Deno.test("importedSpecifiers: every import form, in source order", () => {
  const source = [
    'import a from "npm:a@1";',
    'import "npm:side@1";',
    'export { b } from "jsr:@s/b@1";',
    'export * from "./star.ts";',
    'export * as ns from "./ns.ts";',
    'const c = await import("npm:c@1");',
    'type D = typeof import("npm:d@1");',
    'import e = require("npm:e@1");',
    "export const all = [a, c];",
  ].join("\n");
  assertEquals(importedSpecifiers(source, { path: "m.ts" }), [
    "npm:a@1",
    "npm:side@1",
    "jsr:@s/b@1",
    "./star.ts",
    "./ns.ts",
    "npm:c@1",
    "npm:d@1",
  ]);
});

Deno.test("importedSpecifiers: text that is not an import is not read", () => {
  const source = [
    '// import x from "npm:comment@1";',
    '/* import y from "npm:block@1"; */',
    "export const s = \"import z from 'npm:string@1'\";",
    'export const t = `import w from "npm:template@1"`;',
    'export const r = /import v from "npm:regex@1"/;',
    "export const dyn = (n: string) => import(`npm:${n}`);",
    'export const m = { import: "npm:member@1" };',
  ].join("\n");
  assertEquals(importedSpecifiers(source, { path: "m.ts" }), []);
});

Deno.test("importedSpecifiers: a quote in a regex literal does not hide a later import", () => {
  const source =
    'export const quoted = /"/.test("x"); import ms from "npm:ms@2.1.3";\n' +
    "export const model = [quoted, ms];\n";
  assertEquals(importedSpecifiers(source, { path: "m.ts" }), ["npm:ms@2.1.3"]);
});

Deno.test("importedSpecifiers: a backtick in a regex literal does not hide a later import", () => {
  const source = "const re = /[`'\"]/g;\n" +
    'import { a } from "jsr:@std/assert@1.0.19";\n' +
    'import "node:https";\n' +
    "export { a, re };\n";
  assertEquals(importedSpecifiers(source, { path: "bundles/m.js" }), [
    "jsr:@std/assert@1.0.19",
    "node:https",
  ]);
});

Deno.test("importedSpecifiers: JavaScript the TypeScript plugin misreads", () => {
  const source = "const a = 1, b = 2;\nconst d = a ? (b) : c => c;\n" +
    'import x from "npm:x@1";\nexport { d, x };\n';
  assertEquals(importedSpecifiers(source, { path: "bundles/m.js" }), [
    "npm:x@1",
  ]);
});

Deno.test("importedSpecifiers: a module that does not parse writes none", () => {
  const source = 'import a from "npm:a@1";\nexport const broken = ;\n';
  assertEquals(importedSpecifiers(source, { path: "m.ts" }), []);
});

Deno.test("importedSpecifiersAt: null for a module that does not parse", () => {
  assertEquals(
    importedSpecifiersAt("export const broken = ;\n", { path: "m.ts" }),
    null,
  );
});

Deno.test("importedSpecifiersAt: offsets cover the quotes", () => {
  const source = "import a from \"npm:a@1\";\nimport b from './b.ts';\n";
  const sites = importedSpecifiersAt(source, { path: "m.ts" });
  assertEquals(sites?.map((s) => source.slice(s.start, s.end)), [
    '"npm:a@1"',
    "'./b.ts'",
  ]);
  assertEquals(sites?.map((s) => s.specifier), ["npm:a@1", "./b.ts"]);
});

Deno.test("importedSpecifiersAt: offsets are UTF-16 offsets", () => {
  const source = 'const e = "😀";\nimport a from "npm:a@1";\n';
  const [site] = importedSpecifiersAt(source, { path: "m.ts" }) ?? [];
  assertEquals(source.slice(site.start, site.end), '"npm:a@1"');
});
