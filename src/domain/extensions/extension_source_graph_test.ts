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
import {
  type LocalEdge,
  type SourceModuleGraph,
  withoutSymlinkedModules,
} from "./extension_source_graph.ts";

const span = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

function edge(importer: string, target: string, line = 0): LocalEdge {
  return {
    importer,
    target,
    specifier: `./${target}`,
    span: {
      ...span,
      start: { line, character: 0 },
      end: { line, character: 1 },
    },
  };
}

function graphOf(
  code: string[],
  edges: LocalEdge[],
  missing: SourceModuleGraph["missing"] = [],
): SourceModuleGraph {
  return {
    modules: code.map((path) => ({ path, kind: "code" as const })),
    edges,
    missing,
  };
}

Deno.test("withoutSymlinkedModules: a symlinked root leaves nothing of its graph", () => {
  const result = withoutSymlinkedModules(
    graphOf(["/r/m.ts", "/r/a.ts"], [edge("/r/m.ts", "/r/a.ts")], [
      { path: "/r/x.ts", importer: "/r/m.ts", reason: "SECRET" },
    ]),
    "/r/m.ts",
    new Set(["/r/m.ts"]),
  );
  assertEquals(result.graph, { modules: [], edges: [], missing: [] });
  assertEquals(result.symlinked, [{ path: "/r/m.ts", kind: "code" }]);
});

Deno.test("withoutSymlinkedModules: a symlinked root the graph could not load is listed as code, its reason dropped", () => {
  const result = withoutSymlinkedModules(
    graphOf([], [], [{ path: "/r/m.ts", reason: "1 | root:x:0:0" }]),
    "/r/m.ts",
    new Set(["/r/m.ts"]),
  );
  assertEquals(result.graph.missing, []);
  assertEquals(result.symlinked, [{ path: "/r/m.ts", kind: "code" }]);
});

Deno.test("withoutSymlinkedModules: removes a symlinked module and what only it reaches, keeping shared modules", () => {
  const graph = graphOf(
    ["/r/m.ts", "/r/link.ts", "/r/behind.ts", "/r/shared.ts", "/r/plain.ts"],
    [
      edge("/r/m.ts", "/r/link.ts", 0),
      edge("/r/m.ts", "/r/shared.ts", 1),
      edge("/r/m.ts", "/r/plain.ts", 2),
      edge("/r/link.ts", "/r/behind.ts", 0),
      edge("/r/link.ts", "/r/shared.ts", 1),
      edge("/r/link.ts", "/r/gone.ts", 2),
    ],
    [{ path: "/r/gone.ts", importer: "/r/link.ts", reason: "SECRET" }],
  );
  const result = withoutSymlinkedModules(
    graph,
    "/r/m.ts",
    new Set(["/r/link.ts"]),
  );
  assertEquals(result.graph.modules.map((m) => m.path), [
    "/r/m.ts",
    "/r/shared.ts",
    "/r/plain.ts",
  ]);
  assertEquals(result.graph.edges, [
    edge("/r/m.ts", "/r/shared.ts", 1),
    edge("/r/m.ts", "/r/plain.ts", 2),
  ]);
  assertEquals(result.graph.missing, []);
  assertEquals(result.symlinked, [{ path: "/r/link.ts", kind: "code" }]);
});

Deno.test("withoutSymlinkedModules: a missing symlinked module is listed and its reason never kept", () => {
  const result = withoutSymlinkedModules(
    graphOf(["/r/m.ts"], [edge("/r/m.ts", "/r/pw.ts")], [
      { path: "/r/pw.ts", importer: "/r/m.ts", reason: "1 | root:x:0:0" },
    ]),
    "/r/m.ts",
    new Set(["/r/pw.ts"]),
  );
  assertEquals(result.graph, {
    modules: [{ path: "/r/m.ts", kind: "code" }],
    edges: [],
    missing: [],
  });
  assertEquals(result.symlinked, [{ path: "/r/pw.ts", kind: "code" }]);
});

Deno.test("withoutSymlinkedModules: a symlink reached only through another symlink is not listed", () => {
  const result = withoutSymlinkedModules(
    graphOf(["/r/m.ts", "/r/a.ts", "/r/b.ts"], [
      edge("/r/m.ts", "/r/a.ts"),
      edge("/r/a.ts", "/r/b.ts"),
    ]),
    "/r/m.ts",
    new Set(["/r/a.ts", "/r/b.ts"]),
  );
  assertEquals(result.symlinked, [{ path: "/r/a.ts", kind: "code" }]);
  assertEquals(result.graph.modules.map((m) => m.path), ["/r/m.ts"]);
});

Deno.test("withoutSymlinkedModules: keeps a symlinked data module's kind, and keeps modules no edge leads to", () => {
  const graph: SourceModuleGraph = {
    modules: [
      { path: "/r/m.ts", kind: "code" },
      { path: "/r/d.json", kind: "data" },
      { path: "/r/unlinked.txt", kind: "data" },
    ],
    edges: [edge("/r/m.ts", "/r/d.json")],
    missing: [],
  };
  const result = withoutSymlinkedModules(
    graph,
    "/r/m.ts",
    new Set(["/r/d.json"]),
  );
  assertEquals(result.symlinked, [{ path: "/r/d.json", kind: "data" }]);
  assertEquals(result.graph.modules.map((m) => m.path), [
    "/r/m.ts",
    "/r/unlinked.txt",
  ]);
});

Deno.test("withoutSymlinkedModules: a graph without symlinks is unchanged", () => {
  const graph = graphOf(["/r/m.ts", "/r/a.ts"], [edge("/r/m.ts", "/r/a.ts")], [
    { path: "/r/x.ts", importer: "/r/a.ts", reason: "Module not found" },
  ]);
  const result = withoutSymlinkedModules(graph, "/r/m.ts", new Set());
  assertEquals(result.graph, graph);
  assertEquals(result.symlinked, []);
});
