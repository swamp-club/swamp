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

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { waitFor, withMockedCommand } from "@swamp-club/swamp-testing";
import { z } from "zod";
import { UserError } from "../errors.ts";
import {
  bundleExtension,
  denoProjectArgs,
  extractBareSpecifierNames,
  fixCjsEsmInterop,
  groupStaleLockfiles,
  importMapTarget,
  installZodGlobal,
  isEsbuildInstallRace,
  isExpectedBundleFailure,
  isStaleLockfile,
  isZod3Specifier,
  isZod4Specifier,
  rejectZodV3Imports,
  rewriteZodImports,
  runFirstAlone,
  sanitizeDataUrlError,
  sharedZodTargets,
  sourceHasBareSpecifiers,
  StaleLockfileError,
  staleLockfileError,
  staleLockfileInstallCommand,
  uint8ArrayToBase64,
  zod4SpecifiersReachedFrom,
} from "./bundle.ts";

const DENO_PATH = Deno.execPath();

async function withTempFile(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  const path = join(dir, "test_ext.ts");
  await Deno.writeTextFile(path, content);
  try {
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function importBundled(
  js: string,
): Promise<Record<string, unknown>> {
  installZodGlobal();
  const rewritten = rewriteZodImports(js);
  const encoded = uint8ArrayToBase64(new TextEncoder().encode(rewritten));
  return await import(`data:application/javascript;base64,${encoded}`);
}

Deno.test("bundleExtension transpiles TypeScript to valid JS", async () => {
  const tsCode = `
import { z } from "npm:zod@4";

interface Config {
  name: string;
  value?: number;
}

function greet<T extends Config>(config: T): string {
  return config.name;
}

const schema = z.object({ message: z.string() });

export const model = {
  type: greet({ name: "test" }),
  schema,
};
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);

    // Should not contain TypeScript syntax
    assertEquals(js.includes("interface Config"), false);
    assertEquals(js.includes(": string"), false);
    assertEquals(js.includes("<T extends"), false);

    // Should be importable
    const mod = await importBundled(js);
    assertEquals((mod.model as { type: string }).type, "test");
  });
});

Deno.test("bundleExtension externalizes zod imports", async () => {
  const tsCode = `
import { z } from "npm:zod@4";

export const schema = z.object({ name: z.string() });
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);

    // Zod should not be inlined — the bundle should be small
    // A fully inlined zod would be hundreds of KB
    assertEquals(js.length < 10_000, true);
  });
});

Deno.test("bundleExtension inlines non-zod npm packages", async () => {
  const tsCode = `
import { z } from "npm:zod@4";
import { parse, stringify } from "npm:yaml@2.7.1";

const ConfigSchema = z.object({
  data: z.string(),
});

export const model = {
  type: "@test/yaml-model",
  version: "2026.01.01.1",
  schema: ConfigSchema,
  transform: (input: string) => {
    const parsed = parse(input);
    return stringify(parsed);
  },
};
`;

  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  const path = join(dir, "test_ext.ts");
  await Deno.writeTextFile(path, tsCode);
  try {
    const js = await bundleExtension(path, DENO_PATH);

    // Bundle should succeed — yaml is inlined into the bundle
    assertEquals(js.length > 0, true);

    // yaml package should be inlined (bundle > 10KB with yaml code included)
    assertEquals(
      js.length > 10_000,
      true,
      "yaml should be inlined into the bundle, making it larger than 10KB",
    );

    // No deno.lock should be created in the source directory
    let lockExists = true;
    try {
      await Deno.stat(join(dir, "deno.lock"));
    } catch {
      lockExists = false;
    }
    assertEquals(
      lockExists,
      false,
      "deno.lock should not be created in the source directory",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleExtension produces importable module with working zod instanceof", async () => {
  const tsCode = `
import { z } from "npm:zod@4";

export const schema = z.object({ message: z.string() });
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);
    const mod = await importBundled(js);

    // The schema from the bundled module should be a ZodType instance
    // because zod is externalized and shares the same instance
    assertEquals(mod.schema instanceof z.ZodType, true);

    // It should also parse correctly
    const parsed = (mod.schema as z.ZodObject<{ message: z.ZodString }>).parse({
      message: "hello",
    });
    assertEquals(parsed, { message: "hello" });
  });
});

Deno.test("bundleExtension produces module where z.toJSONSchema works", async () => {
  const tsCode = `
import { z } from "npm:zod@4";

export const schema = z.object({ id: z.string(), data: z.unknown() });
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);
    const mod = await importBundled(js);

    // Should be a ZodType from swamp's Zod instance
    assertEquals(mod.schema instanceof z.ZodType, true);

    // z.toJSONSchema should work without _zod errors
    const jsonSchema = z.toJSONSchema(mod.schema as z.ZodTypeAny);
    assertEquals(jsonSchema.type, "object");
  });
});

// --- rewriteZodImports unit tests ---

Deno.test("rewriteZodImports rewrites named imports", () => {
  const input = `import { z } from "npm:zod@4";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites aliased imports", () => {
  const input = `import { z as z2 } from "npm:zod@4";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z: z2 } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites star imports", () => {
  const input = `import * as zod from "npm:zod@4";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const zod = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites unversioned npm:zod", () => {
  const input = `import { z } from "npm:zod";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites multiple zod imports", () => {
  const input = [
    `import { z as z2 } from "npm:zod@4";`,
    `import { z } from "npm:zod@4";`,
    `console.log(z, z2);`,
  ].join("\n");
  const result = rewriteZodImports(input);
  const expected = [
    `const { z: z2 } = globalThis.__swamp_zod;`,
    `const { z } = globalThis.__swamp_zod;`,
    `console.log(z, z2);`,
  ].join("\n");
  assertEquals(result, expected);
});

Deno.test("rewriteZodImports rewrites bare zod specifier", () => {
  const input = `import { z } from "zod";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites bare zod star import", () => {
  const input = `import * as zod from "zod";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const zod = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports rewrites bare aliased zod specifier", () => {
  const input = `import { z as z2 } from "zod";`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z: z2 } = globalThis.__swamp_zod;`);
});

Deno.test("rewriteZodImports leaves non-zod imports untouched", () => {
  const input = `import { parse } from "npm:yaml@2";`;
  const result = rewriteZodImports(input);
  assertEquals(result, input);
});

Deno.test("rewriteZodImports is idempotent", () => {
  const input = `import { z } from "npm:zod@4";`;
  const first = rewriteZodImports(input);
  const second = rewriteZodImports(first);
  assertEquals(first, second);
});

Deno.test("rewriteZodImports handles single-quoted specifiers", () => {
  const input = `import { z } from 'npm:zod@4';`;
  const result = rewriteZodImports(input);
  assertEquals(result, `const { z } = globalThis.__swamp_zod;`);
});

const REAL_ZOD_IMPORT = `import { z } from "npm:zod@4";`;
const REWRITTEN_ZOD_IMPORT = `const { z } = globalThis.__swamp_zod;`;

// Each entry is a line of JS carrying zod import text as data, not as an
// import declaration (swamp-club#3072).
const ZOD_IMPORT_TEXT_AS_DATA: Record<string, string> = {
  "a template literal": 'export const t = `import { z } from "npm:zod@4";\n`;',
  "a double-quoted string":
    `export const t = "import { z } from 'npm:zod@4';";`,
  "a single-quoted string": `export const t = 'import { z } from "zod";';`,
  "a line comment": `// import { z } from "npm:zod@4";`,
  "a block comment": `/* import * as zod from "npm:zod@4"; */`,
  "a regex literal": `export const t = /import { z } from "zod"/;`,
  "an aliased import in a template":
    'export const t = `import { z as z2 } from "npm:zod@4";`;',
  "a star import in a template":
    'export const t = `import * as zod from "npm:zod";`;',
};

for (const [where, line] of Object.entries(ZOD_IMPORT_TEXT_AS_DATA)) {
  Deno.test(`rewriteZodImports: leaves import text inside ${where} untouched`, () => {
    const result = rewriteZodImports(`${REAL_ZOD_IMPORT}\n${line}\n`);
    assertEquals(result, `${REWRITTEN_ZOD_IMPORT}\n${line}\n`);
  });

  Deno.test(`rewriteZodImports: returns the input unchanged when the only import text is inside ${where}`, () => {
    const input = `${line}\nexport const n = 1;\n`;
    assertEquals(rewriteZodImports(input), input);
  });
}

Deno.test("rewriteZodImports: rewrites imports that follow other statements", () => {
  const input = [
    `import { parse } from "npm:yaml@2";`,
    `var a = 1;`,
    `import * as zod from "npm:zod@4";`,
    `import { z as z2 } from "zod";`,
    `console.log(a, parse, zod, z2);`,
  ].join("\n");
  const expected = [
    `import { parse } from "npm:yaml@2";`,
    `var a = 1;`,
    `const zod = globalThis.__swamp_zod;`,
    `const { z: z2 } = globalThis.__swamp_zod;`,
    `console.log(a, parse, zod, z2);`,
  ].join("\n");
  assertEquals(rewriteZodImports(input), expected);
});

Deno.test("rewriteZodImports: is idempotent when import text remains inside a template", () => {
  const input = REAL_ZOD_IMPORT + "\n" +
    ZOD_IMPORT_TEXT_AS_DATA["a template literal"];
  const first = rewriteZodImports(input);
  assertEquals(rewriteZodImports(first), first);
});

Deno.test("rewriteZodImports: throws rather than guess when zod import text is in a bundle that does not parse", () => {
  const input = `${REAL_ZOD_IMPORT}\nconst = ;\n`;
  const error = assertThrows(
    () => rewriteZodImports(input, "/repo/.swamp/bundles/ab12/gen.js"),
    UserError,
  );
  assertEquals(error.code, "bundle_parse_failed");
  assertStringIncludes(
    error.message,
    "Cannot load the extension at /repo/.swamp/bundles/ab12/gen.js: its bundle",
  );
  assertStringIncludes(error.message, "A cached bundle may be damaged");
  assertStringIncludes(error.message, "swamp issue bug");
});

Deno.test("rewriteZodImports: the parse error reads cleanly when the bundle path is unknown", () => {
  const input = `${REAL_ZOD_IMPORT}\nconst = ;\n`;
  const error = assertThrows(() => rewriteZodImports(input), UserError);
  assertStringIncludes(error.message, "Cannot load the extension: its bundle ");
});

Deno.test("rejectZodV3Imports: names the bundle when it does not parse", () => {
  const input = `import { z } from "npm:zod@3";\nconst = ;\n`;
  const error = assertThrows(
    () => rejectZodV3Imports(input, "/repo/extensions/models/gen.ts"),
    UserError,
  );
  assertEquals(error.code, "bundle_parse_failed");
  assertStringIncludes(error.message, "/repo/extensions/models/gen.ts");
});

// Syntax Babel only parses with a plugin enabled. A bundle using it beside a
// zod import must still be rewritten, not rejected as unparseable.
const PLUGIN_GATED_SYNTAX: Record<string, string> = {
  "import attributes": `import j from "./a.json" with { type: "json" };`,
  "a using declaration": `{ using r = f(); }`,
  "a decorated accessor": `@d class A { @e accessor x = 1; }`,
  "a source phase import": `import source w from "./a.wasm";`,
  "a dynamic source phase import": `const w = await import.source("./a.wasm");`,
  "a deferred import": `import defer * as m from "./m.js";`,
  "a dynamic deferred import": `const m = await import.defer("./m.js");`,
};

for (const [syntax, line] of Object.entries(PLUGIN_GATED_SYNTAX)) {
  Deno.test(`rewriteZodImports: rewrites a bundle that uses ${syntax}`, () => {
    const result = rewriteZodImports(`${line}\n${REAL_ZOD_IMPORT}\n`);
    assertEquals(result, `${line}\n${REWRITTEN_ZOD_IMPORT}\n`);
  });
}

Deno.test("rewriteZodImports: does not parse a bundle with no zod import text", () => {
  const input = `const = ;\n`;
  assertEquals(rewriteZodImports(input), input);
});

Deno.test("bundleExtension: keeps zod import text inside a template literal", async () => {
  const template =
    'import { z } from "npm:zod@4";\nexport const x = z.string();\n';
  const tsCode = `
import { z } from "npm:zod@4";

export const TEMPLATE = \`${template}\`;
export const schema = z.object({ text: z.string() });
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);
    const mod = await importBundled(js);
    assertEquals(mod.TEMPLATE, template);
    assertEquals(mod.schema instanceof z.ZodType, true);
  });
});

// --- rejectZodV3Imports unit tests ---

Deno.test("rejectZodV3Imports: throws on zod@3 named import", () => {
  const input = `import { z } from "npm:zod@3.23.8";`;
  assertThrows(
    () => rejectZodV3Imports(input),
    Error,
    "Zod v3",
  );
});

Deno.test("rejectZodV3Imports: throws on zod@3 star import", () => {
  const input = `import * as zod from "npm:zod@3";`;
  assertThrows(
    () => rejectZodV3Imports(input),
    Error,
    "Swamp requires Zod v4",
  );
});

Deno.test("rejectZodV3Imports: allows zod@4 import", () => {
  const input = `import { z } from "npm:zod@4.3.6";`;
  rejectZodV3Imports(input);
});

Deno.test("rejectZodV3Imports: allows unversioned zod import", () => {
  const input = `import { z } from "zod";`;
  rejectZodV3Imports(input);
});

Deno.test("rewriteZodImports: leaves zod@3 imports untouched", () => {
  const input = `import { z } from "npm:zod@3.22.4";`;
  const result = rewriteZodImports(input);
  assertEquals(result, input);
});

// --- zod version spellings (swamp-club#3637) ---

Deno.test("isZod4Specifier: accepts every spelling that admits only zod 4", () => {
  for (
    const spec of [
      "zod",
      "npm:zod",
      "npm:zod@4",
      "npm:zod@4.3.6",
      "npm:zod@^4",
      "npm:zod@^4.1.0",
      "npm:zod@~4.2",
      "npm:zod@4.x",
      "npm:zod@>=4.1 <5",
      "npm:zod@4.3.6/v4",
      "npm:zod@^4.1/v4",
    ]
  ) {
    assertEquals(isZod4Specifier(spec), true, spec);
  }
});

Deno.test("isZod4Specifier: rejects zod 3, ranges that leave 4.x, and other packages", () => {
  for (
    const spec of [
      "npm:zod@3.23.8",
      "npm:zod@^3",
      "npm:zod@>=3 <5",
      "npm:zod@*",
      "npm:zod@latest",
      "npm:zod@5",
      "npm:zodiac@4",
      "npm:zod-to-json-schema@4",
      "jsr:@zod/zod@4",
      "npm:zod@3.25.0/v4",
      "zod/v4",
      "npm:zod@4.3.6/v4/core",
      "npm:zod@^4/mini",
    ]
  ) {
    assertEquals(isZod4Specifier(spec), false, spec);
  }
});

Deno.test("isZod3Specifier: accepts only spellings that admit only zod 3", () => {
  assertEquals(isZod3Specifier("npm:zod@3"), true);
  assertEquals(isZod3Specifier("npm:zod@^3.22"), true);
  assertEquals(isZod3Specifier("npm:zod@~3.23.0"), true);
  assertEquals(isZod3Specifier("zod"), false);
  assertEquals(isZod3Specifier("npm:zod@^4"), false);
  assertEquals(isZod3Specifier("npm:zod@>=3 <5"), false);
});

Deno.test("rewriteZodImports: rewrites ranged zod 4 imports", () => {
  assertEquals(
    rewriteZodImports(`import { z } from "npm:zod@^4.1.0";`),
    `const { z } = globalThis.__swamp_zod;`,
  );
  assertEquals(
    rewriteZodImports(`import * as zod from "npm:zod@~4.2";`),
    `const zod = globalThis.__swamp_zod;`,
  );
});

Deno.test("rewriteZodImports: rewrites a zod 4 import with a subpath, as before", () => {
  assertEquals(
    rewriteZodImports(`import { z } from "npm:zod@4.3.6/v4";`),
    `const { z } = globalThis.__swamp_zod;`,
  );
});

Deno.test("rewriteZodImports: still rewrites a pinned zod 4 subpath an older swamp externalized", () => {
  assertEquals(
    rewriteZodImports(`import { z } from "npm:zod@4.3.6/v4/core";`),
    `const { z } = globalThis.__swamp_zod;`,
  );
});

Deno.test("rewriteZodImports: leaves a ranged zod 3 import untouched", () => {
  const input = `import { z } from "npm:zod@^3.22.4";`;
  assertEquals(rewriteZodImports(input), input);
});

Deno.test("rejectZodV3Imports: throws on a ranged zod 3 import", () => {
  assertThrows(
    () => rejectZodV3Imports(`import { z } from "npm:zod@^3.22";`),
    Error,
    "Swamp requires Zod v4",
  );
});

Deno.test("rejectZodV3Imports: allows a ranged zod 4 import", () => {
  rejectZodV3Imports(`import { z } from "npm:zod@^4.1";`);
});

Deno.test("bundleExtension: keeps ranged zod 4 external in a module the entry point imports", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  try {
    await Deno.mkdir(join(dir, "lib"));
    await Deno.writeTextFile(
      join(dir, "lib", "schema.ts"),
      `import { z } from "npm:zod@^4.1.0";\nexport const schema = z.object({ id: z.string() });\n`,
    );
    const entry = join(dir, "ext.ts");
    await Deno.writeTextFile(
      entry,
      `export { schema } from "./lib/schema.ts";\n`,
    );
    const js = await bundleExtension(entry, DENO_PATH);
    assertEquals(js.length < 10_000, true);
    const mod = await importBundled(js);
    assertEquals(mod.schema instanceof z.ZodType, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleExtension: keeps a zod 4 range with spaces external in an imported module", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  try {
    await Deno.mkdir(join(dir, "lib"));
    await Deno.writeTextFile(
      join(dir, "lib", "schema.ts"),
      `import { z } from "npm:zod@>=4.1 <5";\nexport const schema = z.string();\n`,
    );
    const entry = join(dir, "ext.ts");
    await Deno.writeTextFile(
      entry,
      `export { schema } from "./lib/schema.ts";\n`,
    );
    const js = await bundleExtension(entry, DENO_PATH);
    assertEquals(js.length < 10_000, true);
    const mod = await importBundled(js);
    assertEquals(mod.schema instanceof z.ZodType, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("zod4SpecifiersReachedFrom: collects zod 4 spellings across relative imports, once each", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  try {
    await Deno.mkdir(join(dir, "lib", "deep"), { recursive: true });
    const entry = join(dir, "ext.ts");
    await Deno.writeTextFile(
      entry,
      [
        'import { z } from "npm:zod@4.3.6";',
        'import "./lib/a.ts";',
        'export * from "./lib/b.ts";',
        'const lazy = () => import("./lib/deep/c.ts");',
        '// import { z } from "npm:zod@~4.9";',
        'const t = `import { z } from "npm:zod@^4.8"`;',
        'import { ms } from "npm:ms@2";',
      ].join("\n"),
    );
    await Deno.writeTextFile(
      join(dir, "lib", "a.ts"),
      'import { z } from "npm:zod@^4.1";\nimport "../ext.ts";\n',
    );
    await Deno.writeTextFile(
      join(dir, "lib", "b.ts"),
      'import { z } from "npm:zod@^3.22";\nimport { y } from "npm:zod@^4 || ^3";\n',
    );
    await Deno.writeTextFile(
      join(dir, "lib", "deep", "c.ts"),
      'export { z } from "npm:zod@>=4.1 <5";\nimport { v } from "npm:zod@4.3.6/v4";\nimport d from "./d.json" with { type: "json" };\n',
    );
    assertEquals(await zod4SpecifiersReachedFrom(entry), [
      "npm:zod@4.3.6",
      "npm:zod@4.3.6/v4",
      "npm:zod@>=4.1 <5",
      "npm:zod@^4.1",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("zod4SpecifiersReachedFrom: skips a relative import that does not exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  try {
    const entry = join(dir, "ext.ts");
    await Deno.writeTextFile(
      entry,
      'import "./missing.ts";\nimport { z } from "npm:zod@^4";\n',
    );
    assertEquals(await zod4SpecifiersReachedFrom(entry), ["npm:zod@^4"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleExtension: externalizes a bare zod the deno.json maps to a zod 4 range", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  try {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(
      config,
      JSON.stringify({ imports: { zod: "npm:zod@^4.1.0" } }),
    );
    const entry = join(dir, "ext.ts");
    await Deno.writeTextFile(
      entry,
      `import { z } from "zod";\nexport const schema = z.string();\n`,
    );
    const js = await bundleExtension(entry, DENO_PATH, {
      denoConfigPath: config,
      readOnlyLock: {},
    });
    assertEquals(js.length < 10_000, true);
    const mod = await importBundled(js);
    assertEquals(mod.schema instanceof z.ZodType, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleExtension: externalizes a bare zod a deno.jsonc maps through an importMap file (swamp-club#3612)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  try {
    const config = join(dir, "deno.jsonc");
    await Deno.writeTextFile(
      config,
      '// project config\n{ "importMap": "./import_map.json", }\n',
    );
    await Deno.writeTextFile(
      join(dir, "import_map.json"),
      JSON.stringify({ imports: { zod: "npm:zod@^4.1.0" } }),
    );
    const entry = join(dir, "ext.ts");
    await Deno.writeTextFile(
      entry,
      `import { z } from "zod";\nexport const schema = z.string();\n`,
    );
    const js = await bundleExtension(entry, DENO_PATH, {
      denoConfigPath: config,
      readOnlyLock: {},
    });
    assertEquals(js.length < 10_000, true);
    const mod = await importBundled(js);
    assertEquals(mod.schema instanceof z.ZodType, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bundleExtension: a deno.json beside a package.json with no node_modules still keeps a bare zod external (swamp-club#3612)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  try {
    const config = join(dir, "deno.json");
    await Deno.writeTextFile(
      config,
      JSON.stringify({ imports: { zod: "npm:zod@4" } }),
    );
    // A package.json puts Deno in manual node_modules mode; with nothing
    // installed, the first graph read cannot find zod.
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { zod: "^4.0.0" } }),
    );
    const entry = join(dir, "ext.ts");
    await Deno.writeTextFile(
      entry,
      `import { z } from "zod";\nexport const schema = z.string();\n`,
    );
    const js = await bundleExtension(entry, DENO_PATH, {
      denoConfigPath: config,
      readOnlyLock: {},
    });
    assertEquals(js.length < 10_000, true);
    const mod = await importBundled(js);
    assertEquals(mod.schema instanceof z.ZodType, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- uint8ArrayToBase64 unit tests ---

Deno.test("uint8ArrayToBase64 matches btoa for small input", () => {
  const text = "hello world";
  const bytes = new TextEncoder().encode(text);
  const expected = btoa(text);
  assertEquals(uint8ArrayToBase64(bytes), expected);
});

Deno.test("uint8ArrayToBase64 handles empty input", () => {
  assertEquals(uint8ArrayToBase64(new Uint8Array(0)), btoa(""));
});

// --- fixCjsEsmInterop unit tests ---

Deno.test("fixCjsEsmInterop rewrites __toESM to always set default", () => {
  // Use the exact single-line format esbuild generates
  const input =
    `var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(\n  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,\n  mod\n));`;
  const result = fixCjsEsmInterop(input);
  // The condition should be removed — always sets .default
  assertEquals(result.includes("isNodeMode ||"), false);
  assertEquals(result.includes("__esModule"), false);
  assertEquals(
    result.includes(
      `__defProp(target, "default", { value: mod, enumerable: true })`,
    ),
    true,
  );
  // Should not contain `: target,` fallback (only `target,` at the end remains from `__copyProps(... , target,` being removed)
  assertEquals(result.includes(": target,"), false);
});

Deno.test("fixCjsEsmInterop is idempotent", () => {
  const input =
    `var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(\n  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,\n  mod\n));`;
  const first = fixCjsEsmInterop(input);
  const second = fixCjsEsmInterop(first);
  assertEquals(first, second);
});

Deno.test("fixCjsEsmInterop leaves non-matching code untouched", () => {
  const input = `const x = 42; console.log("hello");`;
  assertEquals(fixCjsEsmInterop(input), input);
});

// --- sanitizeDataUrlError unit tests ---

Deno.test("sanitizeDataUrlError truncates base64 data URLs", () => {
  const longBase64 = "A".repeat(200);
  const error =
    `Error: The argument 'filename' must be a file URL. Received data:application/javascript;base64,${longBase64}`;
  const result = sanitizeDataUrlError(error);
  assertEquals(
    result,
    `Error: The argument 'filename' must be a file URL. Received data:application/javascript;base64,[truncated]`,
  );
});

Deno.test("sanitizeDataUrlError leaves short errors untouched", () => {
  const error = "Error: something went wrong";
  assertEquals(sanitizeDataUrlError(error), error);
});

Deno.test("bundleExtension resolves and inlines jsr: specifiers", async () => {
  // Network-dependent (matches the existing npm: bar). Guards the "first-class
  // jsr:" contract: deno bundle must resolve jsr: without requiring an import
  // map and inline the fetched source into the bundle.
  const tsCode = `
import { z } from "npm:zod@4";
import { parse } from "jsr:@std/semver@1.0.8";

const schema = z.object({ version: z.string() });

export const model = {
  type: "@test/jsr-inlining",
  schema,
  major: (v: string) => parse(v).major,
};
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);

    // No jsr: specifier should remain in the bundle — proves resolution, not
    // pass-through.
    assertEquals(
      js.includes('from "jsr:'),
      false,
      "jsr: specifier should be resolved, not passed through",
    );

    // The inlined source carries a deno:https://jsr.io header comment. Its
    // presence is the strongest signal jsr code is actually inlined.
    assertEquals(
      js.includes("deno:https://jsr.io/@std/semver"),
      true,
      "bundle should contain inlined jsr source with deno:https://jsr.io header",
    );
  });
});

Deno.test("bundleExtension resolves and inlines https: specifiers", async () => {
  // Network-dependent. Parity proof: https: is treated identically to jsr:
  // and npm: — resolved and inlined by deno bundle.
  const tsCode = `
import { z } from "npm:zod@4";
import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";

export const model = {
  type: "@test/https-inlining",
  schema: z.object({}),
  wait: async () => { await delay(1); },
};
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);

    assertEquals(
      js.includes('from "https:'),
      false,
      "https: specifier should be resolved, not passed through",
    );

    assertEquals(
      js.includes("deno:https://deno.land/std"),
      true,
      "bundle should contain inlined https source with deno:https://deno.land header",
    );
  });
});

Deno.test("rewriteZodImports leaves jsr: inlined content untouched", async () => {
  // Regression: rewriteZodImports' regex is zod-specific and must not
  // coincidentally match jsr: identifiers in inlined source. A combined
  // npm:zod + jsr:@std/semver fixture pins this down.
  const tsCode = `
import { z } from "npm:zod@4";
import { parse } from "jsr:@std/semver@1.0.8";

export const schema = z.object({ version: z.string() });
export const check = (v: string) => parse(v).major;
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);
    const rewritten = rewriteZodImports(js);

    // Zod was rewritten to globalThis.__swamp_zod.
    assertEquals(
      rewritten.includes("globalThis.__swamp_zod"),
      true,
      "rewriteZodImports should rewrite zod import",
    );
    assertEquals(
      rewritten.includes('from "npm:zod'),
      false,
      "no npm:zod import should remain after rewrite",
    );

    // jsr: inlined content is still present and untouched.
    assertEquals(
      rewritten.includes("deno:https://jsr.io/@std/semver"),
      true,
      "jsr inlined source must survive the zod rewrite",
    );
  });
});

Deno.test("bundleExtension uses deno.json config when denoConfigPath provided", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_test_" });
  const tsPath = join(dir, "test_ext.ts");
  const denoJsonPath = join(dir, "deno.json");

  // Write a minimal deno.json with an import map for zod
  await Deno.writeTextFile(
    denoJsonPath,
    JSON.stringify({
      imports: {
        "zod": "npm:zod@4",
      },
    }),
  );

  // Use bare "zod" specifier (resolved via import map, not npm: prefix)
  await Deno.writeTextFile(
    tsPath,
    'import { z } from "zod";\n\nexport const schema = z.object({ name: z.string() });\n',
  );

  try {
    const js = await bundleExtension(tsPath, DENO_PATH, {
      denoConfigPath: denoJsonPath,
    });
    assertEquals(js.length > 0, true);

    // Should be importable and working
    const mod = await importBundled(js);
    assertEquals(mod.schema instanceof z.ZodType, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- sourceHasBareSpecifiers unit tests ---

Deno.test("sourceHasBareSpecifiers returns true for bare zod import", () => {
  assertEquals(sourceHasBareSpecifiers('import { z } from "zod";'), true);
});

Deno.test("sourceHasBareSpecifiers returns true for bare scoped import", () => {
  assertEquals(
    sourceHasBareSpecifiers(
      'import { Client } from "@aws-sdk/client-secrets-manager";',
    ),
    true,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for npm: prefixed import", () => {
  assertEquals(
    sourceHasBareSpecifiers('import { z } from "npm:zod@4";'),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for relative import", () => {
  assertEquals(
    sourceHasBareSpecifiers('import { helper } from "./helpers.ts";'),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for jsr: import", () => {
  assertEquals(
    sourceHasBareSpecifiers('import { assert } from "jsr:@std/assert";'),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for node: import", () => {
  assertEquals(
    sourceHasBareSpecifiers('import { readFile } from "node:fs";'),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for https: import", () => {
  assertEquals(
    sourceHasBareSpecifiers(
      'import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";',
    ),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false for http: import", () => {
  assertEquals(
    sourceHasBareSpecifiers(
      'import { x } from "http://example.com/mod.ts";',
    ),
    false,
  );
});

Deno.test("sourceHasBareSpecifiers returns false when only relative and npm imports", () => {
  const source = `
import { z } from "npm:zod@4";
import { helper } from "./helpers.ts";
export { foo } from "../shared.ts";
`;
  assertEquals(sourceHasBareSpecifiers(source), false);
});

// --- extractBareSpecifierNames unit tests ---

Deno.test("extractBareSpecifierNames: returns bare specifier names", () => {
  assertEquals(
    extractBareSpecifierNames('import { z } from "zod";'),
    ["zod"],
  );
});

Deno.test("extractBareSpecifierNames: returns scoped bare specifiers", () => {
  assertEquals(
    extractBareSpecifierNames(
      'import { Client } from "@aws-sdk/client-secrets-manager";',
    ),
    ["@aws-sdk/client-secrets-manager"],
  );
});

Deno.test("extractBareSpecifierNames: collects multiple unique specifiers", () => {
  const source = `
import { z } from "zod";
import { decode } from "he";
import { z as z2 } from "zod";
`;
  const result = extractBareSpecifierNames(source);
  assertEquals(result.sort(), ["he", "zod"]);
});

Deno.test("extractBareSpecifierNames: ignores npm: prefixed imports", () => {
  assertEquals(
    extractBareSpecifierNames('import { z } from "npm:zod@4";'),
    [],
  );
});

Deno.test("extractBareSpecifierNames: ignores jsr: prefixed imports", () => {
  assertEquals(
    extractBareSpecifierNames('import { assert } from "jsr:@std/assert";'),
    [],
  );
});

Deno.test("extractBareSpecifierNames: ignores relative imports", () => {
  assertEquals(
    extractBareSpecifierNames('import { helper } from "./helpers.ts";'),
    [],
  );
});

Deno.test("extractBareSpecifierNames: ignores parent-relative imports", () => {
  assertEquals(
    extractBareSpecifierNames('import { shared } from "../shared.ts";'),
    [],
  );
});

Deno.test("extractBareSpecifierNames: ignores node: imports", () => {
  assertEquals(
    extractBareSpecifierNames('import { readFile } from "node:fs";'),
    [],
  );
});

Deno.test("extractBareSpecifierNames: ignores https: imports", () => {
  assertEquals(
    extractBareSpecifierNames(
      'import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";',
    ),
    [],
  );
});

Deno.test("extractBareSpecifierNames: ignores http: imports", () => {
  assertEquals(
    extractBareSpecifierNames('import { x } from "http://example.com/mod.ts";'),
    [],
  );
});

Deno.test("extractBareSpecifierNames: returns empty for no bare specifiers", () => {
  const source = `
import { z } from "npm:zod@4";
import { helper } from "./helpers.ts";
export { foo } from "../shared.ts";
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("extractBareSpecifierNames: handles re-exports", () => {
  assertEquals(
    extractBareSpecifierNames('export { z } from "zod";'),
    ["zod"],
  );
});

// --- comment stripping regression tests (swamp-club#602) ---

Deno.test("extractBareSpecifierNames: ignores quoted phrases in single-line comments", () => {
  const source = `import { z } from "npm:zod@4";

export function check() {
  // Distinguish "policy attached but unreadable" from "no policy". When
  // the value is absent it keeps its existing "no policy" behavior.
  return z.object({}).parse({});
}
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("extractBareSpecifierNames: ignores from patterns in block comments", () => {
  const source = `import { z } from "npm:zod@4";

/*
 * This export is derived from "legacy-pkg" but we no longer
 * import from "legacy-pkg" directly.
 */
export function check() {
  return z.object({}).parse({});
}
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("extractBareSpecifierNames: detects real bare imports adjacent to comments", () => {
  const source = `// this comment mentions "no policy"
import { z } from "zod";
`;
  assertEquals(extractBareSpecifierNames(source), ["zod"]);
});

Deno.test("extractBareSpecifierNames: preserves string literals containing //", () => {
  const source = `import { fetch } from "npm:undici@6";
const url = "https://example.com/api";
export function get() { return fetch(url); }
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

// --- string-literal false-positive regression tests (swamp-club#657) ---

Deno.test("extractBareSpecifierNames: ignores from-pattern in template literal", () => {
  const source = `export function getAdvice(mode: string): string {
  if (mode === "flexible") {
    return \`You should upgrade from "flexible" to "full" for security\`;
  }
  return "";
}
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("extractBareSpecifierNames: ignores from-pattern in single-quoted string", () => {
  const source = `export function logMessage(mode: string): void {
  const msg = 'Migrate from "flexible" to "full"';
  console.log(msg);
}
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("extractBareSpecifierNames: ignores template interpolation as specifier", () => {
  const source = `export function getAdvice(mode: string): string {
  return \`You should migrate from "\${mode}" to "full"\`;
}
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("extractBareSpecifierNames: real-world mixed imports with string false positives", () => {
  const source =
    `import { CloudflareClient } from "npm:@webframp/cloudflare@1.0.0";
import { z } from "npm:zod@4";

export function analyzeZones(client: CloudflareClient): Finding[] {
  const zones = client.getZones();
  for (const zone of zones) {
    const ssl = zone.sslMode;
    if (ssl === "off") {
      findings.push({ severity: "critical" });
    } else if (ssl === "flexible") {
      findings.push({
        severity: "warn",
        message: \`SSL mode is "flexible" — upgrade from "flexible" to "full"\`,
      });
    }
  }
  return findings;
}
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("sourceHasBareSpecifiers: ignores from-pattern in string literals", () => {
  const source = `export function getMessage(): string {
  return 'Migrate from "flexible" to "full"';
}
`;
  assertEquals(sourceHasBareSpecifiers(source), false);
});

Deno.test("extractBareSpecifierNames: multi-line import spanning 4+ lines still detected", () => {
  const source = `import {
  foo,
  bar,
  baz,
  qux,
} from "zod";
`;
  assertEquals(extractBareSpecifierNames(source), ["zod"]);
});

Deno.test("sourceHasBareSpecifiers: ignores quoted phrases in comments", () => {
  const source = `import { z } from "npm:zod@4";

export function check() {
  // existing "no policy" behavior
  return z.object({}).parse({});
}
`;
  assertEquals(sourceHasBareSpecifiers(source), false);
});

// --- generated-code false-positive regression tests (swamp-club#1490) ---

Deno.test("extractBareSpecifierNames: ignores an interpolated specifier in generated code", () => {
  // The reported shape: an eval script built as a template literal, whose
  // second import resolves to a valid npm: specifier only at runtime.
  const source = `export function buildScript(pkg: string): string {
  return \`
import * as modeling from "npm:@jscad/modeling@2.12.0";
import * as serializer from "\${pkg}";
console.log(serializer, modeling);
\`;
}
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("extractBareSpecifierNames: ignores a static bare specifier in generated code", () => {
  // No interpolation at all — the specifier is bare in the generated script,
  // which is the generated module's problem, not this module's.
  const source = `export function buildScript(): string {
  return \`import { z } from "zod";\`;
}
`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("extractBareSpecifierNames: detects a real bare import alongside generated code", () => {
  const source = `import { helper } from "my-helpers";

export function buildScript(pkg: string): string {
  return \`import * as s from "\${pkg}";\`;
}

export const h = helper;
`;
  assertEquals(extractBareSpecifierNames(source), ["my-helpers"]);
});

Deno.test("extractBareSpecifierNames: handles a nested template inside an interpolation", () => {
  const source = `export function buildScript(names: string[]): string {
  return \`\${names.map((n) => \`import "\${n}";\`).join("\\n")}\`;
}

import { z } from "zod";
`;
  assertEquals(extractBareSpecifierNames(source), ["zod"]);
});

Deno.test("extractBareSpecifierNames: handles object-literal braces inside an interpolation", () => {
  const source = `export function buildScript(): string {
  return \`config = \${JSON.stringify({ mode: "full" })};
import { x } from "generated";\`;
}

import { z } from "zod";
`;
  assertEquals(extractBareSpecifierNames(source), ["zod"]);
});

Deno.test("extractBareSpecifierNames: handles an unbalanced brace quoted inside an interpolation", () => {
  const source = `export function buildScript(): string {
  return \`\${"}"} import { x } from "generated";\`;
}

import { z } from "zod";
`;
  assertEquals(extractBareSpecifierNames(source), ["zod"]);
});

Deno.test("extractBareSpecifierNames: handles an escaped backtick inside a template", () => {
  const source = `export function buildScript(): string {
  return \`echo \\\` import { x } from "generated";\`;
}

import { z } from "zod";
`;
  assertEquals(extractBareSpecifierNames(source), ["zod"]);
});

Deno.test("extractBareSpecifierNames: still detects imports after a backtick in a regex literal", () => {
  // The scanner cannot recognise regex literals, so this backtick has no
  // closing partner. The span must be preserved verbatim rather than blanked,
  // or the real import below it would go unreported.
  const source = `const BACKTICK = /\`/;
import { z } from "zod";
`;
  assertEquals(extractBareSpecifierNames(source), ["zod"]);
});

Deno.test("extractBareSpecifierNames: preserves the tail after an unterminated template", () => {
  const source = `const broken = \`unterminated
import { z } from "zod";
`;
  // Degrades to the pre-fix reading rather than blanking the rest of the file.
  assertEquals(extractBareSpecifierNames(source), ["zod"]);
});

Deno.test("sourceHasBareSpecifiers: ignores an interpolated specifier in generated code", () => {
  const source = `export function buildScript(pkg: string): string {
  return \`import * as s from "\${pkg}";\`;
}
`;
  assertEquals(sourceHasBareSpecifiers(source), false);
});

Deno.test("extractBareSpecifierNames: ignores an interpolated specifier outside a template", () => {
  // Valid TypeScript — double quotes do not interpolate — so isBareSpecifier
  // must reject it on its own, without help from the template stripping.
  const source = `import * as s from "\${pkg}";`;
  assertEquals(extractBareSpecifierNames(source), []);
});

Deno.test("uint8ArrayToBase64 handles large input without stack overflow", () => {
  // 1MB of data — would blow the stack with String.fromCharCode(...bytes)
  const size = 1_000_000;
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = i % 256;
  }
  // Should not throw RangeError: Maximum call stack size exceeded
  const result = uint8ArrayToBase64(bytes);
  assertEquals(typeof result, "string");
  assertEquals(result.length > 0, true);
});

Deno.test("bundleExtension returns minimal module for type-only files", async () => {
  const tsCode = `
// A type-only file — all declarations are erased at compile time.
export interface Config {
  name: string;
  value?: number;
}

export type Status = "running" | "stopped";
`;

  await withTempFile(tsCode, async (path) => {
    const js = await bundleExtension(path, DENO_PATH);

    // Should return a minimal module instead of throwing
    assertEquals(js, "export {};\n");
  });
});

// --- isExpectedBundleFailure unit tests ---

Deno.test("isExpectedBundleFailure: returns true for bare specifiers without deno.json", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_expected_test_" });
  const extDir = repoDir + "/extensions/models/myext";
  await Deno.mkdir(extDir, { recursive: true });
  try {
    const source = `import { z } from "zod";\nexport const x = z;`;
    const filePath = extDir + "/model.ts";
    await Deno.writeTextFile(filePath, source);
    // No deno.json anywhere — bare specifier + no config = expected failure
    assertEquals(isExpectedBundleFailure(filePath, repoDir), true);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("isExpectedBundleFailure: returns false when deno.json exists", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_expected_test_" });
  // Simulate realistic layout: source in a subdirectory, deno.json alongside it
  const extDir = repoDir + "/extensions/models/myext";
  await Deno.mkdir(extDir, { recursive: true });
  try {
    const source = `import { z } from "zod";\nexport const x = z;`;
    const filePath = extDir + "/model.ts";
    await Deno.writeTextFile(filePath, source);
    await Deno.writeTextFile(extDir + "/deno.json", "{}");
    // deno.json exists — failure is unexpected even with bare specifiers
    assertEquals(isExpectedBundleFailure(filePath, repoDir), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("isExpectedBundleFailure: returns false for npm-only imports without deno.json", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_expected_test_" });
  const extDir = repoDir + "/extensions/models/myext";
  await Deno.mkdir(extDir, { recursive: true });
  try {
    const source = `import { z } from "npm:zod@4";\nexport const x = z;`;
    const filePath = extDir + "/model.ts";
    await Deno.writeTextFile(filePath, source);
    // No bare specifiers — failure is unexpected regardless of deno.json
    assertEquals(isExpectedBundleFailure(filePath, repoDir), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("isExpectedBundleFailure: returns false for generated imports without deno.json", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_expected_test_" });
  const extDir = repoDir + "/extensions/models/myext";
  await Deno.mkdir(extDir, { recursive: true });
  try {
    // Codegen only — the module itself has no bare specifiers, so a rebundle
    // failure here is a real failure and must not be silenced by the cache
    // (swamp-club#1490).
    const source =
      `export const script = \`import * as s from "\${pkg}";\`;\nexport const x = 1;`;
    const filePath = extDir + "/model.ts";
    await Deno.writeTextFile(filePath, source);
    assertEquals(isExpectedBundleFailure(filePath, repoDir), false);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("rejectZodV3Imports: ignores zod@3 import text inside a template literal", () => {
  const input = REAL_ZOD_IMPORT +
    '\nexport const t = `import { z } from "npm:zod@3.23.8";`;\n';
  rejectZodV3Imports(input);
});

Deno.test("rejectZodV3Imports: throws on a zod@3 import beside zod@3 text in a template", () => {
  const input = 'export const t = `import { z } from "npm:zod@3";`;\n' +
    `import { z } from "npm:zod@3.23.8";\n`;
  assertThrows(() => rejectZodV3Imports(input), Error, "npm:zod@3.23.8");
});

// --- importMapTarget unit tests ---

Deno.test("importMapTarget: an exact key resolves to its explicit specifier", () => {
  const imports = {
    "zod": "npm:zod@4.3.6",
    "@azure/core-auth": "npm:@azure/core-auth@1.9.0",
  };
  assertEquals(importMapTarget("zod", imports), "npm:zod@4.3.6");
  assertEquals(
    importMapTarget("@azure/core-auth", imports),
    "npm:@azure/core-auth@1.9.0",
  );
});

Deno.test("importMapTarget: the longest trailing-slash prefix key resolves the rest of the path", () => {
  const imports = {
    "@std/": "jsr:@std/",
    "@std/path/": "jsr:@std/path@1.1.0/",
  };
  assertEquals(importMapTarget("@std/assert", imports), "jsr:@std/assert");
  assertEquals(
    importMapTarget("@std/path/posix", imports),
    "jsr:@std/path@1.1.0/posix",
  );
});

Deno.test("importMapTarget: no entry, a non-matching key or a bare target gives no suggestion", () => {
  assertEquals(importMapTarget("zod", undefined), undefined);
  assertEquals(importMapTarget("zod/v4", { "zod": "npm:zod@4" }), undefined);
  assertEquals(importMapTarget("lib", { "lib": "other-bare" }), undefined);
  assertEquals(
    importMapTarget("lib", { "lib": "./lib/mod.ts" }),
    "./lib/mod.ts",
  );
});

Deno.test("runFirstAlone: a later call waits until the first call for its key settles", async () => {
  const gates = new Map<string, Promise<boolean>>();
  const first = Promise.withResolvers<void>();
  const started: string[] = [];
  const a = runFirstAlone(gates, "cache", async () => {
    started.push("a");
    await first.promise;
  });
  const b = runFirstAlone(gates, "cache", () => {
    started.push("b");
    return Promise.resolve();
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(started, ["a"]);
  first.resolve();
  await Promise.all([a, b]);
  assertEquals(started, ["a", "b"]);
});

Deno.test("runFirstAlone: once the first call succeeds, later calls run side by side", async () => {
  const gates = new Map<string, Promise<boolean>>();
  await runFirstAlone(gates, "cache", () => Promise.resolve());
  const held = Promise.withResolvers<void>();
  let running = 0;
  let peak = 0;
  const call = () =>
    runFirstAlone(gates, "cache", async () => {
      running++;
      peak = Math.max(peak, running);
      await held.promise;
      running--;
    });
  const calls = [call(), call()];
  await waitFor(() => running === 2, "both calls running");
  held.resolve();
  await Promise.all(calls);
  assertEquals(peak, 2);
});

Deno.test("runFirstAlone: a different key is not held back", async () => {
  const gates = new Map<string, Promise<boolean>>();
  const first = Promise.withResolvers<void>();
  const a = runFirstAlone(gates, "one", () => first.promise);
  let otherRan = false;
  await runFirstAlone(gates, "two", () => {
    otherRan = true;
    return Promise.resolve();
  });
  assertEquals(otherRan, true);
  first.resolve();
  await a;
});

Deno.test("runFirstAlone: a failed first call lets the next caller go first", async () => {
  const gates = new Map<string, Promise<boolean>>();
  const first = Promise.withResolvers<void>();
  const a = runFirstAlone(gates, "cache", () => first.promise);
  const second = Promise.withResolvers<void>();
  const started: string[] = [];
  const b = runFirstAlone(gates, "cache", async () => {
    started.push("b");
    await second.promise;
  });
  const c = runFirstAlone(gates, "cache", () => {
    started.push("c");
    return Promise.resolve();
  });
  first.reject(new Error("spawn failed"));
  await assertRejects(() => a, Error, "spawn failed");
  await waitFor(() => started.length > 0, "a caller to start");
  assertEquals(started, ["b"], "b runs alone in the failed call's place");
  second.resolve();
  await Promise.all([b, c]);
  assertEquals(started, ["b", "c"]);
});

Deno.test("runFirstAlone: a first result that succeeded rejects lets the next caller go first", async () => {
  const gates = new Map<string, Promise<boolean>>();
  const first = Promise.withResolvers<string>();
  const a = runFirstAlone(gates, "cache", () => first.promise, {
    succeeded: (result) => result === "installed",
  });
  const second = Promise.withResolvers<string>();
  const started: string[] = [];
  const b = runFirstAlone(gates, "cache", async () => {
    started.push("b");
    return await second.promise;
  });
  const c = runFirstAlone(gates, "cache", () => {
    started.push("c");
    return Promise.resolve("installed");
  });
  first.resolve("lost the race");
  assertEquals(await a, "lost the race", "the caller still gets its result");
  await waitFor(() => started.length > 0, "a caller to start");
  assertEquals(started, ["b"], "b runs alone in the failed call's place");
  second.resolve("installed");
  await Promise.all([b, c]);
  assertEquals(started, ["b", "c"]);
});

Deno.test("runFirstAlone: an abort ends a wait behind the first call", async () => {
  const gates = new Map<string, Promise<boolean>>();
  const first = Promise.withResolvers<void>();
  const a = runFirstAlone(gates, "cache", () => first.promise);
  const controller = new AbortController();
  let ran = false;
  const b = runFirstAlone(gates, "cache", () => {
    ran = true;
    return Promise.resolve();
  }, { signal: controller.signal });
  controller.abort(new Error("shutting down"));
  await assertRejects(() => b, Error, "shutting down");
  assertEquals(ran, false);
  first.resolve();
  await a;
});

const RACE_OUTPUT =
  "error: failed to copy esbuild binary from /c/npm/esbuild " +
  "to /c/dl/esbuild-0.25.5-1/.esbuild-1.tmp (os error 2)";

/**
 * A fake `deno bundle`: writes the `-o` file, or answers with the esbuild
 * install race while `loses()` holds. Records how many run at once. With
 * `holdUntilPeak`, each run waits until that many have run at once, so
 * overlap never depends on how long each caller takes to reach the spawn.
 */
function fakeBundler(loses: () => boolean, holdUntilPeak?: number) {
  const state = { running: 0, peak: 0, runs: 0 };
  const handler = async (_cmd: string, args: string[]) => {
    state.runs++;
    state.running++;
    state.peak = Math.max(state.peak, state.running);
    if (holdUntilPeak === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    } else {
      // Reads peak, not running: a run that passed its wait may already
      // have finished.
      await waitFor(
        () => state.peak >= holdUntilPeak,
        `${holdUntilPeak} bundles running at once`,
      );
    }
    state.running--;
    if (loses()) return { stdout: "", stderr: RACE_OUTPUT, code: 1 };
    await Deno.writeTextFile(
      args[args.indexOf("-o") + 1],
      "export const bundled = 1;\n",
    );
    return { stdout: "", code: 0 };
  };
  return { state, handler };
}

Deno.test("bundleExtension: a bundle that loses an esbuild install race is retried once", async () => {
  await withTempFile("export const x = 1;\n", async (path) => {
    let lost = 0;
    const { state, handler } = fakeBundler(() => lost++ === 0);
    const { result } = await withMockedCommand(
      handler,
      () =>
        bundleExtension(path, DENO_PATH, {
          env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
        }),
    );
    assertStringIncludes(result, "bundled");
    assertEquals(state.runs, 2);
  });
});

Deno.test("bundleExtension: an error other than the esbuild race is not retried", async () => {
  await withTempFile("export const x = 1;\n", async (path) => {
    const { calls } = await withMockedCommand(
      [{ stdout: "", stderr: "error: Module not found", code: 1 }],
      async () => {
        await assertRejects(
          () =>
            bundleExtension(path, DENO_PATH, {
              env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
            }),
          Error,
          "Module not found",
        );
      },
    );
    assertEquals(calls.length, 1);
  });
});

Deno.test("bundleExtension: no bundle on the same cache starts beside the first one or its retry", async () => {
  await withTempFile("export const x = 1;\n", async (path) => {
    let lost = 0;
    // The first run loses the race; its retry and every later run succeed.
    const { state, handler } = fakeBundler(() => lost++ === 0);
    const env = { DENO_DIR: `/cache-${crypto.randomUUID()}` };
    await withMockedCommand(handler, async () => {
      const first = bundleExtension(path, DENO_PATH, { env });
      const second = bundleExtension(path, DENO_PATH, { env });
      await Promise.all([first, second]);
    });
    assertEquals(state.runs, 3);
    assertEquals(state.peak, 1, "the retry and the waiter never overlap");
  });
});

Deno.test("bundleExtension: bundles on different caches do not wait for each other", async () => {
  await withTempFile("export const x = 1;\n", async (path) => {
    const { state, handler } = fakeBundler(() => false, 2);
    await withMockedCommand(handler, async () => {
      await Promise.all([
        bundleExtension(path, DENO_PATH, {
          env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
        }),
        bundleExtension(path, DENO_PATH, {
          env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
        }),
      ]);
    });
    assertEquals(state.peak, 2);
  });
});

Deno.test("isEsbuildInstallRace: matches only the esbuild copy failure", () => {
  assertEquals(
    isEsbuildInstallRace(
      "error: failed to copy esbuild binary from /c/npm/esbuild to " +
        "/c/dl/esbuild-0.25.5-1/.esbuild-13911.tmp\n\nCaused by:\n" +
        "    No such file or directory (os error 2)",
    ),
    true,
  );
  assertEquals(
    isEsbuildInstallRace(
      'error: Module not found "file:///x/missing.ts".',
    ),
    false,
  );
});

// Deno 2.9.7's --frozen refusal, colours and all, as `deno bundle` and
// `deno info` print it. If an embedded Deno bump changes this text, the
// stale-lock message falls back to the generic failure: update it here.
const STALE_LOCK_OUTPUT = "\u001b[0m\u001b[1m\u001b[31merror\u001b[0m: " +
  "Prepare module load error\n\nCaused by:\n    The lockfile is out of " +
  "date. Run `deno install --frozen=false`, or rerun with `--frozen=false` " +
  'to update it.\n    changes:\n     4 | -    "npm:ms@2": "2.1.3"\n' +
  '     4 | +    "npm:ms@^2.1.0": "2.1.3"\n';

Deno.test("denoProjectArgs: without readOnlyLock the flags are unchanged", () => {
  assertEquals(denoProjectArgs({ denoConfigPath: "/p/deno.json" }), [
    "--config",
    "/p/deno.json",
  ]);
  assertEquals(denoProjectArgs({ packageJsonDir: "/p" }), [
    "--node-modules-dir=auto",
  ]);
  assertEquals(denoProjectArgs(), ["--no-lock", "--node-modules-dir=none"]);
});

Deno.test("denoProjectArgs: readOnlyLock freezes an existing lock, disables a missing one and reads node_modules as installed", () => {
  const lockPath = "/p/deno.lock";
  assertEquals(
    denoProjectArgs({
      denoConfigPath: "/p/deno.json",
      readOnlyLock: { lockPath },
    }),
    ["--config", "/p/deno.json", "--frozen"],
  );
  assertEquals(
    denoProjectArgs({ denoConfigPath: "/p/deno.json", readOnlyLock: {} }),
    ["--config", "/p/deno.json", "--no-lock"],
  );
  assertEquals(
    denoProjectArgs({ packageJsonDir: "/p", readOnlyLock: { lockPath } }),
    ["--node-modules-dir=manual", "--frozen"],
  );
  assertEquals(
    denoProjectArgs({ packageJsonDir: "/p", readOnlyLock: {} }),
    ["--node-modules-dir=manual", "--no-lock"],
  );
  assertEquals(denoProjectArgs({ readOnlyLock: {} }), [
    "--no-lock",
    "--node-modules-dir=none",
  ]);
});

Deno.test("isStaleLockfile: matches Deno's --frozen refusal only", () => {
  assertEquals(isStaleLockfile(STALE_LOCK_OUTPUT), true);
  assertEquals(
    isStaleLockfile('error: Module not found "file:///x.ts".'),
    false,
  );
});

Deno.test("staleLockfileError: names the lock, the config and the fix, and keeps the changes", () => {
  const configDir = join("ext", "proj");
  const error = staleLockfileError(
    join(configDir, "deno.lock"),
    join(configDir, "mod.ts"),
    { denoConfigPath: join(configDir, "deno.json") },
    STALE_LOCK_OUTPUT,
  );
  assertEquals(error instanceof UserError, true);
  assertStringIncludes(
    error.message,
    `${join(configDir, "deno.lock")} is out of date with ${
      join(configDir, "deno.json")
    }`,
  );
  assertStringIncludes(
    error.message,
    `Run \`deno install --entrypoint ${
      join(configDir, "mod.ts")
    }\` in ${configDir}`,
  );
  assertStringIncludes(error.message, '+    "npm:ms@^2.1.0": "2.1.3"');
  assertEquals(error.message.includes("--frozen=false"), false);
  assertEquals(error.message.includes("\u001b"), false);
});

Deno.test("staleLockfileError: package.json mode names package.json and its directory", () => {
  const dir = join("ext", "pkg");
  const error = staleLockfileError(
    join(dir, "deno.lock"),
    join(dir, "mod.ts"),
    { packageJsonDir: dir },
    STALE_LOCK_OUTPUT,
  );
  assertStringIncludes(error.message, "is out of date with package.json");
  assertStringIncludes(error.message, `\` in ${dir}, commit`);
});

Deno.test("staleLockfileError: is a StaleLockfileError carrying what it names", () => {
  const configDir = join("ext", "proj");
  const error = staleLockfileError(
    join(configDir, "deno.lock"),
    join(configDir, "mod.ts"),
    { denoConfigPath: join(configDir, "deno.json") },
    STALE_LOCK_OUTPUT,
  );
  assertEquals(error instanceof StaleLockfileError, true);
  assertEquals(error.lockPath, join(configDir, "deno.lock"));
  assertEquals(error.projectFile, join(configDir, "deno.json"));
  assertEquals(error.projectDir, configDir);
  assertEquals(error.entryPoint, join(configDir, "mod.ts"));
});

Deno.test("groupStaleLockfiles: one entry per lock with every entry point it refused", () => {
  const project = { denoConfigPath: join("p", "deno.json") };
  const lock = join("p", "deno.lock");
  const other = join("q", "deno.lock");
  const grouped = groupStaleLockfiles([
    staleLockfileError(lock, join("p", "a.ts"), project, STALE_LOCK_OUTPUT),
    staleLockfileError(lock, join("p", "b.ts"), project, STALE_LOCK_OUTPUT),
    staleLockfileError(lock, join("p", "a.ts"), project, STALE_LOCK_OUTPUT),
    staleLockfileError(
      other,
      join("q", "c.ts"),
      { packageJsonDir: "q" },
      STALE_LOCK_OUTPUT,
    ),
  ]);
  assertEquals(grouped, [
    {
      lockPath: lock,
      projectFile: join("p", "deno.json"),
      projectDir: "p",
      entryPoints: [join("p", "a.ts"), join("p", "b.ts")],
    },
    {
      lockPath: other,
      projectFile: "package.json",
      projectDir: "q",
      entryPoints: [join("q", "c.ts")],
    },
  ]);
});

Deno.test("staleLockfileInstallCommand: lists the entry points, quoting one with whitespace", () => {
  assertEquals(
    staleLockfileInstallCommand({
      lockPath: "deno.lock",
      projectFile: "deno.json",
      projectDir: ".",
      entryPoints: ["a.ts", join("my models", "b.ts")],
    }),
    `deno install --entrypoint a.ts "${join("my models", "b.ts")}"`,
  );
});

Deno.test("bundleExtension: readOnlyLock bundles with --frozen and reports a stale lock", async () => {
  await withTempFile("export const x = 1;\n", async (path) => {
    const lockPath = join(path, "..", "deno.lock");
    const { calls } = await withMockedCommand(
      [{ stdout: "", stderr: STALE_LOCK_OUTPUT, code: 1 }],
      async () => {
        await assertRejects(
          () =>
            bundleExtension(path, DENO_PATH, {
              denoConfigPath: join(path, "..", "deno.json"),
              readOnlyLock: { lockPath },
              env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
              // The caller's resolutions: the bundle is the only deno call.
              bareImports: [],
            }),
          UserError,
          `${lockPath} is out of date`,
        );
      },
    );
    assertEquals(calls[0].args.includes("--frozen"), true);
  });
});

Deno.test("bundleExtension: without readOnlyLock a stale-lock failure is the generic bundle error", async () => {
  await withTempFile("export const x = 1;\n", async (path) => {
    await withMockedCommand(
      [{ stdout: "", stderr: STALE_LOCK_OUTPUT, code: 1 }],
      async () => {
        await assertRejects(
          () =>
            bundleExtension(path, DENO_PATH, {
              env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
            }),
          Error,
          "deno bundle failed for",
        );
      },
    );
  });
});

// --- zod externalization under the project config (swamp-club#3612) ---

Deno.test("sharedZodTargets: the targets of a bare zod every module resolves to zod 4", () => {
  assertEquals(
    sharedZodTargets([
      { importer: "/r/a.ts", specifier: "zod", target: "npm:zod@4.3.6" },
      { importer: "/r/b.ts", specifier: "zod", target: "npm:zod@^4.1" },
      { importer: "/r/b.ts", specifier: "ms", target: "npm:ms@2" },
    ]),
    ["npm:zod@4.3.6", "npm:zod@^4.1"],
  );
  assertEquals(
    sharedZodTargets([
      { importer: "/r/a.ts", specifier: "zod", target: "npm:/zod@4" },
    ]),
    ["npm:zod@4"],
  );
});

Deno.test("sharedZodTargets: none when any module's bare zod is not zod 4, so the bundle inlines it", () => {
  // A scope sends the same name to zod 3 in one module: --external matches
  // the written "zod" for the whole bundle, so it must stay inlined.
  assertEquals(
    sharedZodTargets([
      { importer: "/r/a.ts", specifier: "zod", target: "npm:zod@4.3.6" },
      { importer: "/r/lib/b.ts", specifier: "zod", target: "npm:zod@3.23.8" },
    ]),
    [],
  );
  assertEquals(
    sharedZodTargets([{ importer: "/r/a.ts", specifier: "zod" }]),
    [],
  );
  assertEquals(
    sharedZodTargets([
      { importer: "/r/a.ts", specifier: "zod", target: "npm:zod@^4 || ^3" },
    ]),
    [],
  );
  assertEquals(
    sharedZodTargets([
      { importer: "/r/a.ts", specifier: "zod", target: "file:///r/zod.ts" },
    ]),
    [],
  );
  assertEquals(sharedZodTargets([]), []);
});

/** A fake deno: `info` answers `infoJson`, `bundle` writes a bundle. */
function fakeDenoWithInfo(infoJson: unknown) {
  const calls: string[][] = [];
  const handler = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "info") {
      return { stdout: JSON.stringify(infoJson), code: 0 };
    }
    await Deno.writeTextFile(
      args[args.indexOf("-o") + 1],
      "export const bundled = 1;\n",
    );
    return { stdout: "", code: 0 };
  };
  return { calls, handler };
}

Deno.test("bundleExtension: under a config, reads the graph and externalizes a bare zod Deno resolves to zod 4 (swamp-club#3612)", async () => {
  await withTempFile('import { z } from "zod";\n', async (path) => {
    const { calls, handler } = fakeDenoWithInfo({
      modules: [{
        specifier: toFileUrl(path).href,
        dependencies: [{
          specifier: "zod",
          code: { specifier: "npm:zod@4.3.6" },
        }],
      }],
    });
    const config = join(path, "..", "deno.jsonc");
    await withMockedCommand(handler, () =>
      bundleExtension(path, DENO_PATH, {
        denoConfigPath: config,
        readOnlyLock: {},
        env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
      }));
    assertEquals(calls.length, 2);
    assertEquals(calls[0].slice(0, 2), ["info", "--json"]);
    assertEquals(calls[0].includes(config), true);
    assertEquals(calls[0].includes("--no-lock"), true);
    const bundle = calls[1].join(" ");
    assertStringIncludes(bundle, "--external npm:zod@4.3.6");
    assertStringIncludes(bundle, "--external zod");
  });
});

Deno.test({
  name:
    "bundleExtension: an entry point reached through a symlink above a node_modules is read by real path, so an importer there counts and its zod 3 keeps the bare zod bundled (swamp-club#3794)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const outer = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "bundle-link-" }),
    );
    try {
      const real = join(outer, "real", "node_modules", "repo");
      await Deno.mkdir(real, { recursive: true });
      await Deno.symlink(join(outer, "real"), join(outer, "link"), {
        type: "dir",
      });
      const entry = join(outer, "link", "node_modules", "repo", "m.ts");
      await Deno.writeTextFile(entry, 'import { z } from "zod";\n');
      // deno info names the root as given and, below a node_modules, what
      // it imports by real path; read as given, lib.ts would not count.
      const calls: string[][] = [];
      const handler = async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "info") {
          const root = args[args.length - 1];
          return {
            stdout: JSON.stringify({
              roots: [root],
              modules: [{
                specifier: root,
                dependencies: [{
                  specifier: "zod",
                  code: { specifier: "npm:zod@4.3.6" },
                }],
              }, {
                specifier: toFileUrl(join(real, "lib.ts")).href,
                dependencies: [{
                  specifier: "zod",
                  code: { specifier: "npm:zod@3.23.8" },
                }],
              }],
            }),
            code: 0,
          };
        }
        await Deno.writeTextFile(
          args[args.indexOf("-o") + 1],
          "export const bundled = 1;\n",
        );
        return { stdout: "", code: 0 };
      };
      await withMockedCommand(handler, () =>
        bundleExtension(entry, DENO_PATH, {
          denoConfigPath: join(real, "deno.json"),
          readOnlyLock: {},
          env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
        }));
      assertEquals(calls.length, 2);
      assertEquals(
        calls[0][calls[0].length - 1],
        toFileUrl(join(real, "m.ts")).href,
      );
      assertEquals(calls[1][0], "bundle");
      assertEquals(calls[1].includes("zod"), false);
    } finally {
      await Deno.remove(outer, { recursive: true });
    }
  },
});

Deno.test("bundleExtension: a scope sending zod to zod 3 in one module keeps the bare zod bundled", async () => {
  await withTempFile('import { z } from "zod";\n', async (path) => {
    const { calls, handler } = fakeDenoWithInfo({});
    await withMockedCommand(handler, () =>
      bundleExtension(path, DENO_PATH, {
        denoConfigPath: join(path, "..", "deno.json"),
        env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
        bareImports: [
          { importer: path, specifier: "zod", target: "npm:zod@4.3.6" },
          {
            importer: join(path, "..", "lib.ts"),
            specifier: "zod",
            target: "npm:zod@3.23.8",
          },
        ],
      }));
    // The caller's resolutions are used: deno runs once, for the bundle.
    assertEquals(calls.length, 1);
    assertEquals(calls[0][0], "bundle");
    assertEquals(calls[0].includes("zod"), false);
  });
});

Deno.test("bundleExtension: a graph read that fails falls back to the config's own zod 4 entry", async () => {
  await withTempFile('import { z } from "zod";\n', async (path) => {
    const config = join(path, "..", `deno-${crypto.randomUUID()}.json`);
    const calls: string[][] = [];
    const run = (configText: string) =>
      withMockedCommand(async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "info") return { stdout: "", stderr: "boom", code: 1 };
        await Deno.writeTextFile(args[args.indexOf("-o") + 1], "export {};\n");
        return { stdout: "", code: 0 };
      }, async () => {
        await Deno.writeTextFile(config, configText);
        await bundleExtension(path, DENO_PATH, {
          denoConfigPath: config,
          env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
        });
      });
    try {
      await run(JSON.stringify({ imports: { zod: "npm:zod@4" } }));
      assertStringIncludes(calls[1].join(" "), "--external zod");
      // A config with no zod 4 entry gives nothing to fall back to.
      calls.length = 0;
      await run(JSON.stringify({ imports: { zod: "npm:zod@3.23.8" } }));
      assertEquals(calls[1].includes("zod"), false);
    } finally {
      await Deno.remove(config).catch(() => {});
    }
  });
});

Deno.test("bundleExtension: a bare zod unresolved in node_modules is read again with --node-modules-dir=none and externalized", async () => {
  await withTempFile('import { z } from "zod";\n', async (path) => {
    const zodInfo = (code: Record<string, string>) => ({
      modules: [{
        specifier: toFileUrl(path).href,
        dependencies: [{ specifier: "zod", code }],
      }],
    });
    const calls: string[][] = [];
    await withMockedCommand(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "info") {
        const info = args.includes("--node-modules-dir=none")
          ? zodInfo({ specifier: "npm:zod@4" })
          : zodInfo({
            error: 'Could not find "zod" in a node_modules folder.',
          });
        return { stdout: JSON.stringify(info), code: 0 };
      }
      await Deno.writeTextFile(args[args.indexOf("-o") + 1], "export {};\n");
      return { stdout: "", code: 0 };
    }, () =>
      bundleExtension(path, DENO_PATH, {
        denoConfigPath: join(path, "..", "deno.json"),
        env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
      }));
    assertEquals(calls.map((c) => c[0]), ["info", "info", "bundle"]);
    const bundle = calls[2].join(" ");
    assertStringIncludes(bundle, "--external npm:zod@4");
    assertStringIncludes(bundle, "--external zod");
  });
});

Deno.test("bundleExtension: when Deno gives no answer for a bare zod, the config's own zod 4 entry stays external", async () => {
  await withTempFile('import { z } from "zod";\n', async (path) => {
    const config = join(path, "..", `deno-${crypto.randomUUID()}.jsonc`);
    await Deno.writeTextFile(
      config,
      '// offline\n{ "imports": { "zod": "npm:zod@4.3.6" } }',
    );
    try {
      const calls: string[][] = [];
      await withMockedCommand(async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "info") {
          // The first read cannot find zod in node_modules; the second,
          // offline, fails outright.
          if (args.includes("--node-modules-dir=none")) {
            return { stdout: "", stderr: "network unreachable", code: 1 };
          }
          return {
            stdout: JSON.stringify({
              modules: [{
                specifier: toFileUrl(path).href,
                dependencies: [{
                  specifier: "zod",
                  code: { error: "Could not find zod in node_modules" },
                }],
              }],
            }),
            code: 0,
          };
        }
        await Deno.writeTextFile(args[args.indexOf("-o") + 1], "export {};\n");
        return { stdout: "", code: 0 };
      }, () =>
        bundleExtension(path, DENO_PATH, {
          denoConfigPath: config,
          env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
        }));
      // Loader path (no readOnlyLock): the resolution reads still never
      // touch the author's lock.
      for (const info of calls.filter((c) => c[0] === "info")) {
        assertEquals(info.includes("--no-lock"), true);
      }
      const bundle = calls.find((c) => c[0] === "bundle")!.join(" ");
      assertStringIncludes(bundle, "--external npm:zod@4.3.6");
      assertStringIncludes(bundle, "--external zod");
    } finally {
      await Deno.remove(config);
    }
  });
});

Deno.test("bundleExtension: no fallback when Deno resolves zod to zod 3 in some module", async () => {
  await withTempFile('import { z } from "zod";\n', async (path) => {
    const config = join(path, "..", `deno-${crypto.randomUUID()}.json`);
    await Deno.writeTextFile(
      config,
      JSON.stringify({ imports: { zod: "npm:zod@4" } }),
    );
    try {
      const calls: string[][] = [];
      await withMockedCommand(async (_cmd: string, args: string[]) => {
        calls.push(args);
        await Deno.writeTextFile(args[args.indexOf("-o") + 1], "export {};\n");
        return { stdout: "", code: 0 };
      }, () =>
        bundleExtension(path, DENO_PATH, {
          denoConfigPath: config,
          env: { DENO_DIR: `/cache-${crypto.randomUUID()}` },
          bareImports: [
            { importer: path, specifier: "zod", target: "npm:zod@3.23.8" },
          ],
        }));
      assertEquals(calls[0].includes("zod"), false);
    } finally {
      await Deno.remove(config);
    }
  });
});
