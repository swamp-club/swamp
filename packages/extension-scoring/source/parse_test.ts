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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseExtensionModule, parserPluginsFor } from "./parse.ts";

Deno.test("parserPluginsFor: TypeScript, JavaScript and JSX by extension", () => {
  for (const path of ["m.ts", "m.mts", "m.cts", "dir/M.TS"]) {
    const plugins = parserPluginsFor(path);
    assert(plugins.includes("typescript"), path);
    assert(!plugins.includes("jsx"), path);
  }
  for (const path of ["m.js", "m.mjs", "m.cjs", "bundles/m.js"]) {
    const plugins = parserPluginsFor(path);
    assert(!plugins.includes("typescript"), path);
    assert(!plugins.includes("jsx"), path);
  }
  assert(parserPluginsFor("m.tsx").includes("typescript"));
  assert(parserPluginsFor("m.tsx").includes("jsx"));
  assert(!parserPluginsFor("m.jsx").includes("typescript"));
  assert(parserPluginsFor("m.jsx").includes("jsx"));
});

Deno.test("parserPluginsFor: no path reads as TypeScript", () => {
  assertEquals(parserPluginsFor(), parserPluginsFor("m.ts"));
});

Deno.test("parseExtensionModule: parses a TypeScript module", () => {
  const parsed = parseExtensionModule(
    "import type { A } from './a.ts';\nexport const x: A = 1 as A;\n",
    { path: "m.ts" },
  );
  assert(parsed.ok);
  assertEquals(parsed.program.type, "Program");
  assertEquals(parsed.tokens, []);
});

Deno.test("parseExtensionModule: reads JavaScript without the TypeScript plugin", () => {
  // Valid JavaScript the TypeScript plugin reads as an arrow function with
  // a return type (`(b): c => d`).
  const source = "const a = 1, b = 2;\nexport const f = a ? (b) : c => c;\n";
  assert(parseExtensionModule(source, { path: "m.js" }).ok);
  assert(!parseExtensionModule(source, { path: "m.ts" }).ok);
});

Deno.test("parseExtensionModule: JSX only for the x extensions", () => {
  const source = "export const el = <div>hi</div>;\n";
  assert(parseExtensionModule(source, { path: "m.tsx" }).ok);
  assert(parseExtensionModule(source, { path: "m.jsx" }).ok);
  assert(!parseExtensionModule(source, { path: "m.ts" }).ok);
});

Deno.test("parseExtensionModule: allows top-level return and await", () => {
  const parsed = parseExtensionModule(
    "await Promise.resolve();\nif (Math.random() > 2) return;\n",
    { path: "bundles/m.js" },
  );
  assert(parsed.ok);
});

Deno.test("parseExtensionModule: a syntax error comes back with its position", () => {
  const parsed = parseExtensionModule("export const broken = ;\n", {
    path: "m.ts",
  });
  assert(!parsed.ok);
  assertStringIncludes(parsed.reason, "(1:22)");
});

Deno.test("parseExtensionModule: extreme nesting does not throw", () => {
  const depth = 200_000;
  const parsed = parseExtensionModule(
    `export const x = ${"(".repeat(depth)}1${")".repeat(depth)};\n`,
    { path: "m.ts" },
  );
  assert(!parsed.ok);
});

Deno.test("parseExtensionModule: returns comments, and tokens when asked", () => {
  const source = "// note\nexport const x = 1;\n";
  const plain = parseExtensionModule(source, { path: "m.ts" });
  assert(plain.ok);
  assertEquals(plain.comments.length, 1);
  assertEquals(plain.tokens, []);
  const withTokens = parseExtensionModule(source, {
    path: "m.ts",
    tokens: true,
  });
  assert(withTokens.ok);
  assert(withTokens.tokens.length > 0);
});

Deno.test("parseExtensionModule: bundle output reads TC39 decorators", () => {
  const source = "@dec class A {}\nexport { A };\n";
  assert(parseExtensionModule(source, { bundle: true }).ok);
});

Deno.test("parseExtensionModule: CommonJS reads as a sloppy-mode script", () => {
  const source = "var fs = require('fs');\nfs.chmodSync('p', 0755);\n" +
    "with (Math) { x = PI; }\nvar package = 1;\nmodule.exports = {};\n";
  for (const path of ["files/helper.cjs", "m.cts"]) {
    const parsed = parseExtensionModule(source, { path });
    assert(parsed.ok, path);
    assertEquals(parsed.program.sourceType, "script");
  }
  assert(!parseExtensionModule(source, { path: "m.js" }).ok);
});

Deno.test("parseExtensionModule: legacy and TC39 decorators both read", () => {
  for (
    const source of [
      "export @dec class A {}\n",
      "@dec export class A {}\n",
      "class A { constructor(@inject() x: number) {} }\n",
    ]
  ) {
    assert(parseExtensionModule(source, { path: "m.ts" }).ok, source);
  }
});

Deno.test("parseExtensionModule: a module neither decorator form reads reports the error", () => {
  const parsed = parseExtensionModule(
    "@dec export const broken = ;\n",
    { path: "m.ts" },
  );
  assert(!parsed.ok);
});
