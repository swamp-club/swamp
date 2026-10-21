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
import { expandGlob } from "@std/fs";
import { basename, join } from "@std/path";
import { expandSourceGlob, type SourceGlobFs } from "./source_glob_expander.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-source-glob-test-" }),
  );
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const ESC = Deno.build.os === "windows" ? "`" : "\\";

async function buildTree(dir: string): Promise<void> {
  const dirs = [
    "a",
    "a/aa",
    "a/ab",
    "b",
    "b/c",
    "b/c/d",
    ".hidden",
    ".hidden/.deep",
    "x{y}",
    "br[1]",
    "q1",
    "q22",
    "sp ace",
  ];
  for (const d of dirs) {
    await Deno.mkdir(join(dir, ...d.split("/")), { recursive: true });
  }
  await Deno.writeTextFile(join(dir, "file.txt"), "");
  await Deno.writeTextFile(join(dir, "a", "f.ts"), "");
  await Deno.symlink(join(dir, "b"), join(dir, "linkb"), { type: "dir" });
  await Deno.symlink(dir, join(dir, "a", "loop"), { type: "dir" });
}

// Each pattern is relative to the tree root and split on "/" so the glob is
// built with the platform separator.
const PATTERNS = [
  "*",
  "**",
  "*/*",
  "**/*",
  "**/c",
  "**/d",
  "**/..",
  "a/*",
  "a/a[ab]",
  "{a,b}",
  "{a,b}/*",
  "q?",
  "q*",
  `br${ESC}[1${ESC}]`,
  `x${ESC}{y${ESC}}`,
  "*/..",
  "b/c/../*",
  "b/**",
  "b/**/*",
  "+(a|b)",
  "!(a)",
  ".*",
  "linkb/*",
  "nope/*",
  "missing*",
];

Deno.test("expandSourceGlob: matches the directories @std/fs expandGlob finds, in the same order", async () => {
  await withTempDir(async (dir) => {
    await buildTree(dir);
    for (const pattern of PATTERNS) {
      const glob = join(dir, ...pattern.split("/"));
      const expected = (await Array.fromAsync(
        expandGlob(glob, { globstar: true }),
      )).filter((entry) => entry.isDirectory).map((entry) => entry.path);
      assertEquals(await expandSourceGlob(glob), expected, pattern);
    }
  });
});

Deno.test("expandSourceGlob: a trailing separator still yields directories only", async () => {
  await withTempDir(async (dir) => {
    await buildTree(dir);
    const glob = join(dir, "*") + (Deno.build.os === "windows" ? "\\" : "/");
    const expected = (await Array.fromAsync(
      expandGlob(glob, { globstar: true }),
    )).filter((entry) => entry.isDirectory).map((entry) => entry.path);
    assertEquals(await expandSourceGlob(glob), expected);
  });
});

Deno.test("expandSourceGlob: returns nothing when the fixed root does not exist", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await expandSourceGlob(join(dir, "missing", "*")), []);
  });
});

// A filesystem that lists a "ghost" entry under `ghostParent` whose stat
// then fails with `error`, as when another process removes it in between.
function ghostFs(ghostParent: string, error: Error): SourceGlobFs {
  return {
    async *readDir(path) {
      yield* Deno.readDir(path);
      if (path === ghostParent) {
        yield {
          name: "ghost",
          isDirectory: true,
          isFile: false,
          isSymlink: false,
        };
      }
    },
    stat(path) {
      if (basename(path) === "ghost") return Promise.reject(error);
      return Deno.stat(path);
    },
  };
}

Deno.test("expandSourceGlob: skips a directory removed between listing and stat", async () => {
  await withTempDir(async (dir) => {
    await buildTree(dir);
    const fs = ghostFs(dir, new Deno.errors.NotFound("gone"));
    const result = await expandSourceGlob(join(dir, "*"), fs);
    assertEquals(result, await expandSourceGlob(join(dir, "*")));
  });
});

Deno.test("expandSourceGlob: skips a directory removed mid-walk under a globstar", async () => {
  await withTempDir(async (dir) => {
    await buildTree(dir);
    const fs = ghostFs(join(dir, "b", "c"), new Deno.errors.NotFound("gone"));
    const result = await expandSourceGlob(join(dir, "**"), fs);
    assertEquals(result, await expandSourceGlob(join(dir, "**")));
  });
});

Deno.test("expandSourceGlob: skips a directory replaced by a file between listing and stat", async () => {
  await withTempDir(async (dir) => {
    await buildTree(dir);
    const fs = ghostFs(dir, new Deno.errors.NotADirectory("not a dir"));
    const result = await expandSourceGlob(join(dir, "*"), fs);
    assertEquals(result, await expandSourceGlob(join(dir, "*")));
  });
});

Deno.test("expandSourceGlob: keeps entries listed before a directory vanishes mid-listing", async () => {
  await withTempDir(async (dir) => {
    await buildTree(dir);
    const fs: SourceGlobFs = {
      async *readDir(path) {
        yield* Deno.readDir(path);
        if (path === join(dir, "a")) throw new Deno.errors.NotFound("gone");
      },
      stat: (path) => Deno.stat(path),
    };
    const result = await expandSourceGlob(join(dir, "a", "*"), fs);
    assertEquals(result, [join(dir, "a", "aa"), join(dir, "a", "ab")]);
  });
});

Deno.test("expandSourceGlob: errors other than a vanished entry still throw", async () => {
  await withTempDir(async (dir) => {
    await buildTree(dir);
    const fs: SourceGlobFs = {
      readDir: (path) => Deno.readDir(path),
      stat(path) {
        if (path === join(dir, "a")) {
          return Promise.reject(new Deno.errors.PermissionDenied("denied"));
        }
        return Deno.stat(path);
      },
    };
    await assertRejects(
      () => expandSourceGlob(join(dir, "*"), fs),
      Deno.errors.PermissionDenied,
    );
  });
});
