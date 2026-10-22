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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, relative, toFileUrl } from "@std/path";
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { UserError } from "../../domain/errors.ts";
import {
  DenoInfoModuleGraphReader,
  parseDenoInfoGraph,
} from "./deno_info_module_graph_reader.ts";

const ROOT = Deno.build.os === "windows" ? "C:\\ext" : "/ext";
const url = (...parts: string[]) => toFileUrl(join(ROOT, ...parts)).href;
const path = (...parts: string[]) => join(ROOT, ...parts);
const allFiles = {
  exists: () => Promise.resolve(true),
  readText: () => Promise.resolve(undefined),
};
const span = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});

Deno.test("parseDenoInfoGraph: keeps local code and data modules and their edges, drops remote ones", async () => {
  const graph = await parseDenoInfoGraph(
    {
      modules: [
        {
          kind: "esm",
          mediaType: "TypeScript",
          specifier: url("models", "m.ts"),
          dependencies: [
            {
              specifier: "../lib/x.ts",
              code: { specifier: url("lib", "x.ts"), span: span(0, 18, 31) },
            },
            {
              specifier: "./d.json",
              code: {
                specifier: url("models", "d.json"),
                span: span(1, 14, 24),
              },
            },
            {
              specifier: "npm:zod@4",
              code: { specifier: "npm:/zod@4", span: span(2, 18, 29) },
            },
          ],
        },
        { kind: "esm", mediaType: "TypeScript", specifier: url("lib", "x.ts") },
        {
          kind: "asserted",
          mediaType: "Json",
          specifier: url("models", "d.json"),
        },
        { kind: "npm", specifier: "npm:/zod@4" },
      ],
    },
    allFiles,
  );
  assertEquals(graph.modules, [
    { path: path("models", "m.ts"), kind: "code" },
    { path: path("lib", "x.ts"), kind: "code" },
    { path: path("models", "d.json"), kind: "data" },
  ]);
  assertEquals(graph.edges.map((e) => [e.target, e.specifier]), [
    [path("lib", "x.ts"), "../lib/x.ts"],
    [path("models", "d.json"), "./d.json"],
  ]);
  assertEquals(graph.missing, []);
});

Deno.test("parseDenoInfoGraph: a module deno cannot load is missing, naming its importer", async () => {
  const graph = await parseDenoInfoGraph(
    {
      modules: [
        {
          kind: "esm",
          mediaType: "TypeScript",
          specifier: url("models", "m.ts"),
          dependencies: [{
            specifier: "./gone.ts",
            code: { specifier: url("models", "gone.ts"), span: span(0, 7, 18) },
          }],
        },
        { specifier: url("models", "gone.ts"), error: "Module not found" },
      ],
    },
    allFiles,
  );
  assertEquals(graph.missing, [{
    path: path("models", "gone.ts"),
    importer: path("models", "m.ts"),
    reason: "Module not found",
  }]);
});

Deno.test("parseDenoInfoGraph: a text import deno reports as external is data when it exists and missing when not", async () => {
  const graph = await parseDenoInfoGraph(
    {
      modules: [
        { kind: "external", mediaType: null, specifier: url("t.txt") },
        { kind: "external", mediaType: null, specifier: url("gone.txt") },
      ],
    },
    {
      exists: (p) => Promise.resolve(p === path("t.txt")),
      readText: () => Promise.resolve(undefined),
    },
  );
  assertEquals(graph.modules, [{ path: path("t.txt"), kind: "data" }]);
  assertEquals(graph.missing.map((m) => m.path), [path("gone.txt")]);
});

Deno.test("parseDenoInfoGraph: a type import is an edge like a code import", async () => {
  const graph = await parseDenoInfoGraph(
    {
      modules: [
        {
          kind: "esm",
          mediaType: "TypeScript",
          specifier: url("m.ts"),
          dependencies: [{
            specifier: "./types.ts",
            type: { specifier: url("types.ts"), span: span(0, 22, 34) },
          }],
        },
        { kind: "esm", mediaType: "TypeScript", specifier: url("types.ts") },
      ],
    },
    allFiles,
  );
  assertEquals(graph.edges.map((e) => e.target), [path("types.ts")]);
});

Deno.test("DenoInfoModuleGraphReader: reads side-effect, JSON and dynamic imports from a real graph", async () => {
  const dir = await Deno.makeTempDir({ prefix: "graph-reader-" });
  try {
    await Deno.mkdir(join(dir, "models"));
    await Deno.mkdir(join(dir, "lib"));
    await Deno.writeTextFile(join(dir, "lib", "side.ts"), "export {};\n");
    await Deno.writeTextFile(join(dir, "models", "d.json"), "{}\n");
    await Deno.writeTextFile(join(dir, "models", "lazy.ts"), "export {};\n");
    await Deno.writeTextFile(
      join(dir, "models", "m.ts"),
      'import "../lib/side.ts";\n' +
        'import d from "./d.json" with { type: "json" };\n' +
        'export const m = { d, l: () => import("./lazy.ts") };\n',
    );
    const graph = await new DenoInfoModuleGraphReader(Deno.execPath()).read(
      join(dir, "models", "m.ts"),
      {},
    );
    assertEquals(
      graph.modules.map((m) => [relative(dir, m.path), m.kind]).sort(),
      [
        [join("lib", "side.ts"), "code"],
        [join("models", "d.json"), "data"],
        [join("models", "lazy.ts"), "code"],
        [join("models", "m.ts"), "code"],
      ],
    );
    assertEquals(graph.missing, []);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

Deno.test("DenoInfoModuleGraphReader: a failing deno info is a UserError naming the entry point", async () => {
  const dir = await Deno.makeTempDir({ prefix: "graph-reader-" });
  try {
    const entry = join(dir, "m.ts");
    await Deno.writeTextFile(entry, "export {};\n");
    await assertRejects(
      () =>
        new DenoInfoModuleGraphReader(Deno.execPath()).read(entry, {
          denoConfigPath: join(dir, "missing-deno.json"),
        }),
      UserError,
      `Could not read the module graph of ${entry}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

Deno.test("DenoInfoModuleGraphReader: passes the entry point to deno info as a file URL", async () => {
  const entry = path("models", "m.ts");
  const { result: graph, calls } = await withMockedCommand(
    () => ({
      stdout: JSON.stringify({
        modules: [{
          kind: "esm",
          mediaType: "TypeScript",
          specifier: url("models", "m.ts"),
        }],
      }),
      code: 0,
    }),
    () => new DenoInfoModuleGraphReader("deno").read(entry, {}),
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args.at(-1), toFileUrl(entry).href);
  assertEquals(graph.modules, [{ path: entry, kind: "code" }]);
});

Deno.test("DenoInfoModuleGraphReader: a graph with no local module is a UserError naming the entry point", async () => {
  const entry = path("models", "m.ts");
  // What deno info printed on Windows for a C:\ path it read as a URL with
  // the scheme c: — one external, non-file root and exit 0.
  await withMockedCommand(
    () => ({
      stdout: JSON.stringify({
        roots: ["c:\\ext\\models\\m.ts"],
        modules: [{ kind: "external", specifier: "c:\\ext\\models\\m.ts" }],
      }),
      code: 0,
    }),
    () =>
      assertRejects(
        () => new DenoInfoModuleGraphReader("deno").read(entry, {}),
        UserError,
        `deno info listed no local module for ${entry}`,
      ),
  );
});

Deno.test("DenoInfoModuleGraphReader: a @ts-types edge carries the pragma's specifier, not the import's", async () => {
  const dir = await Deno.makeTempDir({ prefix: "graph-reader-" });
  try {
    await Deno.writeTextFile(join(dir, "foo.js"), "export const f = 1;\n");
    await Deno.writeTextFile(
      join(dir, "foo.d.ts"),
      "export declare const f: number;\n",
    );
    await Deno.writeTextFile(
      join(dir, "m.ts"),
      '// @ts-types="./foo.d.ts"\nimport { f } from "./foo.js";\nexport { f };\n',
    );
    const graph = await new DenoInfoModuleGraphReader(Deno.execPath()).read(
      join(dir, "m.ts"),
      {},
    );
    assertEquals(
      graph.edges.map((e) => [relative(dir, e.target), e.specifier]).sort(),
      [["foo.d.ts", "./foo.d.ts"], ["foo.js", "./foo.js"]],
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

Deno.test("DenoInfoModuleGraphReader: an npm package in a manual node_modules directory is not a local module", async () => {
  const dir = await Deno.makeTempDir({ prefix: "graph-reader-" });
  try {
    const pkg = join(dir, "node_modules", "foo");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(
      join(pkg, "package.json"),
      '{"name":"foo","version":"1.0.0","main":"index.js","type":"module"}\n',
    );
    await Deno.writeTextFile(join(pkg, "index.js"), "export const g = 2;\n");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      '{"nodeModulesDir":"manual"}\n',
    );
    await Deno.writeTextFile(
      join(dir, "package.json"),
      '{"dependencies":{"foo":"1.0.0"}}\n',
    );
    await Deno.writeTextFile(
      join(dir, "m.ts"),
      'import { g } from "foo";\nexport { g };\n',
    );
    const graph = await new DenoInfoModuleGraphReader(Deno.execPath()).read(
      join(dir, "m.ts"),
      { denoConfigPath: join(dir, "deno.json") },
    );
    assertEquals(graph.modules.map((m) => relative(dir, m.path)), ["m.ts"]);
    assertEquals(graph.edges, []);
    assertEquals(graph.missing, []);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

/** Every path under `dir` with its bytes and mtime, to show nothing changed. */
async function treeSnapshot(dir: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (path: string) => {
    for await (const entry of Deno.readDir(path)) {
      const child = join(path, entry.name);
      const stat = await Deno.lstat(child);
      entries.push(
        `${relative(dir, child)} ${stat.mtime?.getTime()} ${
          entry.isFile ? await Deno.readTextFile(child) : ""
        }`,
      );
      if (entry.isDirectory) await visit(child);
    }
  };
  await visit(dir);
  return entries.sort();
}

Deno.test("DenoInfoModuleGraphReader: a package.json project resolves bare imports to the installed packages and leaves node_modules unchanged (swamp-club#3630)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "graph-reader-pkg-" });
  try {
    const pkg = join(dir, "node_modules", "foo");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(
      join(pkg, "package.json"),
      '{"name":"foo","version":"1.2.0","main":"index.js","type":"module"}\n',
    );
    await Deno.writeTextFile(join(pkg, "index.js"), "export const g = 2;\n");
    await Deno.writeTextFile(
      join(dir, "package.json"),
      '{"dependencies":{"foo":"^1.0.0","bar":"^2.0.0"}}\n',
    );
    await Deno.writeTextFile(
      join(dir, "m.ts"),
      'import { g } from "foo";\nimport b from "bar";\nexport { b, g };\n',
    );
    const before = await treeSnapshot(join(dir, "node_modules"));
    const graph = await new DenoInfoModuleGraphReader(
      Deno.execPath(),
      undefined,
      { readOnlyLock: true },
    ).read(join(dir, "m.ts"), { packageJsonDir: dir });
    assertEquals(await treeSnapshot(join(dir, "node_modules")), before);
    assertEquals(
      graph.bareImports?.map((b) => [b.specifier, b.target, b.declared]),
      [["foo", "npm:foo@1.2.0", "npm:foo@^1.0.0"], [
        "bar",
        undefined,
        undefined,
      ]],
    );
    assertEquals(graph.staleInstalls, [{
      importer: join(dir, "m.ts"),
      specifier: "bar",
      packageName: "bar",
      declaredRange: "^2.0.0",
    }]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

// Deno itself refuses TypeScript under node_modules once a project config
// or package.json is in play (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
// so the no-project case is the one swamp alone could break.
Deno.test("DenoInfoModuleGraphReader: a repository checked out under a directory named node_modules keeps its local modules", async () => {
  const outer = await Deno.makeTempDir({ prefix: "graph-reader-ancestor-" });
  try {
    const dir = join(outer, "node_modules", "repo");
    await Deno.mkdir(join(dir, "lib"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "lib", "two.ts"),
      "export const t = 2;\n",
    );
    await Deno.writeTextFile(
      join(dir, "m.ts"),
      'import { t } from "./lib/two.ts";\nexport { t };\n',
    );
    const graph = await new DenoInfoModuleGraphReader(
      Deno.execPath(),
      undefined,
      { readOnlyLock: true },
    ).read(join(dir, "m.ts"), {});
    assertEquals(
      graph.modules.map((m) => relative(dir, m.path)).sort(),
      [join("lib", "two.ts"), "m.ts"],
    );
    assertEquals(graph.edges.map((e) => relative(dir, e.target)), [
      join("lib", "two.ts"),
    ]);
    assertEquals(graph.missing, []);
  } finally {
    await Deno.remove(outer, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

Deno.test("DenoInfoModuleGraphReader: a package.json project whose package.json does not parse fails the read, rather than checking nothing it declares (swamp-club#3630)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "graph-reader-pkg-bad-" });
  try {
    await Deno.mkdir(join(dir, "node_modules"));
    await Deno.writeTextFile(join(dir, "package.json"), "{ not json");
    await Deno.writeTextFile(join(dir, "m.ts"), "export const m = 1;\n");
    await withMockedCommand(
      () => ({
        stdout: JSON.stringify({
          modules: [{
            kind: "esm",
            mediaType: "TypeScript",
            specifier: toFileUrl(join(dir, "m.ts")).href,
          }],
        }),
        code: 0,
      }),
      async () => {
        const error = await assertRejects(
          () =>
            new DenoInfoModuleGraphReader("deno").read(join(dir, "m.ts"), {
              packageJsonDir: dir,
            }),
          UserError,
        );
        assertStringIncludes(
          error.message,
          `Could not read ${join(dir, "package.json")}`,
        );
      },
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

const STALE_LOCK_STDERR = "error: Prepare module load error\n\nCaused by:\n" +
  "    The lockfile is out of date. Run `deno install --frozen=false`, or " +
  "rerun with `--frozen=false` to update it.\n    changes:\n" +
  '     4 | -    "npm:ms@2": "2.1.3"\n';

async function withLockedProject(
  fn: (dir: string, entry: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "graph-reader-lock-" });
  try {
    const entry = join(dir, "m.ts");
    await Deno.writeTextFile(entry, "export {};\n");
    await Deno.writeTextFile(join(dir, "deno.json"), "{}");
    await Deno.writeTextFile(join(dir, "deno.lock"), '{"version":"5"}');
    await fn(dir, entry);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

Deno.test("DenoInfoModuleGraphReader: readOnlyLock reads with --frozen and reports a stale lock", async () => {
  await withLockedProject(async (dir, entry) => {
    const { calls } = await withMockedCommand(
      [{ stdout: "", stderr: STALE_LOCK_STDERR, code: 1 }],
      async () => {
        await assertRejects(
          () =>
            new DenoInfoModuleGraphReader("deno", undefined, {
              readOnlyLock: true,
            }).read(entry, { denoConfigPath: join(dir, "deno.json") }),
          UserError,
          `${join(dir, "deno.lock")} is out of date`,
        );
      },
    );
    assertEquals(calls[0].args.includes("--frozen"), true);
  });
});

Deno.test("DenoInfoModuleGraphReader: readOnlyLock reads a project without a lock with --no-lock", async () => {
  await withLockedProject(async (dir, entry) => {
    await Deno.remove(join(dir, "deno.lock"));
    const { calls } = await withMockedCommand(
      () => ({
        stdout: JSON.stringify({
          modules: [{
            kind: "esm",
            mediaType: "TypeScript",
            specifier: toFileUrl(entry).href,
          }],
        }),
        code: 0,
      }),
      () =>
        new DenoInfoModuleGraphReader("deno", undefined, {
          readOnlyLock: true,
        }).read(entry, { denoConfigPath: join(dir, "deno.json") }),
    );
    assertEquals(calls[0].args.includes("--no-lock"), true);
    assertEquals(calls[0].args.includes("--frozen"), false);
  });
});

Deno.test("DenoInfoModuleGraphReader: without readOnlyLock the lock flags are Deno's defaults", async () => {
  await withLockedProject(async (dir, entry) => {
    const { calls } = await withMockedCommand(
      [{ stdout: "", stderr: STALE_LOCK_STDERR, code: 1 }],
      async () => {
        await assertRejects(
          () =>
            new DenoInfoModuleGraphReader("deno").read(entry, {
              denoConfigPath: join(dir, "deno.json"),
            }),
          UserError,
          `Could not read the module graph of ${entry}`,
        );
      },
    );
    assertEquals(calls[0].args.includes("--frozen"), false);
    assertEquals(calls[0].args.includes("--no-lock"), false);
  });
});

/** Writes `files` under a fresh temp dir and runs `fn` on it. */
async function withProject(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "graph-reader-" });
  try {
    for (const [rel, text] of Object.entries(files)) {
      await Deno.mkdir(join(dir, rel, ".."), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), text);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

/** Each bare import as `[importer relative to dir, specifier, target]`. */
function bareImportsOf(
  dir: string,
  graph: {
    bareImports?: { importer: string; specifier: string; target?: string }[];
  },
): Array<[string, string, string | undefined]> {
  return (graph.bareImports ?? []).map((b): [
    string,
    string,
    string | undefined,
  ] => [relative(dir, b.importer), b.specifier, b.target]).sort();
}

// node: targets resolve without network access, so these read real graphs.

Deno.test("DenoInfoModuleGraphReader: a bare import resolves through the scope covering its importer (swamp-club#3612)", async () => {
  await withProject({
    "deno.json": JSON.stringify({
      imports: { "fs": "node:fs", "path": "node:path" },
      scopes: { "./extensions/": { "fs": "node:os" } },
    }),
    "extensions/models/m.ts":
      'import fs from "fs";\nimport path from "path";\nimport { l } from "../../lib/l.ts";\nexport const m = [fs, path, l];\n',
    "lib/l.ts": 'import fs from "fs";\nexport const l = fs;\n',
  }, async (dir) => {
    const graph = await new DenoInfoModuleGraphReader(Deno.execPath()).read(
      join(dir, "extensions", "models", "m.ts"),
      { denoConfigPath: join(dir, "deno.json") },
    );
    assertEquals(bareImportsOf(dir, graph), [
      [join("extensions", "models", "m.ts"), "fs", "node:os"],
      [join("extensions", "models", "m.ts"), "path", "node:path"],
      [join("lib", "l.ts"), "fs", "node:fs"],
    ]);
  });
});

Deno.test("DenoInfoModuleGraphReader: a deno.jsonc and the importMap file it references resolve bare imports (swamp-club#3612)", async () => {
  await withProject({
    "deno.jsonc":
      '// project config\n{ "importMap": "./maps/import_map.json", }\n',
    "maps/import_map.json": JSON.stringify({ imports: { "fs": "node:fs" } }),
    "models/m.ts": 'import fs from "fs";\nexport const m = fs;\n',
  }, async (dir) => {
    const graph = await new DenoInfoModuleGraphReader(Deno.execPath()).read(
      join(dir, "models", "m.ts"),
      { denoConfigPath: join(dir, "deno.jsonc") },
    );
    assertEquals(bareImportsOf(dir, graph), [
      [join("models", "m.ts"), "fs", "node:fs"],
    ]);
  });
});

Deno.test("DenoInfoModuleGraphReader: a workspace member inherits the root's imports (swamp-club#3612)", async () => {
  await withProject({
    "deno.json": JSON.stringify({
      workspace: ["./member"],
      imports: { "fs": "node:fs" },
    }),
    "member/deno.json": JSON.stringify({ imports: { "path": "node:path" } }),
    "member/models/m.ts":
      'import fs from "fs";\nimport path from "path";\nexport const m = [fs, path];\n',
  }, async (dir) => {
    const graph = await new DenoInfoModuleGraphReader(Deno.execPath()).read(
      join(dir, "member", "models", "m.ts"),
      { denoConfigPath: join(dir, "member", "deno.json") },
    );
    assertEquals(bareImportsOf(dir, graph), [
      [join("member", "models", "m.ts"), "fs", "node:fs"],
      [join("member", "models", "m.ts"), "path", "node:path"],
    ]);
  });
});

Deno.test("DenoInfoModuleGraphReader: a bare import nothing maps is unresolved", async () => {
  await withProject({
    "deno.json": JSON.stringify({ imports: { "fs": "node:fs" } }),
    "models/m.ts":
      'import fs from "fs";\nimport x from "unmapped";\nexport const m = [fs, x];\n',
  }, async (dir) => {
    const graph = await new DenoInfoModuleGraphReader(Deno.execPath()).read(
      join(dir, "models", "m.ts"),
      { denoConfigPath: join(dir, "deno.json") },
    );
    assertEquals(bareImportsOf(dir, graph), [
      [join("models", "m.ts"), "fs", "node:fs"],
      [join("models", "m.ts"), "unmapped", undefined],
    ]);
  });
});

Deno.test("DenoInfoModuleGraphReader: a remote importMap is refused as Deno refuses it, never resolved another way", async () => {
  await withProject({
    "deno.json": JSON.stringify({
      importMap: "https://example.invalid/import_map.json",
    }),
    "models/m.ts": 'import fs from "fs";\nexport const m = fs;\n',
  }, async (dir) => {
    await assertRejects(
      () =>
        new DenoInfoModuleGraphReader(Deno.execPath()).read(
          join(dir, "models", "m.ts"),
          { denoConfigPath: join(dir, "deno.json") },
        ),
      UserError,
      "Only file: specifiers are supported",
    );
  });
});

/** deno info output for one local module whose bare `zod` resolves as given. */
function zodInfo(code: Record<string, string>) {
  return JSON.stringify({
    modules: [{
      kind: "esm",
      mediaType: "TypeScript",
      specifier: url("models", "m.ts"),
      dependencies: [{ specifier: "zod", code }],
    }],
  });
}

Deno.test("DenoInfoModuleGraphReader: an import unresolved under a manual node_modules is read again with --node-modules-dir=none (swamp-club#3612)", async () => {
  const entry = path("models", "m.ts");
  const { result: graph, calls } = await withMockedCommand(
    [
      {
        stdout: zodInfo({
          error: 'Could not find "zod" in a node_modules folder.',
        }),
        code: 0,
      },
      { stdout: zodInfo({ specifier: "npm:zod@4" }), code: 0 },
    ],
    () =>
      new DenoInfoModuleGraphReader("deno").read(entry, {
        denoConfigPath: path("deno.json"),
      }),
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].args.includes("--node-modules-dir=none"), false);
  assertEquals(calls[1].args.includes("--node-modules-dir=none"), true);
  assertEquals(calls[1].args.includes(path("deno.json")), true);
  assertEquals(graph.bareImports, [
    { importer: entry, specifier: "zod", target: "npm:zod@4" },
  ]);
});

Deno.test("DenoInfoModuleGraphReader: a second read that fails leaves the import unresolved", async () => {
  const entry = path("models", "m.ts");
  const { result: graph } = await withMockedCommand(
    [
      { stdout: zodInfo({ error: "not found" }), code: 0 },
      { stdout: "", stderr: "boom", code: 1 },
    ],
    () =>
      new DenoInfoModuleGraphReader("deno").read(entry, {
        denoConfigPath: path("deno.json"),
      }),
  );
  assertEquals(graph.bareImports, [{ importer: entry, specifier: "zod" }]);
});

Deno.test("DenoInfoModuleGraphReader: no second read when every bare import resolves, or without a Deno config", async () => {
  const entry = path("models", "m.ts");
  const resolved = await withMockedCommand(
    () => ({ stdout: zodInfo({ specifier: "npm:zod@4" }), code: 0 }),
    () =>
      new DenoInfoModuleGraphReader("deno").read(entry, {
        denoConfigPath: path("deno.json"),
      }),
  );
  assertEquals(resolved.calls.length, 1);
  const noConfig = await withMockedCommand(
    () => ({ stdout: zodInfo({ error: "not found" }), code: 0 }),
    () => new DenoInfoModuleGraphReader("deno").read(entry, {}),
  );
  assertEquals(noConfig.calls.length, 1);
});

Deno.test("DenoInfoModuleGraphReader: the second read never freezes the lock, even when push reads under --frozen", async () => {
  await withProject({
    "deno.json": JSON.stringify({ imports: { "zod": "npm:zod@4" } }),
    "deno.lock": '{ "version": "5" }',
    "models/m.ts": 'import { z } from "zod";\nexport const m = z;\n',
  }, async (dir) => {
    const modelUrl = toFileUrl(join(dir, "models", "m.ts")).href;
    const info = (code: Record<string, string>) =>
      JSON.stringify({
        modules: [{
          kind: "esm",
          mediaType: "TypeScript",
          specifier: modelUrl,
          dependencies: [{ specifier: "zod", code }],
        }],
      });
    const { calls, result: graph } = await withMockedCommand(
      [
        { stdout: info({ error: "not in node_modules" }), code: 0 },
        { stdout: info({ specifier: "npm:zod@4" }), code: 0 },
      ],
      () =>
        new DenoInfoModuleGraphReader("deno", undefined, {
          readOnlyLock: true,
        }).read(join(dir, "models", "m.ts"), {
          denoConfigPath: join(dir, "deno.json"),
        }),
    );
    assertEquals(calls[0].args.includes("--frozen"), true);
    assertEquals(calls[1].args.includes("--frozen"), false);
    assertEquals(calls[1].args.includes("--no-lock"), true);
    assertEquals(graph.bareImports?.[0].target, "npm:zod@4");
  });
});
