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
import { modelCatalogGap } from "./model_catalog_gap.ts";

Deno.test("modelCatalogGap: a spread model with only a literal type is missing its version", () => {
  const source = 'const definition = make({ version: "2026.09.25.1" });\n' +
    'export const model = {\n  ...definition,\n  type: "@acme/thing",\n};\n';
  assertEquals(modelCatalogGap(source), {
    kind: "missing-literals",
    missing: ["version"],
  });
});

Deno.test("modelCatalogGap: a model with literal type and version has no gap", () => {
  const source = "export const model = {\n  ...definition,\n" +
    '  type: "@acme/thing",\n  version: "2026.09.25.1",\n};\n';
  assertEquals(modelCatalogGap(source), null);
});

Deno.test("modelCatalogGap: a satisfies check after the object has no gap", () => {
  const source = 'export const model = {\n  type: "@acme/thing",\n' +
    '  version: "2026.09.25.1",\n} satisfies ModelDefinition;\n';
  assertEquals(modelCatalogGap(source), null);
});

Deno.test("modelCatalogGap: a type-annotated export is not a plain object even with both literals", () => {
  const source = "export const model: ModelDefinition = {\n" +
    '  type: "@acme/thing",\n  version: "2026.09.25.1",\n};\n';
  assertEquals(modelCatalogGap(source), {
    kind: "not-plain-object",
    annotated: true,
  });
});

Deno.test("modelCatalogGap: a factory call as the initializer is not a plain object", () => {
  const source =
    'export const model = make({ type: "@acme/thing", version: "1" });\n';
  assertEquals(modelCatalogGap(source), {
    kind: "not-plain-object",
    annotated: false,
  });
});

Deno.test("modelCatalogGap: an object with neither literal is missing both", () => {
  assertEquals(
    modelCatalogGap("export const model = {\n  ...definition,\n};\n"),
    {
      kind: "missing-literals",
      missing: ["type", "version"],
    },
  );
  assertEquals(modelCatalogGap("export const model = {};\n"), {
    kind: "missing-literals",
    missing: ["type", "version"],
  });
});

Deno.test("modelCatalogGap: a ModelType.create type with a literal version has no gap", () => {
  const source = 'const T = ModelType.create("@acme/thing");\n' +
    'export const model = {\n  type: T,\n  version: "2026.09.25.1",\n};\n';
  assertEquals(modelCatalogGap(source), null);
});

Deno.test("modelCatalogGap: a ModelType.create type without a literal version is missing the version", () => {
  const source = 'const T = ModelType.create("@acme/thing");\n' +
    "export const model = {\n  type: T,\n  version: VERSION,\n};\n";
  assertEquals(modelCatalogGap(source), {
    kind: "missing-literals",
    missing: ["version"],
  });
});

Deno.test("modelCatalogGap: type and version text outside the export does not fill the gap", () => {
  const source = '// type: "@acme/thing", version: "2026.09.25.1"\n' +
    'const note = "version: \\"1\\"";\n' +
    "export const model = {\n  ...definition,\n};\n";
  assertEquals(modelCatalogGap(source), {
    kind: "missing-literals",
    missing: ["type", "version"],
  });
});

Deno.test("modelCatalogGap: files that declare no model export in code are never a gap", () => {
  for (
    const source of [
      'export const extension = {\n  type: "@acme/thing",\n  methods: [],\n};\n',
      'export const vault = {\n  type: "@acme/vault",\n};\n',
      "export const echo = (s: string): string => s;\n",
      "// export const model = { ...definition };\n",
      "const fixture = `export const model = { ...definition }`;\n",
    ]
  ) {
    assertEquals(modelCatalogGap(source), null, source);
  }
});
