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

/**
 * Integration test for giga-swamp Phase 7 — namespace migration.
 *
 * Tests the full round-trip: solo repo with data → namespace set → migrate →
 * verify namespaced layout → namespace unset --migrate → verify solo layout.
 * Verifies data integrity (file count + content) at every step.
 */

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  createLibSwampContext,
  datastoreNamespaceMigrate,
  type NamespaceMigrateEvent,
} from "../src/libswamp/mod.ts";
import { collect } from "../src/libswamp/testing.ts";
import { DEFAULT_DATASTORE_SUBDIRS } from "../src/domain/datastore/datastore_config.ts";
import {
  removeNamespaceManifest,
  writeNamespaceManifest,
} from "../src/infrastructure/persistence/namespace_manifest.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import {
  catalogDbPath,
} from "../src/infrastructure/persistence/repository_factory.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-migrate-" });
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

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) count++;
      if (entry.isDirectory) count += await countFiles(join(dir, entry.name));
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return 0;
    throw e;
  }
  return count;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch {
    return false;
  }
}

async function dirSize(
  path: string,
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isFile) {
        fileCount++;
        const stat = await Deno.stat(join(path, entry.name));
        totalBytes += stat.size;
      }
      if (entry.isDirectory) {
        const sub = await dirSize(join(path, entry.name));
        fileCount += sub.fileCount;
        totalBytes += sub.totalBytes;
      }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return { fileCount: 0, totalBytes: 0 };
    }
    throw e;
  }
  return { fileCount, totalBytes };
}

function buildDeps(
  dsPath: string,
  namespace: string,
  catalogStore: CatalogStore,
) {
  return {
    getDatastorePath: () => dsPath,
    getNamespace: () => namespace,
    dirExists,
    dirHasDataFiles: async (path: string) => {
      if (!(await dirExists(path))) return false;
      for await (const entry of Deno.readDir(path)) {
        if (
          entry.name !== "_catalog.db" &&
          entry.name !== "_catalog.db-journal" &&
          entry.name !== "_catalog.db-wal"
        ) return true;
      }
      return false;
    },
    dirSize,
    renameDir: (source: string, destination: string) =>
      Deno.rename(source, destination),
    mergeDirInto: async (source: string, destination: string) => {
      let moved = 0;
      const mergeRecursive = async (
        src: string,
        dst: string,
      ): Promise<void> => {
        for await (const entry of Deno.readDir(src)) {
          const srcPath = join(src, entry.name);
          const dstPath = join(dst, entry.name);
          try {
            await Deno.stat(dstPath);
            if (entry.isDirectory) await mergeRecursive(srcPath, dstPath);
          } catch {
            await Deno.rename(srcPath, dstPath);
            moved++;
          }
        }
      };
      await mergeRecursive(source, destination);
      try {
        await Deno.remove(source, { recursive: true });
      } catch { /* best-effort */ }
      return moved;
    },
    ensureDir: (path: string) => ensureDir(path),
    invalidateCatalog: () => catalogStore.invalidate(),
    markDirtyBulk: () => Promise.resolve(),
    removeNamespaceManifest: (ns: string) =>
      removeNamespaceManifest(dsPath, ns),
    isExtensionDatastore: false,
  };
}

Deno.test("namespace migrate: full round-trip solo → namespaced → solo", async () => {
  await withTempDir(async (root) => {
    const repoDir = join(root, "repo");
    const dsPath = join(root, "ds");
    const namespace = "infra";

    await ensureDir(join(repoDir, ".swamp"));
    await ensureDir(dsPath);

    // Create solo-mode data in a few subdirs
    const testContent = '{"test": true}';
    for (const subdir of ["data", "outputs", "audit"]) {
      const dir = join(dsPath, subdir, "test-model", "v1");
      await ensureDir(dir);
      await Deno.writeTextFile(join(dir, "raw"), testContent);
    }

    // Write a namespace manifest (simulates namespace set)
    await writeNamespaceManifest(dsPath, namespace, "repo-1");

    const soloFileCount = await countFiles(dsPath);
    // 3 data files + 1 manifest file
    assertEquals(soloFileCount, 4);

    // Create catalog
    const catalogPath = catalogDbPath(repoDir);
    const catalogStore = new CatalogStore(catalogPath);

    try {
      const ctx = createLibSwampContext({});

      // --- Forward migration: solo → namespaced ---
      const fwdDeps = buildDeps(dsPath, namespace, catalogStore);
      const fwdEvents = await collect<NamespaceMigrateEvent>(
        datastoreNamespaceMigrate(ctx, fwdDeps, {
          confirm: true,
          reverse: false,
        }),
      );

      const fwdPreview = fwdEvents.find((e) => e.kind === "preview");
      assertEquals(fwdPreview?.kind, "preview");
      if (fwdPreview?.kind === "preview") {
        assertEquals(fwdPreview.data.directories.length, 3);
        assertEquals(fwdPreview.data.totalFiles, 3);
      }

      const fwdCompleted = fwdEvents.find((e) => e.kind === "completed");
      assertEquals(fwdCompleted?.kind, "completed");
      if (fwdCompleted?.kind === "completed") {
        assertEquals(fwdCompleted.data.migratedDirectories.length, 3);
      }

      // Verify data moved to namespaced paths
      for (const subdir of ["data", "outputs", "audit"]) {
        assertEquals(
          await dirExists(join(dsPath, namespace, subdir)),
          true,
          `${subdir} should exist at namespaced path`,
        );
        assertEquals(
          await dirExists(join(dsPath, subdir)),
          false,
          `${subdir} should NOT exist at solo path`,
        );
        // Verify content integrity
        const content = await Deno.readTextFile(
          join(dsPath, namespace, subdir, "test-model", "v1", "raw"),
        );
        assertEquals(content, testContent);
      }

      // --- Dry-run reverse: should NOT move anything ---
      const dryDeps = buildDeps(dsPath, namespace, catalogStore);
      const dryEvents = await collect<NamespaceMigrateEvent>(
        datastoreNamespaceMigrate(ctx, dryDeps, {
          confirm: false,
          reverse: true,
        }),
      );

      const dryPreview = dryEvents.find((e) => e.kind === "preview");
      assertEquals(dryPreview?.kind, "preview");
      if (dryPreview?.kind === "preview") {
        assertEquals(dryPreview.data.reverse, true);
        assertEquals(dryPreview.data.directories.length, 3);
      }

      // Verify nothing actually moved
      for (const subdir of ["data", "outputs", "audit"]) {
        assertEquals(
          await dirExists(join(dsPath, namespace, subdir)),
          true,
          `${subdir} should still be at namespaced path after dry-run`,
        );
      }

      // --- Reverse migration: namespaced → solo ---
      const revDeps = buildDeps(dsPath, namespace, catalogStore);
      const revEvents = await collect<NamespaceMigrateEvent>(
        datastoreNamespaceMigrate(ctx, revDeps, {
          confirm: true,
          reverse: true,
        }),
      );

      const revCompleted = revEvents.find((e) => e.kind === "completed");
      assertEquals(revCompleted?.kind, "completed");
      if (revCompleted?.kind === "completed") {
        assertEquals(revCompleted.data.migratedDirectories.length, 3);
        assertEquals(revCompleted.data.reverse, true);
      }

      // Verify data moved back to solo paths
      for (const subdir of ["data", "outputs", "audit"]) {
        assertEquals(
          await dirExists(join(dsPath, subdir)),
          true,
          `${subdir} should be back at solo path`,
        );
        assertEquals(
          await dirExists(join(dsPath, namespace, subdir)),
          false,
          `${subdir} should NOT exist at namespaced path`,
        );
        // Verify content integrity
        const content = await Deno.readTextFile(
          join(dsPath, subdir, "test-model", "v1", "raw"),
        );
        assertEquals(content, testContent);
      }

      // Verify manifest was removed on reverse migration
      const manifestPath = join(dsPath, namespace, ".namespace.json");
      let manifestExists = false;
      try {
        await Deno.stat(manifestPath);
        manifestExists = true;
      } catch {
        manifestExists = false;
      }
      assertEquals(
        manifestExists,
        false,
        "Manifest should be removed after reverse migration",
      );
    } finally {
      catalogStore.close();
    }
  });
});

Deno.test("namespace migrate: conflict detection on reverse", async () => {
  await withTempDir(async (root) => {
    const dsPath = join(root, "ds");
    const repoDir = join(root, "repo");
    const namespace = "infra";

    await ensureDir(join(repoDir, ".swamp"));

    // Create data at both namespaced AND solo paths (conflict scenario)
    await ensureDir(join(dsPath, namespace, "data", "model-a"));
    await Deno.writeTextFile(
      join(dsPath, namespace, "data", "model-a", "raw"),
      "namespaced",
    );
    await ensureDir(join(dsPath, "data", "model-b"));
    await Deno.writeTextFile(
      join(dsPath, "data", "model-b", "raw"),
      "solo",
    );

    const catalogPath = catalogDbPath(repoDir);
    const catalogStore = new CatalogStore(catalogPath);

    try {
      const ctx = createLibSwampContext({});
      const deps = buildDeps(dsPath, namespace, catalogStore);
      const events = await collect<NamespaceMigrateEvent>(
        datastoreNamespaceMigrate(ctx, deps, {
          confirm: false,
          reverse: true,
        }),
      );

      assertEquals(events.length, 1);
      assertEquals(events[0].kind, "error");
      if (events[0].kind === "error") {
        assertEquals(events[0].error.code, "validation_failed");
      }
    } finally {
      catalogStore.close();
    }
  });
});

Deno.test("namespace migrate: skips subdirs that don't exist in source", async () => {
  await withTempDir(async (root) => {
    const dsPath = join(root, "ds");
    const repoDir = join(root, "repo");
    const namespace = "infra";

    await ensureDir(join(repoDir, ".swamp"));

    // Only create "data" — the other 15 subdirs don't exist
    await ensureDir(join(dsPath, "data"));
    await Deno.writeTextFile(join(dsPath, "data", "test.json"), "{}");

    const catalogPath = catalogDbPath(repoDir);
    const catalogStore = new CatalogStore(catalogPath);

    try {
      const ctx = createLibSwampContext({});
      const deps = buildDeps(dsPath, namespace, catalogStore);
      const events = await collect<NamespaceMigrateEvent>(
        datastoreNamespaceMigrate(ctx, deps, {
          confirm: true,
          reverse: false,
        }),
      );

      const preview = events.find((e) => e.kind === "preview");
      if (preview?.kind === "preview") {
        assertEquals(preview.data.directories.length, 1);
        assertEquals(preview.data.directories[0].subdir, "data");
      }

      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.migratedDirectories, ["data"]);
      }

      // Only "data" should have moved
      assertEquals(await dirExists(join(dsPath, namespace, "data")), true);
      assertEquals(await dirExists(join(dsPath, "data")), false);

      // All other subdirs should not exist at either path
      for (const subdir of DEFAULT_DATASTORE_SUBDIRS) {
        if (subdir === "data") continue;
        assertEquals(
          await dirExists(join(dsPath, subdir)),
          false,
        );
        assertEquals(
          await dirExists(join(dsPath, namespace, subdir)),
          false,
        );
      }
    } finally {
      catalogStore.close();
    }
  });
});
