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

import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../errors.ts";
import type { LocalEdge, SourceModuleGraph } from "./extension_source_graph.ts";
import {
  applySpecifierRewrites,
  bareImportRewrites,
  bareImportShipsAsWritten,
  isReservedArchiveRootName,
  mergeSpecifierRewrites,
  planSourceArchive,
  type SourceArchiveKindInput,
} from "./source_archive_plan.ts";

const REPO = join(Deno.build.os === "windows" ? "C:\\" : "/", "repo");
const EXT = join(REPO, "extensions");
const MODELS = join(EXT, "models");
const p = (...parts: string[]) => join(REPO, ...parts);

function edge(
  importer: string,
  target: string,
  specifier: string,
  line = 0,
): LocalEdge {
  return {
    importer,
    target,
    specifier,
    span: {
      start: { line, character: 20 },
      end: { line, character: 22 + specifier.length },
    },
  };
}

function graph(edges: LocalEdge[]): SourceModuleGraph {
  const paths = new Set(edges.flatMap((e) => [e.importer, e.target]));
  return {
    modules: [...paths].map((path) => ({ path, kind: "code" as const })),
    edges,
    missing: [],
  };
}

function plan(kinds: SourceArchiveKindInput[], edges: LocalEdge[]) {
  return planSourceArchive({
    kinds,
    graph: graph(edges),
    extensionsRoot: EXT,
    allowedRoots: [REPO, EXT],
  });
}

function summary(result: ReturnType<typeof plan>) {
  return result.entries.map((e) => ({
    archivePath: e.archivePath,
    rewrites: e.rewrites.map((r) => `${r.from} -> ${r.to}`),
  }));
}

Deno.test("planSourceArchive: modules inside the kind directory keep their paths, byte for byte", () => {
  const rel = p("extensions", "models", "rel.ts");
  const lib = p("extensions", "models", "_lib", "cmp.ts");
  const result = plan(
    [{ kind: "models", dir: MODELS, modules: [rel, lib] }],
    [edge(rel, lib, "./_lib/cmp.ts")],
  );
  assertEquals(summary(result), [
    { archivePath: "models/_lib/cmp.ts", rewrites: [] },
    { archivePath: "models/rel.ts", rewrites: [] },
  ]);
});

Deno.test("planSourceArchive: a module one level above the kind directory is mirrored at the archive root", () => {
  const rel = p("extensions", "models", "rel.ts");
  const lib = p("extensions", "lib", "cmp.ts");
  const result = plan(
    [{ kind: "models", dir: MODELS, modules: [rel, lib] }],
    [edge(rel, lib, "../lib/cmp.ts")],
  );
  assertEquals(summary(result), [
    { archivePath: "lib/cmp.ts", rewrites: [] },
    { archivePath: "models/rel.ts", rewrites: [] },
  ]);
});

Deno.test("planSourceArchive: paths.base manifest sub-directory importing ../_lib keeps its relative import", () => {
  const dir = p("extensions", "models", "keygen");
  const keygen = join(dir, "keygen.ts");
  const schemas = p("extensions", "models", "_lib", "schemas.ts");
  const result = plan(
    [{ kind: "models", dir, modules: [keygen, schemas] }],
    [edge(keygen, schemas, "../_lib/schemas.ts")],
  );
  assertEquals(summary(result), [
    { archivePath: "_lib/schemas.ts", rewrites: [] },
    { archivePath: "models/keygen.ts", rewrites: [] },
  ]);
});

Deno.test("planSourceArchive: a module further away goes under _shared and its importer is rewritten", () => {
  const dir = p("extensions", "models", "keygen");
  const keygen = join(dir, "keygen.ts");
  const shared = p("shared", "util.ts");
  const result = plan(
    [{ kind: "models", dir, modules: [keygen, shared] }],
    [edge(keygen, shared, "../../../shared/util.ts")],
  );
  assertEquals(summary(result), [
    { archivePath: "_shared/_up/shared/util.ts", rewrites: [] },
    {
      archivePath: "models/keygen.ts",
      rewrites: ["../../../shared/util.ts -> ../_shared/_up/shared/util.ts"],
    },
  ]);
});

Deno.test("planSourceArchive: a module one level up under a reserved name goes under _shared", () => {
  const rel = p("extensions", "models", "rel.ts");
  const helper = p("extensions", "bundles", "helper.ts");
  const result = plan(
    [{ kind: "models", dir: MODELS, modules: [rel, helper] }],
    [edge(rel, helper, "../bundles/helper.ts")],
  );
  assertEquals(summary(result), [
    { archivePath: "_shared/bundles/helper.ts", rewrites: [] },
    {
      archivePath: "models/rel.ts",
      rewrites: ["../bundles/helper.ts -> ../_shared/bundles/helper.ts"],
    },
  ]);
});

Deno.test("planSourceArchive: a module one level up under a legacy driver directory goes under _shared", () => {
  const rel = p("extensions", "models", "rel.ts");
  const driver = p("extensions", "drivers", "util.ts");
  const result = plan(
    [{ kind: "models", dir: MODELS, modules: [rel, driver] }],
    [edge(rel, driver, "../drivers/util.ts")],
  );
  assertEquals(summary(result), [
    { archivePath: "_shared/drivers/util.ts", rewrites: [] },
    {
      archivePath: "models/rel.ts",
      rewrites: ["../drivers/util.ts -> ../_shared/drivers/util.ts"],
    },
  ]);
});

Deno.test("isReservedArchiveRootName: names push writes or ignores itself are reserved", () => {
  for (
    const name of [
      "manifest.yaml",
      "quality.yaml",
      "models",
      "bundles",
      "workflows",
      "vaults",
      "vault-bundles",
      "datastores",
      "datastore-bundles",
      "reports",
      "report-bundles",
      "webhooks",
      "webhook-bundles",
      "skills",
      "files",
      "drivers",
      "driver-bundles",
      "_shared",
    ]
  ) {
    assertEquals(isReservedArchiveRootName(name), true, name);
  }
  for (const name of ["lib", "_lib", "helpers.ts", "Models", "shared"]) {
    assertEquals(isReservedArchiveRootName(name), false, name);
  }
});

Deno.test("planSourceArchive: imports between shared modules are rewritten when they no longer line up", () => {
  const dir = p("extensions", "models", "keygen");
  const keygen = join(dir, "keygen.ts");
  const a = p("extensions", "lib", "a.ts");
  const b = p("shared", "b.ts");
  const result = plan(
    [{ kind: "models", dir, modules: [keygen, a, b] }],
    [
      edge(keygen, a, "../../lib/a.ts"),
      edge(a, b, "../../shared/b.ts"),
    ],
  );
  assertEquals(summary(result), [
    {
      archivePath: "_shared/_up/shared/b.ts",
      rewrites: [],
    },
    {
      archivePath: "_shared/lib/a.ts",
      rewrites: ["../../shared/b.ts -> ../_up/shared/b.ts"],
    },
    {
      archivePath: "models/keygen.ts",
      rewrites: ["../../lib/a.ts -> ../_shared/lib/a.ts"],
    },
  ]);
});

Deno.test("planSourceArchive: a non-relative specifier to a local module is rewritten to a relative one", () => {
  const rel = p("extensions", "models", "rel.ts");
  const lib = p("extensions", "models", "_lib", "cmp.ts");
  const result = plan(
    [{ kind: "models", dir: MODELS, modules: [rel, lib] }],
    [edge(rel, lib, "@lib/cmp.ts")],
  );
  assertEquals(summary(result)[1], {
    archivePath: "models/rel.ts",
    rewrites: ["@lib/cmp.ts -> ./_lib/cmp.ts"],
  });
});

Deno.test("planSourceArchive: a module two kinds import from one level up is placed once", () => {
  const model = p("extensions", "models", "m.ts");
  const vault = p("extensions", "vaults", "v.ts");
  const lib = p("extensions", "lib", "x.ts");
  const result = plan(
    [
      { kind: "models", dir: MODELS, modules: [model, lib] },
      {
        kind: "vaults",
        dir: p("extensions", "vaults"),
        modules: [vault, lib],
      },
    ],
    [edge(model, lib, "../lib/x.ts"), edge(vault, lib, "../lib/x.ts")],
  );
  assertEquals(summary(result), [
    { archivePath: "lib/x.ts", rewrites: [] },
    { archivePath: "models/m.ts", rewrites: [] },
    { archivePath: "vaults/v.ts", rewrites: [] },
  ]);
});

Deno.test("planSourceArchive: a module inside another kind's directory uses that kind's copy", () => {
  const model = p("extensions", "models", "m.ts");
  const lib = p("extensions", "models", "_lib", "run_data.ts");
  const report = p("extensions", "reports", "r.ts");
  const result = plan(
    [
      { kind: "models", dir: MODELS, modules: [model, lib] },
      {
        kind: "reports",
        dir: p("extensions", "reports"),
        modules: [report, lib],
      },
    ],
    [
      edge(model, lib, "./_lib/run_data.ts"),
      edge(report, lib, "../models/_lib/run_data.ts"),
    ],
  );
  assertEquals(summary(result), [
    { archivePath: "models/_lib/run_data.ts", rewrites: [] },
    { archivePath: "models/m.ts", rewrites: [] },
    { archivePath: "reports/r.ts", rewrites: [] },
  ]);
});

Deno.test("planSourceArchive: a module outside the repository and extensions root is an error", () => {
  const rel = p("extensions", "models", "rel.ts");
  const outside = join(REPO, "..", "elsewhere", "x.ts");
  const error = assertThrows(
    () =>
      plan(
        [{ kind: "models", dir: MODELS, modules: [rel, outside] }],
        [edge(rel, outside, "../../../elsewhere/x.ts")],
      ),
    UserError,
  );
  assertEquals(error.message.includes("outside the repository"), true);
  assertEquals(error.message.includes(rel), true);
});

Deno.test("planSourceArchive: two files planned to one archive path is an error naming both", () => {
  const m1 = p("extensions", "models", "m.ts");
  const lib1 = p("extensions", "lib", "x.ts");
  const vdir = p("alt", "vaults");
  const v = join(vdir, "v.ts");
  const lib2 = p("alt", "lib", "x.ts");
  const error = assertThrows(
    () =>
      plan(
        [
          { kind: "models", dir: MODELS, modules: [m1, lib1] },
          { kind: "vaults", dir: vdir, modules: [v, lib2] },
        ],
        [edge(m1, lib1, "../lib/x.ts"), edge(v, lib2, "../lib/x.ts")],
      ),
    UserError,
  );
  assertEquals(error.message.includes(lib1), true);
  assertEquals(error.message.includes(lib2), true);
  assertEquals(error.message.includes("lib/x.ts"), true);
});

Deno.test("applySpecifierRewrites: replaces only the quoted specifier and keeps the line count", () => {
  const text = 'const s = "é😀"; import { c } from "../../lib/cmp.ts";\n' +
    "export { s, c };\n";
  const out = applySpecifierRewrites(text, [{
    span: {
      start: { line: 0, character: 34 },
      end: { line: 0, character: 52 },
    },
    from: "../../lib/cmp.ts",
    to: "../_shared/lib/cmp.ts",
  }]);
  assertEquals(
    out,
    'const s = "é😀"; import { c } from "../_shared/lib/cmp.ts";\n' +
      "export { s, c };\n",
  );
});

Deno.test("applySpecifierRewrites: applies several rewrites on one line from the right", () => {
  const text = `import "./a.ts"; import "./b.ts";`;
  const out = applySpecifierRewrites(text, [
    {
      span: {
        start: { line: 0, character: 7 },
        end: { line: 0, character: 15 },
      },
      from: "./a.ts",
      to: "../x/a.ts",
    },
    {
      span: {
        start: { line: 0, character: 24 },
        end: { line: 0, character: 32 },
      },
      from: "./b.ts",
      to: "../x/b.ts",
    },
  ]);
  assertEquals(out, `import "../x/a.ts"; import "../x/b.ts";`);
});

Deno.test("applySpecifierRewrites: refuses a span that does not cover the specifier", () => {
  assertThrows(
    () =>
      applySpecifierRewrites(`import "./a.ts";`, [{
        span: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 6 },
        },
        from: "./a.ts",
        to: "./b.ts",
      }]),
    Error,
    "does not cover",
  );
});

// ── Bare-import rewrites (swamp-club#3637) ──────────────────────────────

const IMPORTS = {
  "ms": "npm:ms@^2",
  "@std/path": "jsr:@std/path@^1",
  "lodash/": "npm:/lodash@4/",
  "fs": "node:fs",
  "remote": "https://example.com/mod.ts",
  "@/": "./src/",
  "data": "data:text/javascript,export default 1",
};

function rewritten(
  source: string,
  imports: Record<string, string> = IMPORTS,
): string {
  return applySpecifierRewrites(
    source,
    bareImportRewrites(source, imports, "/repo/m.ts"),
  );
}

Deno.test("bareImportRewrites: writes the import-map target in place of each bare import", () => {
  assertEquals(
    rewritten(
      'import ms from "ms";\nimport { posix } from "@std/path/posix";\n',
    ),
    'import ms from "npm:ms@^2";\nimport { posix } from "jsr:@std/path@^1/posix";\n',
  );
});

Deno.test("bareImportRewrites: writes a trailing-slash npm: target without its leading slash", () => {
  assertEquals(
    rewritten("import fp from 'lodash/fp';"),
    "import fp from 'npm:lodash@4/fp';",
  );
});

Deno.test("bareImportRewrites: rewrites node: and URL targets", () => {
  assertEquals(
    rewritten('import fs from "fs";\nimport r from "remote";'),
    'import fs from "node:fs";\nimport r from "https://example.com/mod.ts";',
  );
});

Deno.test("bareImportRewrites: leaves local, unmapped and other targets as written", () => {
  const source = 'import a from "@/a.ts";\nimport u from "unmapped";\n' +
    'import d from "data";\nimport r from "./rel.ts";\n';
  assertEquals(bareImportRewrites(source, IMPORTS, "/repo/m.ts"), []);
});

Deno.test("bareImportRewrites: rewrites dynamic and side-effect imports, not import text in strings", () => {
  assertEquals(
    rewritten(
      'import "ms";\nconst m = await import("ms");\nconst t = `import x from "ms"`;',
    ),
    'import "npm:ms@^2";\nconst m = await import("npm:ms@^2");\nconst t = `import x from "ms"`;',
  );
});

Deno.test("bareImportRewrites: keeps a version range with spaces", () => {
  assertEquals(
    rewritten('import a from "a";', { a: "npm:a@>=1 <2" }),
    'import a from "npm:a@>=1 <2";',
  );
});

Deno.test("bareImportRewrites: refuses a target that would end or escape its string literal", () => {
  for (
    const target of [
      'npm:a@1"; globalThis.x = 1; "',
      "npm:a@1'",
      "npm:a@1`",
      "npm:a@1\\",
      "npm:a@1\nx",
      "npm:a@1\u2028",
      "https://x.test/${y}",
    ]
  ) {
    assertThrows(
      () => bareImportRewrites('import a from "a";', { a: target }, "/m.ts"),
      UserError,
      'Fix the import map entry for "a"',
    );
  }
});

Deno.test("bareImportRewrites: ignores an unsafe target the source never imports", () => {
  assertEquals(
    bareImportRewrites('import ms from "ms";', {
      ms: "npm:ms@2",
      unused: 'npm:x"',
    }, "/m.ts").map((r) => r.to),
    ["npm:ms@2"],
  );
});

Deno.test("bareImportRewrites: never rewrites specifier text holding whitespace, a semicolon or parentheses", () => {
  const source = 'const re = /import "a/;const s = "x";\nimport ms from "ms";';
  assertEquals(
    bareImportRewrites(source, {
      ms: "npm:ms@2",
      "a/;const s = ": "npm:x/;globalThis.pwned = 1;const s = ",
    }, "/m.ts").map((r) => r.to),
    ["npm:ms@2"],
  );
});

Deno.test("mergeSpecifierRewrites: keeps the plan's rewrite at a shared span and sorts by position", () => {
  const span = (line: number, character: number) => ({
    start: { line, character },
    end: { line, character: character + 4 },
  });
  const merged = mergeSpecifierRewrites(
    [{ span: span(2, 5), from: "@/a", to: "./a.ts" }],
    [
      { span: span(2, 5), from: "@/a", to: "npm:a" },
      { span: span(0, 1), from: "ms", to: "npm:ms@2" },
    ],
  );
  assertEquals(merged.map((r) => r.to), ["npm:ms@2", "./a.ts"]);
});

Deno.test("bareImportShipsAsWritten: only imports the map neither rewrites nor resolves locally", () => {
  assertEquals(bareImportShipsAsWritten("ms", IMPORTS), false);
  assertEquals(bareImportShipsAsWritten("lodash/fp", IMPORTS), false);
  assertEquals(bareImportShipsAsWritten("@/a.ts", IMPORTS), false);
  assertEquals(bareImportShipsAsWritten("unmapped", IMPORTS), true);
  assertEquals(bareImportShipsAsWritten("data", IMPORTS), true);
  assertEquals(bareImportShipsAsWritten("ms", undefined), true);
});
