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
  nonRegistryDependencies,
  packageJsonSpecKind,
  urlImportClosures,
} from "./unaudited_code.ts";

const isLocal = (s: string) => s.startsWith("file:");

Deno.test("urlImportClosures: each URL a local module imports, with what is fetched through it", () => {
  const closures = urlImportClosures({
    redirects: { "https://x.test/mod.ts": "https://x.test/v1/mod.ts" },
    modules: [
      {
        specifier: "file:///m.ts",
        dependencies: [
          { code: { specifier: "https://x.test/mod.ts" } },
          { code: { specifier: "jsr:@std/assert@1" } },
          { code: { specifier: "./local.ts" } },
        ],
      },
      {
        specifier: "https://x.test/v1/mod.ts",
        local: "/cache/a",
        dependencies: [
          { code: { specifier: "https://x.test/v1/dep.ts" } },
          { code: { specifier: "npm:ms@2" } },
        ],
      },
      { specifier: "https://x.test/v1/dep.ts", local: "/cache/b" },
      { specifier: "https://jsr.io/@std/assert/1.0.0/mod.ts", local: "/c" },
    ],
  }, isLocal);
  assertEquals(closures, [{
    origin: "https://x.test/mod.ts",
    modules: [
      { url: "https://x.test/v1/dep.ts", local: "/cache/b" },
      { url: "https://x.test/v1/mod.ts", local: "/cache/a" },
    ],
  }]);
});

Deno.test("urlImportClosures: no URL import, no closure; a jsr module is the registry's", () => {
  assertEquals(
    urlImportClosures({
      modules: [{
        specifier: "file:///m.ts",
        dependencies: [{ code: { specifier: "jsr:@std/assert@1" } }],
      }],
    }, isLocal),
    [],
  );
});

Deno.test("packageJsonSpecKind: registry specs, paths, workspaces, git and URLs", () => {
  for (const spec of ["^1.0.0", "1.2.3", "latest", "npm:other@^1", "*"]) {
    assertEquals(packageJsonSpecKind(spec), "registry", spec);
  }
  for (
    const spec of ["file:../x", "link:../x", "workspace:*", "./vendor/x"]
  ) {
    assertEquals(packageJsonSpecKind(spec), "package-json", spec);
  }
  for (
    const spec of [
      "git+https://github.com/a/b.git",
      "github:a/b",
      "a/b#main",
      "git://example.com/x.git",
    ]
  ) {
    assertEquals(packageJsonSpecKind(spec), "git", spec);
  }
  assertEquals(packageJsonSpecKind("https://example.com/x.tgz"), "url");
});

Deno.test("nonRegistryDependencies: lists dependencies and devDependencies from outside npm, sorted", () => {
  assertEquals(
    nonRegistryDependencies({
      dependencies: { ms: "^2", z: "file:./z", a: "github:o/a" },
      devDependencies: { d: "link:../d", ms: "file:./ignored" },
    }),
    [
      { name: "a", spec: "github:o/a", kind: "git" },
      { name: "d", spec: "link:../d", kind: "package-json" },
      { name: "z", spec: "file:./z", kind: "package-json" },
    ],
  );
  assertEquals(nonRegistryDependencies(null), []);
});
