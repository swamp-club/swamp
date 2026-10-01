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

import { assert, assertEquals } from "@std/assert";
import {
  declaresExport,
  EXPORT_DECLARATION_PATTERNS,
  findExportDeclaration,
  sourceFromExportDeclaration,
} from "./export_declaration.ts";

const MODEL = EXPORT_DECLARATION_PATTERNS.model;

Deno.test("findExportDeclaration: finds a declaration in code", () => {
  const source =
    `import { z } from "npm:zod";\nexport const model = {\n  type: "@a/b",\n};\n`;
  assertEquals(
    findExportDeclaration(source, MODEL),
    source.indexOf("export const model"),
  );
});

Deno.test("findExportDeclaration: ignores a declaration in a double-quoted string", () => {
  const source =
    `const src = "export const model = { type: '@acme/thing' }";\n`;
  assertEquals(findExportDeclaration(source, MODEL), -1);
});

Deno.test("findExportDeclaration: ignores a declaration in a single-quoted string", () => {
  const source =
    `const src = 'export const model = { type: "@acme/thing" }';\n`;
  assertEquals(findExportDeclaration(source, MODEL), -1);
});

Deno.test("findExportDeclaration: ignores a multi-line template fixture", () => {
  const source = [
    "const fixture = `",
    "export const model = {",
    '  type: "@acme/thing",',
    "};`;",
    'Deno.test("extracts", () => {});',
  ].join("\n");
  assertEquals(findExportDeclaration(source, MODEL), -1);
});

Deno.test("findExportDeclaration: ignores a template fixture with interpolation", () => {
  const source = [
    'const name = "thing";',
    "const fixture = `export const model = {",
    '  type: "@acme/${name}",',
    "};`;",
  ].join("\n");
  assertEquals(findExportDeclaration(source, MODEL), -1);
});

Deno.test("findExportDeclaration: ignores declarations in comments", () => {
  const source = [
    "// export const model = { type: '@acme/thing' }",
    "/* export const model = {",
    '   type: "@acme/thing" } */',
  ].join("\n");
  assertEquals(findExportDeclaration(source, MODEL), -1);
});

Deno.test("findExportDeclaration: finds a real declaration after a fixture", () => {
  const source = [
    'const fixture = `export const model = { type: "@acme/thing" }`;',
    "export const model = {",
    '  type: "@real/model",',
    "};",
  ].join("\n");
  assertEquals(
    findExportDeclaration(source, MODEL),
    source.indexOf("export const model = {\n"),
  );
});

Deno.test("findExportDeclaration: returns -1 when there is no declaration", () => {
  assertEquals(
    findExportDeclaration("export function helper() {}\n", MODEL),
    -1,
  );
});

Deno.test("declaresExport: reflects findExportDeclaration", () => {
  assert(
    declaresExport(
      "export const vault = {};",
      EXPORT_DECLARATION_PATTERNS.vault,
    ),
  );
  assert(
    !declaresExport(
      '"export const vault = {}"',
      EXPORT_DECLARATION_PATTERNS.vault,
    ),
  );
});

Deno.test("sourceFromExportDeclaration: returns the raw source from the declaration", () => {
  const source = [
    "const fixture = \"export const webhook = { type: '@acme/thing' }\";",
    "export const webhook = {",
    '  type: "@real/hook",',
    "};",
  ].join("\n");
  const declaration = sourceFromExportDeclaration(
    source,
    EXPORT_DECLARATION_PATTERNS.webhook,
  );
  assert(declaration !== null);
  assert(declaration.startsWith("export const webhook = {"));
  assert(declaration.includes('"@real/hook"'));
  assert(!declaration.includes("@acme/thing"));
});

Deno.test("sourceFromExportDeclaration: returns null for a fixture-only source", () => {
  assertEquals(
    sourceFromExportDeclaration(
      '`export const report = { name: "@acme/thing" }`',
      EXPORT_DECLARATION_PATTERNS.report,
    ),
    null,
  );
});

Deno.test("EXPORT_DECLARATION_PATTERNS: model and extension share one pattern", () => {
  assert(EXPORT_DECLARATION_PATTERNS.model.test("export const extension = {"));
  assert(EXPORT_DECLARATION_PATTERNS.extension.test("export const model = {"));
  assert(
    EXPORT_DECLARATION_PATTERNS.datastore.test("export const datastore: X = {"),
  );
});

Deno.test("findExportDeclaration: a backtick inside a regex literal does not hide a real declaration", () => {
  const source = [
    'function shellEscape(s: string) { return s.replace(/[`$"\\\\]/g, (c) => "\\\\" + c); }',
    'export const model = { type: "@acme/runner", version: "2026.01.01.1" };',
  ].join("\n");
  assertEquals(
    findExportDeclaration(source, MODEL),
    source.indexOf("export const model"),
  );
});

Deno.test("findExportDeclaration: a slash-star inside a regex literal does not open a comment", () => {
  const source = [
    "const onlySlashes = /^\\/*$/;",
    "/** Documented model. */",
    'export const model = { type: "@acme/runner" };',
  ].join("\n");
  assertEquals(
    findExportDeclaration(source, MODEL),
    source.indexOf("export const model"),
  );
});

Deno.test("findExportDeclaration: a regex after return is a literal", () => {
  const source = [
    "function f() { return /`/.test(x); }",
    'export const model = { type: "@acme/runner" };',
  ].join("\n");
  assertEquals(
    findExportDeclaration(source, MODEL),
    source.indexOf("export const model"),
  );
});

Deno.test("findExportDeclaration: division is code, not a regex literal", () => {
  const source = [
    "const half = total / 2; const ratio = (a + b) / c / d;",
    'export const model = { type: "@acme/runner" };',
  ].join("\n");
  assertEquals(
    findExportDeclaration(source, MODEL),
    source.indexOf("export const model"),
  );
});
