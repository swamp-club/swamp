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
import { join } from "@std/path";
import { bareImportResolverFrom } from "./bare_import_resolution.ts";
import {
  extractDependencySpecifiers,
  extractSpecifiersFromSource,
  findImportSpecifiers,
  type ImportMap,
  importMapResolver,
  resolveBareImport,
} from "./extension_dependency_extractor.ts";

Deno.test("extractSpecifiersFromSource: extracts npm specifier with version", () => {
  const source = `import { z } from "npm:zod@4";
import axios from "npm:axios@1.7.2";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "axios");
  assertEquals(result[0].version, "1.7.2");
  assertEquals(result[0].registry, "npm");
});

Deno.test("extractSpecifiersFromSource: excludes zod (externalized)", () => {
  const source = `import { z } from "npm:zod@4";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 0);
});

Deno.test("extractSpecifiersFromSource: extracts scoped npm packages", () => {
  const source = `import { S3Client } from "npm:@aws-sdk/client-s3@3.600.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "@aws-sdk/client-s3");
  assertEquals(result[0].version, "3.600.0");
  assertEquals(result[0].registry, "npm");
});

Deno.test("extractSpecifiersFromSource: extracts jsr specifiers", () => {
  const source = `import { parse } from "jsr:@std/semver@1.0.8";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "@std/semver");
  assertEquals(result[0].version, "1.0.8");
  assertEquals(result[0].registry, "jsr");
});

Deno.test("extractSpecifiersFromSource: handles missing version", () => {
  const source = `import lodash from "npm:lodash-es";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "lodash-es");
  assertEquals(result[0].version, null);
  assertEquals(result[0].registry, "npm");
});

Deno.test("extractSpecifiersFromSource: deduplicates same package", () => {
  const source = `import { foo } from "npm:axios@1.7.2";
import { bar } from "npm:axios@1.7.2";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
});

Deno.test("extractSpecifiersFromSource: keeps each version of one package", () => {
  const source = `import { foo } from "npm:axios@^1.6.0";
import { bar } from "npm:axios@1.7.2/sub";
import { baz } from "npm:axios@^1.6.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.map((s) => s.version), ["^1.6.0", "1.7.2"]);
});

Deno.test("extractSpecifiersFromSource: extracts multiple packages", () => {
  const source = `import { z } from "npm:zod@4";
import mqtt from "npm:mqtt@5.10.3";
import { parse } from "jsr:@std/semver@1.0.8";
import { retry } from "npm:p-retry@6.2.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 3);
  assertEquals(result[0].name, "mqtt");
  assertEquals(result[1].name, "@std/semver");
  assertEquals(result[2].name, "p-retry");
});

Deno.test("extractSpecifiersFromSource: ignores relative imports", () => {
  const source = `import { helper } from "./helpers.ts";
import { util } from "../utils/mod.ts";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 0);
});

Deno.test("extractSpecifiersFromSource: handles side-effect imports", () => {
  const source = `import "npm:dotenv@16.4.5";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "dotenv");
  assertEquals(result[0].version, "16.4.5");
});

Deno.test("extractSpecifiersFromSource: extracts dynamic imports", () => {
  const source = `const mod = await import("npm:untrusted-pkg@1.0");`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "untrusted-pkg");
  assertEquals(result[0].version, "1.0");
});

Deno.test("extractSpecifiersFromSource: ignores commented-out imports", () => {
  const source = `// import old from "npm:deprecated-pkg@1.0";
import active from "npm:good-pkg@2.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "good-pkg");
});

Deno.test("extractSpecifiersFromSource: ignores block-commented imports", () => {
  const source = `/* import old from "npm:deprecated-pkg@1.0"; */
import active from "npm:good-pkg@2.0";`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "good-pkg");
});

Deno.test("extractSpecifiersFromSource: returns empty for no imports", () => {
  const source = `const x = 42;
export function hello() { return "world"; }`;
  const result = extractSpecifiersFromSource(source, "model.ts");

  assertEquals(result.length, 0);
});

// ── Bare imports through the import map ─────────────────────────────────

/** The audited specifiers, as `registry:name@version <- bare`. */
function mappedOf(source: string, imports: ImportMap): string[] {
  return extractSpecifiersFromSource(
    source,
    "model.ts",
    importMapResolver(imports),
  ).map((s) =>
    `${s.registry}:${s.name}@${s.version ?? ""}${
      s.importedAs !== undefined ? ` <- ${s.importedAs}` : ""
    }`
  );
}

Deno.test("extractSpecifiersFromSource: resolves a bare import through an exact key", () => {
  assertEquals(
    mappedOf(`import ms from "ms";`, { ms: "npm:ms@2.1.3" }),
    ["npm:ms@2.1.3 <- ms"],
  );
});

Deno.test("extractSpecifiersFromSource: resolves a scoped key to npm and jsr", () => {
  assertEquals(
    mappedOf(
      `import type { V4 } from "uuid-types";
import { assert } from "@std/assert";`,
      {
        "uuid-types": "npm:@types/uuid@10.0.0",
        "@std/assert": "jsr:@std/assert@^1.0.0",
      },
    ),
    [
      "npm:@types/uuid@10.0.0 <- uuid-types",
      "jsr:@std/assert@^1.0.0 <- @std/assert",
    ],
  );
});

Deno.test("extractSpecifiersFromSource: a trailing-slash key resolves a subpath", () => {
  assertEquals(
    mappedOf(`import { h } from "preact/hooks";`, {
      "preact/": "npm:/preact@10.27.3/",
    }),
    ["npm:preact@10.27.3 <- preact/hooks"],
  );
});

Deno.test("extractSpecifiersFromSource: a package key covers its subpaths, as Deno expands it", () => {
  assertEquals(
    mappedOf(`import { join } from "@std/path/posix";`, {
      "@std/path": "jsr:@std/path@^1",
    }),
    ["jsr:@std/path@^1 <- @std/path/posix"],
  );
});

Deno.test("extractSpecifiersFromSource: a trailing-slash key beats the package key's expansion", () => {
  assertEquals(
    mappedOf(`import { join } from "@std/path/posix";`, {
      "@std/path": "jsr:@std/path@1.0.0",
      "@std/path/": "jsr:/@std/path@1.1.0/",
    }),
    ["jsr:@std/path@1.1.0 <- @std/path/posix"],
  );
});

Deno.test("extractSpecifiersFromSource: reads export-from, side-effect and dynamic bare imports", () => {
  assertEquals(
    mappedOf(
      `export { a } from "a";
import "b";
const c = await import("c");`,
      { a: "npm:a@1.0.0", b: "npm:b@1.0.0", c: "npm:c@1.0.0" },
    ),
    ["npm:a@1.0.0 <- a", "npm:b@1.0.0 <- b", "npm:c@1.0.0 <- c"],
  );
});

Deno.test("extractSpecifiersFromSource: ignores targets that are not npm or jsr", () => {
  assertEquals(
    mappedOf(
      `import a from "a";
import b from "b";
import c from "c";`,
      { a: "https://esm.sh/a@1", b: "./vendor/b.ts", c: "c-other" },
    ),
    [],
  );
});

Deno.test("extractSpecifiersFromSource: absolute, file: and data: specifiers are not audited", () => {
  assertEquals(
    mappedOf(
      `import a from "/abs/a.ts";
import b from "file:///b.ts";
import c from "data:text/javascript,export default 1";`,
      { ms: "npm:ms@2.1.3" },
    ),
    [],
  );
});

Deno.test("extractSpecifiersFromSource: zod through the map stays excluded", () => {
  assertEquals(mappedOf(`import { z } from "zod";`, { zod: "npm:zod@4" }), []);
});

Deno.test("extractSpecifiersFromSource: map entries the source does not import are not audited", () => {
  assertEquals(
    mappedOf(`import ms from "ms";`, {
      ms: "npm:ms@2.1.3",
      unused: "npm:unused@1.0.0",
    }),
    ["npm:ms@2.1.3 <- ms"],
  );
});

Deno.test("extractSpecifiersFromSource: ignores bare imports in comments and template literals", () => {
  assertEquals(
    mappedOf(
      `// import a from "a";
/* import b from "b"; */
const generated = \`import c from "c";\`;`,
      { a: "npm:a@1.0.0", b: "npm:b@1.0.0", c: "npm:c@1.0.0" },
    ),
    [],
  );
});

Deno.test("extractSpecifiersFromSource: a string that names no map key is ignored", () => {
  assertEquals(
    mappedOf(`const m = 'value from "config"';`, { ms: "npm:ms@2.1.3" }),
    [],
  );
});

Deno.test("extractSpecifiersFromSource: import syntax inside a string literal is not an import", () => {
  assertEquals(
    mappedOf(
      `const a = 'value from "config"';
const b = "run: import x from 'ms'";
const c = "import 'uuid'";
const d = "x" + "import(\\"zod2\\")";
log("from", "ms");`,
      {
        config: "npm:config@1.0.0",
        ms: "npm:ms@2.1.3",
        uuid: "npm:uuid@9.0.0",
        zod2: "npm:zod2@1.0.0",
      },
    ),
    [],
  );
});

Deno.test("extractSpecifiersFromSource: a string after an import statement is not an import", () => {
  assertEquals(
    mappedOf(
      `import ms from "ms";
export const label = "uuid";
export default { from: "config" };`,
      {
        config: "npm:config@1.0.0",
        ms: "npm:ms@2.1.3",
        uuid: "npm:uuid@9.0.0",
      },
    ),
    ["npm:ms@2.1.3 <- ms"],
  );
});

Deno.test("extractSpecifiersFromSource: a multi-line import clause and an import attribute resolve", () => {
  assertEquals(
    mappedOf(
      `import {
  a,
  b,
} from "ms";
import data from "uuid" with { type: "json" };`,
      { json: "npm:json@1.0.0", ms: "npm:ms@2.1.3", uuid: "npm:uuid@9.0.0" },
    ),
    ["npm:ms@2.1.3 <- ms", "npm:uuid@9.0.0 <- uuid"],
  );
});

Deno.test("extractSpecifiersFromSource: without a map, bare imports are not audited", () => {
  assertEquals(
    extractSpecifiersFromSource(`import ms from "ms";`, "model.ts"),
    [],
  );
});

Deno.test("extractSpecifiersFromSource: a package written out and mapped keeps the written form", () => {
  assertEquals(
    mappedOf(
      `import ms from "ms";
import ms2 from "npm:ms@2.1.3";`,
      { ms: "npm:ms@2.1.3" },
    ),
    ["npm:ms@2.1.3"],
  );
});

Deno.test("extractSpecifiersFromSource: a mapped and a written version are both audited", () => {
  assertEquals(
    mappedOf(
      `import ms from "ms";
import ms2 from "npm:ms@2.0.0";`,
      { ms: "npm:ms@2.1.3" },
    ),
    ["npm:ms@2.0.0", "npm:ms@2.1.3 <- ms"],
  );
});

Deno.test("resolveBareImport: an unmapped name resolves to nothing", () => {
  assertEquals(resolveBareImport("lodash", { ms: "npm:ms@2.1.3" }), undefined);
});

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_dep_extractor_" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("extractDependencySpecifiers: a written import in one file replaces the mapped one from another", async () => {
  await withTempDir(async (dir) => {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    await Deno.writeTextFile(a, `import ms from "ms";`);
    await Deno.writeTextFile(b, `import ms from "npm:ms@2.1.3";`);
    const specs = await extractDependencySpecifiers(
      [a, b],
      importMapResolver({
        ms: "npm:ms@2.1.3",
      }),
    );
    assertEquals(specs.length, 1);
    assertEquals(specs[0].importedAs, undefined);
    assertEquals(specs[0].sourceFile, b);
  });
});

Deno.test("extractDependencySpecifiers: audits JavaScript code modules too", async () => {
  await withTempDir(async (dir) => {
    const js = join(dir, "helper.js");
    const mjs = join(dir, "helper.mjs");
    await Deno.writeTextFile(js, `import ms from "ms";`);
    await Deno.writeTextFile(mjs, `import a from "npm:axios@1.7.2";`);
    const specs = await extractDependencySpecifiers(
      [js, mjs],
      importMapResolver({
        ms: "npm:ms@2.1.3",
      }),
    );
    assertEquals(
      specs.map((s) => [s.name, s.sourceFile]).sort(),
      [["axios", mjs], ["ms", js]],
    );
  });
});

// ── findImportSpecifiers (swamp-club#3637) ──────────────────────────────

Deno.test("findImportSpecifiers: reports each import with its quoted span", () => {
  const source = "import ms from \"ms\";\nexport { x } from './x.ts';\n";
  assertEquals(findImportSpecifiers(source), [
    {
      specifier: "ms",
      span: {
        start: { line: 0, character: 15 },
        end: { line: 0, character: 19 },
      },
      offset: 15,
    },
    {
      specifier: "./x.ts",
      span: {
        start: { line: 1, character: 18 },
        end: { line: 1, character: 26 },
      },
      offset: 39,
    },
  ]);
});

Deno.test("findImportSpecifiers: counts columns in code points after astral characters and comments", () => {
  const source = '// 🎉 note\n/* 😀 */ import a from "a"; const s = "🎉";\n';
  const [site] = findImportSpecifiers(source);
  assertEquals(site.specifier, "a");
  assertEquals(site.span, {
    start: { line: 1, character: 22 },
    end: { line: 1, character: 25 },
  });
  const line = Array.from(source.split("\n")[1]);
  assertEquals(line.slice(22, 25).join(""), '"a"');
});

Deno.test("findImportSpecifiers: reads side-effect, dynamic, type and multi-line imports", () => {
  const source = [
    'import "side";',
    'const m = await import("lazy");',
    'type T = typeof import("types");',
    "import {",
    "  a,",
    "  b,",
    '} from "multi";',
    'export * from "star";',
  ].join("\n");
  assertEquals(
    findImportSpecifiers(source).map((s) => [s.specifier, s.span.start.line]),
    [["side", 0], ["lazy", 1], ["types", 2], ["multi", 6], ["star", 7]],
  );
});

Deno.test("findImportSpecifiers: ignores import text in comments, strings and template literals", () => {
  const source = [
    '// import a from "a";',
    '/* import b from "b"; */',
    "const s = \"import c from 'c'\";",
    'const t = `import d from "d"`;',
    'import real from "real";',
  ].join("\n");
  assertEquals(findImportSpecifiers(source).map((s) => s.specifier), [
    "real",
  ]);
});

Deno.test("findImportSpecifiers: leaves out an unterminated specifier", () => {
  assertEquals(findImportSpecifiers('import a from "a\nconst x = 1;'), []);
});

Deno.test("extractSpecifiersFromSource: an installed package.json dependency carries its declared range and installed version (swamp-club#3630)", () => {
  const file = "/ext/models/a.ts";
  const specs = extractSpecifiersFromSource(
    'import ms from "ms";\nimport fp from "lodash/fp";\nimport d from "debug";\nimport { z } from "zod";\n',
    file,
    bareImportResolverFrom([
      {
        importer: file,
        specifier: "ms",
        target: "npm:ms@2.1.3",
        declared: "npm:ms@^2.1.0",
      },
      {
        importer: file,
        specifier: "lodash/fp",
        target: "npm:lodash@4.17.21/fp",
        declared: "npm:lodash@4.17.21",
      },
      { importer: file, specifier: "debug", target: "npm:debug@4.3.4" },
      {
        importer: file,
        specifier: "zod",
        target: "npm:zod@4.3.6",
        declared: "npm:zod@^4",
      },
    ]),
  );
  assertEquals(specs, [
    {
      name: "ms",
      version: "^2.1.0",
      registry: "npm",
      installedVersion: "2.1.3",
      sourceFile: file,
      importedAs: "ms",
    },
    {
      name: "lodash",
      version: "4.17.21",
      registry: "npm",
      installedVersion: "4.17.21",
      sourceFile: file,
      importedAs: "lodash/fp",
    },
    {
      name: "debug",
      version: "4.3.4",
      registry: "npm",
      sourceFile: file,
      importedAs: "debug",
    },
  ]);
});

Deno.test("extractSpecifiersFromSource: a declaration naming another package never replaces the one that ships", () => {
  const file = "/ext/models/a.ts";
  const specs = extractSpecifiersFromSource(
    'import p from "pad";\n',
    file,
    bareImportResolverFrom([{
      importer: file,
      specifier: "pad",
      target: "npm:pad@1.3.0",
      declared: "npm:left-pad@^1.3.0",
    }]),
  );
  assertEquals(specs, [{
    name: "pad",
    version: "1.3.0",
    registry: "npm",
    sourceFile: file,
    importedAs: "pad",
  }]);
});
