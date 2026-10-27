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
import { join } from "@std/path";
import { makeDirectories } from "./make_directories.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-make-dirs-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native handles yet.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("makeDirectories: creates every missing directory and syncs the parent of each one it created", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(join(dir, "a"));
    const target = join(dir, "a", "b", "c", "d");
    const synced: string[] = [];
    await makeDirectories(target, (d) => {
      synced.push(d);
      return Promise.resolve();
    });
    assertEquals((await Deno.stat(target)).isDirectory, true);
    // "a" existed: its parent is not synced, its new child's entry is.
    assertEquals(
      synced.sort(),
      [
        join(dir, "a"),
        join(dir, "a", "b"),
        join(dir, "a", "b", "c"),
      ].sort(),
    );
  });
});

Deno.test("makeDirectories: a directory that already exists syncs nothing", async () => {
  await withTempDir(async (dir) => {
    const synced: string[] = [];
    await makeDirectories(dir, (d) => {
      synced.push(d);
      return Promise.resolve();
    });
    assertEquals(synced, []);
  });
});

Deno.test("makeDirectories: without a sync, only creates", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "x", "y");
    await makeDirectories(target);
    assertEquals((await Deno.stat(target)).isDirectory, true);
  });
});

Deno.test("makeDirectories: a failed sync rejects after every sync settles", async () => {
  await withTempDir(async (dir) => {
    const settled: string[] = [];
    await assertRejects(
      () =>
        makeDirectories(join(dir, "p", "q"), async (d) => {
          if (d === dir) throw new Error("dir EIO");
          await Promise.resolve();
          settled.push(d);
        }),
      Error,
      "dir EIO",
    );
    assertEquals(settled, [join(dir, "p")]);
  });
});

Deno.test({
  name:
    "makeDirectories: a dangling symlink above the target rejects instead of retrying forever",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const link = join(dir, "link");
      await Deno.symlink(join(dir, "gone"), link, { type: "dir" });
      await assertRejects(
        () => makeDirectories(join(link, "child")),
        Deno.errors.NotFound,
      );
    });
  },
});

Deno.test("makeDirectories: a file above the target rejects", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "file");
    await Deno.writeTextFile(file, "");
    await assertRejects(() => makeDirectories(join(file, "child")));
  });
});
