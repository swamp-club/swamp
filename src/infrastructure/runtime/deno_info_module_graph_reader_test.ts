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

import { assertEquals, assertRejects } from "@std/assert";
import { join, relative, toFileUrl } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import {
  DenoInfoModuleGraphReader,
  parseDenoInfoGraph,
} from "./deno_info_module_graph_reader.ts";

const ROOT = Deno.build.os === "windows" ? "C:\\ext" : "/ext";
const url = (...parts: string[]) => toFileUrl(join(ROOT, ...parts)).href;
const path = (...parts: string[]) => join(ROOT, ...parts);
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
    () => Promise.resolve(true),
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
    () => Promise.resolve(true),
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
    (p) => Promise.resolve(p === path("t.txt")),
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
    () => Promise.resolve(true),
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
    await Deno.remove(dir, { recursive: true }).catch(() => {});
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
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
