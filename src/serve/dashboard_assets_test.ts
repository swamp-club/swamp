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

import { assert, assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { assertPathEquals } from "../infrastructure/persistence/path_test_helpers.ts";
import {
  DASHBOARD_DIST_DIR,
  dashboardBundleExists,
  serveDashboardFile,
  serveDashboardRoute,
} from "./dashboard_assets.ts";

async function withDist(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-dashboard-dist-" });
  try {
    await Deno.writeTextFile(join(dir, "index.html"), "<html>index</html>");
    await Deno.mkdir(join(dir, "assets"));
    await Deno.writeTextFile(join(dir, "assets", "app.js"), "console.log(1)");
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("DASHBOARD_DIST_DIR: resolves to packages/dashboard/dist at the repo root", () => {
  assertPathEquals(
    DASHBOARD_DIST_DIR,
    resolve(import.meta.dirname!, "..", "..", "packages", "dashboard", "dist"),
  );
  // The parent is the dashboard package and its grandparent's parent the repo.
  assert(Deno.statSync(join(DASHBOARD_DIST_DIR, "..", "package.json")).isFile);
  assert(
    Deno.statSync(join(DASHBOARD_DIST_DIR, "..", "..", "..", "deno.json"))
      .isFile,
  );
});

Deno.test("dashboardBundleExists: is true only when index.html is present", async () => {
  await withDist(async (dir) => {
    assertEquals(await dashboardBundleExists(dir), true);
    await Deno.remove(join(dir, "index.html"));
    assertEquals(await dashboardBundleExists(dir), false);
  });
});

Deno.test("serveDashboardFile: serves a file with its content type", async () => {
  await withDist(async (dir) => {
    const res = await serveDashboardFile(dir, "assets/app.js");
    assert(res);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "application/javascript");
    assertEquals(await res.text(), "console.log(1)");
    const index = await serveDashboardFile(dir, "index.html");
    assertEquals(index?.headers.get("cache-control"), "no-cache");
    await index?.body?.cancel();
  });
});

Deno.test("serveDashboardFile: returns null for a missing file", async () => {
  await withDist(async (dir) => {
    assertEquals(await serveDashboardFile(dir, "nope.js"), null);
  });
});

Deno.test("serveDashboardFile: refuses traversal and absolute paths", async () => {
  await withDist(async (dir) => {
    for (
      const path of [
        "../secret",
        "assets/../../secret",
        "..\\secret",
        "/etc/passwd",
      ]
    ) {
      const res = await serveDashboardFile(dir, path);
      assertEquals(res?.status, 403, path);
      await res?.body?.cancel();
    }
  });
});

Deno.test("serveDashboardRoute: serves files, falls back to index.html and ignores other paths", async () => {
  await withDist(async (dir) => {
    const asset = await serveDashboardRoute(
      dir,
      new Request("http://127.0.0.1/dashboard/assets/app.js"),
    );
    assertEquals(await asset?.text(), "console.log(1)");
    const spa = await serveDashboardRoute(
      dir,
      new Request("http://127.0.0.1/dashboard/start"),
    );
    assertEquals(await spa?.text(), "<html>index</html>");
    assertEquals(
      await serveDashboardRoute(dir, new Request("http://127.0.0.1/other")),
      null,
    );
    const post = await serveDashboardRoute(
      dir,
      new Request("http://127.0.0.1/dashboard", { method: "POST" }),
    );
    assertEquals(post?.status, 405);
    await post?.body?.cancel();
  });
});
