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
import { join } from "@std/path";
import {
  type BundleReferenceLookup,
  evictRemovedBundles,
} from "./bundle_eviction.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_bundle_eviction_" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** A catalog lookup that answers from a fixed set and records queries. */
function lookup(referenced: string[] = []): BundleReferenceLookup & {
  queried: string[];
} {
  const queried: string[] = [];
  return {
    queried,
    hasRowWithBundlePath(bundlePath: string): boolean {
      queried.push(bundlePath);
      return referenced.includes(bundlePath);
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("evictRemovedBundles: deletes the bundle when the source is gone and no row references it", async () => {
  await withTempDir(async (dir) => {
    const bundle = join(dir, "bundles", "x.js");
    await Deno.mkdir(join(dir, "bundles"));
    await Deno.writeTextFile(bundle, "/* bundle */");
    const catalog = lookup();

    evictRemovedBundles([
      { source_path: join(dir, "models", "x.ts"), bundle_path: bundle },
    ], catalog);

    assertEquals(await exists(bundle), false);
    assertEquals(catalog.queried, [bundle]);
  });
});

Deno.test("evictRemovedBundles: keeps the bundle when the source still exists", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "x.ts");
    const bundle = join(dir, "x.js");
    await Deno.writeTextFile(source, "export const x = 1;");
    await Deno.writeTextFile(bundle, "/* bundle */");

    evictRemovedBundles(
      [{ source_path: source, bundle_path: bundle }],
      lookup(),
    );

    assertEquals(await exists(bundle), true);
  });
});

Deno.test("evictRemovedBundles: keeps the bundle when a remaining row still references it", async () => {
  await withTempDir(async (dir) => {
    const bundle = join(dir, "shared.js");
    await Deno.writeTextFile(bundle, "/* bundle */");
    const catalog = lookup([bundle]);

    evictRemovedBundles([
      { source_path: join(dir, "gone.ts"), bundle_path: bundle },
    ], catalog);

    assertEquals(await exists(bundle), true);
    assertEquals(catalog.queried, [bundle]);
  });
});

Deno.test("evictRemovedBundles: ignores a row with an empty bundle_path", async () => {
  await withTempDir(async (dir) => {
    const catalog = lookup();

    evictRemovedBundles([
      { source_path: join(dir, "gone.ts"), bundle_path: "" },
      { source_path: join(dir, "also_gone.ts") },
    ], catalog);

    assertEquals(catalog.queried, []);
    assertEquals(await exists(dir), true);
  });
});

Deno.test("evictRemovedBundles: an already-missing bundle file does not throw", async () => {
  await withTempDir(async (dir) => {
    const bundle = join(dir, `missing-${crypto.randomUUID()}.js`);

    evictRemovedBundles([
      { source_path: join(dir, "gone.ts"), bundle_path: bundle },
    ], lookup());

    assertEquals(await exists(bundle), false);
  });
});

Deno.test({
  name:
    "evictRemovedBundles: keeps the bundle when the source exists under a symlinked alias of its dir",
  // Creating a directory symlink needs extra privileges on Windows.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const realDir = join(dir, "real");
      const aliasDir = join(dir, "alias");
      await Deno.mkdir(join(realDir, "models"), { recursive: true });
      await Deno.writeTextFile(
        join(realDir, "models", "x.ts"),
        "export const x = 1;",
      );
      await Deno.symlink(realDir, aliasDir, { type: "dir" });
      const bundle = join(dir, "x.js");
      await Deno.writeTextFile(bundle, "/* bundle */");

      evictRemovedBundles([
        {
          source_path: join(aliasDir, "models", "x.ts"),
          bundle_path: bundle,
        },
      ], lookup());

      assertEquals(await exists(bundle), true);
    });
  },
});
