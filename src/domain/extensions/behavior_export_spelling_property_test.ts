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

// export const behavior is the other spelling of export const model
// (swamp-club#3338): every reader of a model source must read the two the
// same, or a behavior-spelled extension would reach the registry catalog,
// the catalog-gap check or the loader's type extraction differently from
// its model-spelled twin.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { extractContentMetadata } from "./extension_content_extractor.ts";
import { modelCatalogGap } from "./model_catalog_gap.ts";
import { modelKindAdapter } from "./model_kind_adapter.ts";
import { declaresExport } from "./export_declaration.ts";

/** Every `export const model` declaration respelled as `behavior`. */
const respell = (source: string): string =>
  source.replaceAll(
    /export(\s+)const(\s+)model(\s*[=:])/g,
    "export$1const$2behavior$3",
  );

const typeArb = fc.constantFrom(
  { decl: "", field: '  type: "@acme/thing",' },
  { decl: 'const T = ModelType.create("@acme/thing");', field: "  type: T," },
  { decl: "", field: "  type: TYPE," },
  { decl: "", field: "" },
);
const versionArb = fc.constantFrom('  version: "2026.09.25.1",', "");
const headArb = fc.constantFrom(
  "export const model = {",
  "export const model: ModelDefinition = {",
  "export const model = make({",
  "export  const  model={",
);
const noiseArb = fc.constantFrom(
  "",
  '// type: "@acme/other", version: "2026.01.01.1"',
  "const fixture = `export const model = { ...x }`;",
  'const PROMPT = `Reply with { type: "anime" }`;',
);
// Every body declares methods: a behavior-spelled object without methods is
// deliberately not a definition (see the lone-config test below), while the
// model spelling keeps reading as it always has.
const bodyArb = fc.constantFrom(
  [
    "  globalArguments: z.object({ region: z.string() }),",
    "  methods: {",
    '    "list-things": {',
    '      description: "List",',
    "      arguments: z.object({ id: z.string() }),",
    "      execute: async () => ({ dataHandles: [] }),",
    "    },",
    "  },",
  ].join("\n"),
  "  methods,",
  [
    "  resources: {",
    '    result: { description: "R", schema: z.object({}), lifetime: "infinite", garbageCollection: 3 },',
    "  },",
    "  upgrades: [",
    '    { toVersion: "2026.09.25.1", description: "u", upgradeAttributes: (o) => o },',
    "  ],",
    "  methods: {},",
  ].join("\n"),
);

Deno.test("behavior spelling: extractor metadata, catalog gap and type extraction match the model spelling", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const file = join(tmpDir, "thing.ts");
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        versionArb,
        headArb,
        noiseArb,
        bodyArb,
        async (type, version, head, noise, body) => {
          const close = head.endsWith("({") ? "});" : "};";
          const source = [
            'import { z } from "npm:zod@4";',
            'const methods = { run: { description: "Run", arguments: z.object({}), execute: async () => ({ dataHandles: [] }) } };',
            type.decl,
            noise,
            head,
            type.field,
            version,
            body,
            close,
            "",
          ].join("\n");
          const spelled = respell(source);

          await Deno.writeTextFile(file, source);
          const asModel = await extractContentMetadata([file], tmpDir, []);
          await Deno.writeTextFile(file, spelled);
          const asBehavior = await extractContentMetadata([file], tmpDir, []);

          assertEquals(
            JSON.stringify(asBehavior),
            JSON.stringify(asModel),
            spelled,
          );
          assertEquals(modelCatalogGap(spelled), modelCatalogGap(source));
          assertEquals(
            modelKindAdapter.extractTypeFromSource(spelled),
            modelKindAdapter.extractTypeFromSource(source),
          );
          assertEquals(
            declaresExport(spelled, modelKindAdapter.exportRegex),
            declaresExport(source, modelKindAdapter.exportRegex),
          );
        },
      ),
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("behavior spelling: a model file that also exports an unrelated behavior object reads as it always has", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const model = [
      "export const model = {",
      '  type: "@acme/kept",',
      '  version: "2026.09.25.1",',
      "  methods: {",
      '    run: { description: "Run", arguments: z.object({}), execute: async () => ({ dataHandles: [] }) },',
      "  },",
      "};",
      "",
    ].join("\n");
    const unrelated = [
      'export const behavior = { type: "retry", version: "x" };',
      "export const behaviorNote = 1;",
      "",
    ].join("\n");
    const file = join(tmpDir, "kept.ts");
    for (const source of [unrelated + model, model + unrelated]) {
      await Deno.writeTextFile(file, model);
      const plain = await extractContentMetadata([file], tmpDir, []);
      await Deno.writeTextFile(file, source);
      const withUnrelated = await extractContentMetadata([file], tmpDir, []);
      assertEquals(JSON.stringify(withUnrelated), JSON.stringify(plain));
      assertEquals(modelCatalogGap(source), modelCatalogGap(model));
      assertEquals(
        modelKindAdapter.extractTypeFromSource(source),
        modelKindAdapter.extractTypeFromSource(model),
      );
    }
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("behavior spelling: an extension file with no model export keeps its extension kind", () => {
  const source =
    'export const extension = { type: "@acme/base", methods: [] };\n';
  assertEquals(
    modelKindAdapter.extractTypeFromSource(source)?.kind,
    "extension",
  );
  assertEquals(
    modelKindAdapter.extractTypeFromSource(
      'export const behavior = { type: "@acme/b", version: "2026.01.01.1", methods: {} };\n',
    ),
    {
      typeNormalized: "@acme/b",
      version: "2026.01.01.1",
      kind: "model",
      extendsType: "",
    },
  );
});

Deno.test("behavior spelling: a lone behavior config without methods is not a definition in source text", () => {
  // Matches primaryExport at runtime: a helper whose only export is an
  // unrelated config gets no catalog type and no registry metadata.
  for (
    const source of [
      'export const behavior = { type: "retry", retries: 3 };\n',
      'export const behavior = { type: "retry" };\nconst methods = {};\n',
    ]
  ) {
    assertEquals(modelKindAdapter.extractTypeFromSource(source), null, source);
  }
  for (
    const source of [
      'export const behavior = { type: "@acme/x", version: "2026.01.01.1", methods: {} };\n',
      'const methods = {};\nexport const behavior = { type: "@acme/x", version: "2026.01.01.1", methods };\n',
    ]
  ) {
    assertEquals(
      modelKindAdapter.extractTypeFromSource(source)?.typeNormalized,
      "@acme/x",
      source,
    );
  }
});
