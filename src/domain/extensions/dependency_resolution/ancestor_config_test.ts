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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import {
  ancestorConfigRefusal,
  ancestorConfigResolves,
  ancestorNodeModulesRefusal,
  nodeModulesAboveBoundary,
} from "./ancestor_config.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-ancestor-config-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't released a handle yet.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("ancestorConfigResolves: the bare imports a deno.json above maps", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "deno.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({ imports: { ms: "npm:ms@2", "@std/": "jsr:@std/" } }),
    );
    assertEquals(
      await ancestorConfigResolves({ path, kind: "deno-config" }, [
        "ms",
        "@std/path",
        "other",
        "ms",
      ]),
      ["@std/path", "ms"],
    );
  });
});

Deno.test("ancestorConfigResolves: the bare imports whose package a package.json above declares", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "package.json");
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        dependencies: { ms: "^2" },
        devDependencies: { "@scope/pkg": "1" },
      }),
    );
    assertEquals(
      await ancestorConfigResolves({ path, kind: "package-json" }, [
        "ms/sub",
        "@scope/pkg/deep",
        "other",
      ]),
      ["@scope/pkg/deep", "ms/sub"],
    );
    // One that cannot be read declares nothing.
    await Deno.writeTextFile(path, "{");
    assertEquals(
      await ancestorConfigResolves({ path, kind: "package-json" }, ["ms"]),
      [],
    );
  });
});

Deno.test("ancestorConfigResolves: a workspace root above applies whatever it maps", async () => {
  assertEquals(
    await ancestorConfigResolves(
      { path: "/nowhere/deno.json", kind: "workspace-root" },
      ["b", "a"],
    ),
    ["a", "b"],
  );
});

Deno.test("ancestorConfigRefusal: names the config, the imports and the fix", () => {
  const deno = ancestorConfigRefusal(
    { path: "/home/u/deno.json", kind: "deno-config" },
    ["ms"],
    "/home/u/repo",
  );
  assertStringIncludes(deno, "/home/u/deno.json above /home/u/repo");
  assertStringIncludes(deno, 'resolve "ms"');
  assertStringIncludes(deno, "--no-config");
  assertStringIncludes(
    deno,
    "Add a deno.json inside the repository that maps the import",
  );
  const pkg = ancestorConfigRefusal(
    { path: "/home/u/package.json", kind: "package-json" },
    ["a", "b"],
    "/home/u/repo",
  );
  assertStringIncludes(
    pkg,
    "Add a package.json inside the repository that declares the imports",
  );
  const root = ancestorConfigRefusal(
    { path: "/w/deno.json", kind: "workspace-root" },
    [],
    "/w/repo",
  );
  assertStringIncludes(root, "workspace root /w/deno.json above /w/repo");
  assertStringIncludes(root, "Move the workspace root inside the repository");
});

Deno.test("nodeModulesAboveBoundary: a node_modules inside the repository serves it, one above does not", () => {
  const repo = resolve("/", "w", "repo");
  const above = resolve("/", "w", "node_modules", "ms");
  const scopedAbove = resolve("/", "w", "node_modules", "@s", "p");
  // A monorepo hoists to the repository root, above the package.json
  // project but inside the repository.
  const hoisted = join(repo, "node_modules", "ms");
  const own = join(repo, "ext", "node_modules", "ms");
  assertEquals(
    nodeModulesAboveBoundary(
      [own, hoisted, above, scopedAbove, above],
      [repo],
    ),
    [above, scopedAbove].sort(),
  );
});

Deno.test("nodeModulesAboveBoundary: a repository reached through a symlink is checked by its real path too", () => {
  // Deno reports installed packages by real path; the boundary is the path
  // the repository was given as.
  const link = resolve("/", "home", "u", "link-to-repo");
  const real = resolve("/", "srv", "repo");
  const installed = join(real, "node_modules", "ms");
  assertEquals(nodeModulesAboveBoundary([installed], [link]), [installed]);
  assertEquals(nodeModulesAboveBoundary([installed], [link, real]), []);
});

Deno.test("nodeModulesAboveBoundary: a boundary at the filesystem root holds everything", () => {
  const root = resolve("/");
  assertEquals(
    nodeModulesAboveBoundary([join(root, "node_modules", "ms")], [root]),
    [],
  );
});

Deno.test("ancestorNodeModulesRefusal: names the packages and where to declare them", () => {
  const message = ancestorNodeModulesRefusal(
    ["/w/node_modules/ms"],
    "/w/repo",
    "/w/repo",
  );
  assertStringIncludes(message, "/w/node_modules/ms in a node_modules above");
  assertStringIncludes(message, "Declare the package in /w/repo");
  assertStringIncludes(
    ancestorNodeModulesRefusal(["/a", "/b"], "/w/repo", undefined),
    "Declare the packages in a package.json inside the repository",
  );
});
