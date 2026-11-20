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
import { join } from "@std/path";
import { readAppDependencies } from "./app_dependencies.ts";

async function withApp(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, name), text);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

const LOCK = `{
  "lockfileVersion": 2,
  "packages": {
    "@scope/ui": ["@scope/ui@1.4.0", "", {}, "sha512-a"],
    "vite": ["vite@6.4.6", "", { "dependencies": { "esbuild": "^0.25.0" } }, "sha512-b"],
    "esbuild": ["esbuild@0.25.12", "", {}, "sha512-c"],
  },
}`;

const GIT_LOCK = LOCK.replace(
  `"packages": {`,
  `"packages": {\n    "left": ["left@github:someone/left#abc", {}, "abc"],`,
);

Deno.test("readAppDependencies: audits what the runtime dependencies reach and checks build tools statically, at the locked version", async () => {
  await withApp({
    "package.json": JSON.stringify({
      dependencies: { "@scope/ui": "^1.2.0" },
      devDependencies: { vite: "^6.4.5" },
    }),
    "bun.lock": LOCK,
  }, async (dir) => {
    const { shipped, buildOnly, problems } = await readAppDependencies(
      dir,
      "cost",
    );
    assertEquals(problems, []);
    assertEquals(
      shipped.map((s) => [s.name, s.version, s.bundled?.version]),
      [["@scope/ui", "^1.2.0", "1.4.0"]],
    );
    assertEquals(
      buildOnly.map((s) => [s.name, s.version, s.bundled?.version]),
      [
        ["vite", "^6.4.5", "6.4.6"],
        ["esbuild", "0.25.12", "0.25.12"],
      ],
    );
    assertEquals(shipped[0].sourceFile, join(dir, "package.json"));
    assertEquals(buildOnly[1].sourceFile, join(dir, "bun.lock"));
  });
});

Deno.test("readAppDependencies: an app with no package.json cannot be audited", async () => {
  await withApp({}, async (dir) => {
    const { problems } = await readAppDependencies(dir, "cost");
    assertStringIncludes(problems[0], "no package.json");
  });
});

Deno.test("readAppDependencies: dependencies without bun.lock are refused", async () => {
  await withApp({
    "package.json": JSON.stringify({ dependencies: { vite: "^6.4.5" } }),
  }, async (dir) => {
    const { problems } = await readAppDependencies(dir, "cost");
    assertStringIncludes(problems[0], "no bun.lock");
  });
});

Deno.test("readAppDependencies: an npm lockfile is refused", async () => {
  await withApp({
    "package.json": "{}",
    "package-lock.json": "{}",
  }, async (dir) => {
    const { problems } = await readAppDependencies(dir, "cost");
    assertStringIncludes(problems[0], "Bun only");
  });
});

Deno.test("readAppDependencies: a git dependency and a stale lock are refused", async () => {
  await withApp({
    "package.json": JSON.stringify({
      dependencies: { left: "github:someone/left", vite: "^7.0.0" },
    }),
    "bun.lock": GIT_LOCK,
  }, async (dir) => {
    const { shipped, buildOnly, problems } = await readAppDependencies(
      dir,
      "cost",
    );
    assertEquals(problems.length, 3);
    assertStringIncludes(problems[0], "takes left from left@github:");
    assertStringIncludes(problems[1], "not an npm registry version");
    assertStringIncludes(problems[2], "outside ^7.0.0");
    assertEquals(
      [...shipped, ...buildOnly].some((s) => s.name === "left"),
      false,
    );
  });
});

Deno.test("readAppDependencies: a lock entry that is not a registry version is refused", async () => {
  await withApp({
    "package.json": JSON.stringify({ dependencies: { left: "*" } }),
    "bun.lock": GIT_LOCK,
  }, async (dir) => {
    const { problems } = await readAppDependencies(dir, "cost");
    assertStringIncludes(problems[0], "not the npm registry");
    assertStringIncludes(problems[1], "does not pin left");
  });
});
