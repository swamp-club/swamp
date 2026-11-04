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
import { realAppBuildDir } from "./app_build_dir.ts";

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await body(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("realAppBuildDir: a build folder inside the app is its real path", async () => {
  await withDir(async (dir) => {
    const app = join(dir, "app");
    await Deno.mkdir(join(app, "dist"), { recursive: true });
    assertEquals(
      await realAppBuildDir(app, "dist/index.html"),
      join(app, "dist"),
    );
  });
});

Deno.test("realAppBuildDir: a build folder linked outside the app is null", async () => {
  await withDir(async (dir) => {
    const app = join(dir, "app");
    await Deno.mkdir(app);
    await Deno.mkdir(join(dir, "elsewhere"));
    await Deno.symlink(join(dir, "elsewhere"), join(app, "dist"), {
      type: "dir",
    });
    assertEquals(await realAppBuildDir(app, "dist/index.html"), null);
  });
});

Deno.test("realAppBuildDir: the app's own folder is not a build folder", async () => {
  await withDir(async (dir) => {
    assertEquals(await realAppBuildDir(dir, "index.html"), null);
  });
});

Deno.test("realAppBuildDir: a missing build folder throws", async () => {
  await withDir(async (dir) => {
    await assertRejects(() => realAppBuildDir(dir, "dist/index.html"));
  });
});
