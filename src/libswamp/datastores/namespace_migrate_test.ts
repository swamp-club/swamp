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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  datastoreNamespaceMigrate,
  INFRASTRUCTURE_FILES,
  type MergeDirResult,
  type NamespaceMigrateDeps,
  type NamespaceMigrateEvent,
} from "./namespace_migrate.ts";

const DS_PATH = "/tmp/ds";
const NAMESPACE = "infra";

function makeDeps(
  overrides: Partial<NamespaceMigrateDeps> = {},
): NamespaceMigrateDeps {
  return {
    getDatastorePath: () => DS_PATH,
    getNamespace: () => NAMESPACE,
    getDatastoreDirectories: () => [],
    dirExists: () => Promise.resolve(false),
    dirHasDataFiles: () => Promise.resolve(false),
    dirContents: () => Promise.resolve({ catalogFiles: 0, otherEntries: 1 }),
    dirSize: () => Promise.resolve({ fileCount: 0, totalBytes: 0 }),
    renameDir: () => Promise.resolve(),
    mergeDirInto: (): Promise<MergeDirResult> =>
      Promise.resolve({ moved: 0, skipped: 0, skippedPaths: [] }),
    findFileCollisions: () => Promise.resolve([]),
    compareFiles: () => Promise.resolve(true),
    removeFile: () => Promise.resolve(),
    ensureDir: () => Promise.resolve(),
    removeOrphanedCatalogFiles: () => Promise.resolve(0),
    invalidateCatalog: () => {},
    markDirtyBulk: () => Promise.resolve(),
    removeNamespaceManifest: () => Promise.resolve(),
    listLocalNamespaces: () => Promise.resolve([]),
    isExtensionDatastore: false,
    ...overrides,
  };
}

Deno.test("datastoreNamespaceMigrate: errors when no namespace configured", async () => {
  const ctx = createLibSwampContext({});
  const deps = makeDeps({ getNamespace: () => undefined });
  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: false }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
  if (events[0].kind === "error") {
    assertStringIncludes(events[0].error.message, "No namespace is configured");
  }
});

Deno.test("datastoreNamespaceMigrate: yields preview and completed when no data directories exist", async () => {
  const ctx = createLibSwampContext({});
  const deps = makeDeps();
  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: false }),
  );
  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "preview");
  if (events[0].kind === "preview") {
    assertEquals(events[0].data.directories.length, 0);
    assertEquals(events[0].data.totalFiles, 0);
    assertEquals(events[0].data.totalBytes, 0);
  }
  assertEquals(events[1].kind, "completed");
  if (events[1].kind === "completed") {
    assertEquals(events[1].data.migratedDirectories.length, 0);
  }
});

Deno.test("datastoreNamespaceMigrate: dry-run yields preview and completed with no migrations", async () => {
  const ctx = createLibSwampContext({});
  const sourcePaths = new Set([
    join(DS_PATH, "data"),
    join(DS_PATH, "outputs"),
  ]);
  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(sourcePaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 10, totalBytes: 5000 }),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: false }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "preview");
  if (events[0].kind === "preview") {
    assertEquals(events[0].data.namespace, NAMESPACE);
    assertEquals(events[0].data.reverse, false);
    assertEquals(events[0].data.directories.length, 2);
    assertEquals(events[0].data.totalFiles, 20);
    assertEquals(events[0].data.totalBytes, 10000);

    const dataDir = events[0].data.directories.find((d) => d.subdir === "data");
    assertEquals(dataDir?.source, join(DS_PATH, "data"));
    assertEquals(dataDir?.destination, join(DS_PATH, NAMESPACE, "data"));
  }

  assertEquals(events[1].kind, "completed");
  if (events[1].kind === "completed") {
    assertEquals(events[1].data.migratedDirectories.length, 0);
  }
});

Deno.test("datastoreNamespaceMigrate: confirm executes forward migration", async () => {
  const ctx = createLibSwampContext({});
  const sourcePaths = new Set([
    join(DS_PATH, "data"),
    join(DS_PATH, "outputs"),
  ]);
  const renamed: Array<{ source: string; destination: string }> = [];
  const ensured: string[] = [];
  let catalogInvalidated = false;

  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(sourcePaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
    renameDir: (source, destination) => {
      renamed.push({ source, destination });
      return Promise.resolve();
    },
    ensureDir: (path) => {
      ensured.push(path);
      return Promise.resolve();
    },
    invalidateCatalog: () => {
      catalogInvalidated = true;
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const preview = events.find((e) => e.kind === "preview");
  assertEquals(preview?.kind, "preview");

  const progressEvents = events.filter((e) => e.kind === "progress");
  assertEquals(progressEvents.length, 2);

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.migratedDirectories, ["data", "outputs"]);
  }

  assertEquals(renamed.length, 2);
  assertEquals(renamed[0].source, join(DS_PATH, "data"));
  assertEquals(renamed[0].destination, join(DS_PATH, NAMESPACE, "data"));
  assertEquals(catalogInvalidated, true);
});

Deno.test("datastoreNamespaceMigrate: confirm executes reverse migration with manifest cleanup", async () => {
  const ctx = createLibSwampContext({});
  const existingDirs = new Set([
    join(DS_PATH, NAMESPACE, "data"),
  ]);
  const renamed: Array<{ source: string; destination: string }> = [];
  let manifestRemoved = "";

  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(existingDirs.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 3, totalBytes: 1000 }),
    renameDir: (source, destination) => {
      renamed.push({ source, destination });
      return Promise.resolve();
    },
    removeNamespaceManifest: (ns) => {
      manifestRemoved = ns;
      return Promise.resolve();
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: true }),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.reverse, true);
    assertEquals(completed.data.migratedDirectories, ["data"]);
  }

  assertEquals(renamed.length, 1);
  assertEquals(renamed[0].source, join(DS_PATH, NAMESPACE, "data"));
  assertEquals(renamed[0].destination, join(DS_PATH, "data"));
  assertEquals(manifestRemoved, NAMESPACE);
});

Deno.test("datastoreNamespaceMigrate: reverse refuses when un-namespaced path has content", async () => {
  const ctx = createLibSwampContext({});
  const deps = makeDeps({
    dirExists: () => Promise.resolve(true),
    dirHasDataFiles: () => Promise.resolve(true),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: true }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
  if (events[0].kind === "error") {
    assertStringIncludes(events[0].error.message, "Cannot reverse-migrate");
    assertStringIncludes(events[0].error.message, "already exists");
  }
});

Deno.test("datastoreNamespaceMigrate: partial failure reports succeeded and failed directories", async () => {
  const ctx = createLibSwampContext({});
  const sourcePaths = new Set([
    join(DS_PATH, "data"),
    join(DS_PATH, "outputs"),
  ]);
  let callCount = 0;

  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(sourcePaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
    renameDir: () => {
      callCount++;
      if (callCount === 2) {
        return Promise.reject(new Error("Permission denied"));
      }
      return Promise.resolve();
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertStringIncludes(errorEvent.error.message, "Permission denied");
    assertEquals(errorEvent.succeededDirectories, ["data"]);
    assertEquals(errorEvent.failedDirectory, "outputs");
  }
});

Deno.test("datastoreNamespaceMigrate: extension datastore calls markDirtyBulk", async () => {
  const ctx = createLibSwampContext({});
  const sourcePaths = new Set([join(DS_PATH, "data")]);
  let markedDirty = false;

  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(sourcePaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 1, totalBytes: 100 }),
    isExtensionDatastore: true,
    markDirtyBulk: () => {
      markedDirty = true;
      return Promise.resolve();
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind === "completed") {
    assertEquals(completed.data.isExtensionDatastore, true);
  }
  assertEquals(markedDirty, true);
});

Deno.test("datastoreNamespaceMigrate: skips nonexistent subdirs", async () => {
  const ctx = createLibSwampContext({});
  const sourcePaths = new Set([join(DS_PATH, "data")]);
  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(sourcePaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 1, totalBytes: 100 }),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: false }),
  );

  assertEquals(events[0].kind, "preview");
  if (events[0].kind === "preview") {
    assertEquals(events[0].data.directories.length, 1);
    assertEquals(events[0].data.directories[0].subdir, "data");
  }
});

Deno.test("datastoreNamespaceMigrate: pre-flight aborts on non-identical file collisions in forward migration", async () => {
  const ctx = createLibSwampContext({});
  const allPaths = new Set([
    join(DS_PATH, "data"),
    join(DS_PATH, NAMESPACE, "data"),
  ]);
  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(allPaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
    findFileCollisions: (_src, _dst) =>
      Promise.resolve(["model-a/latest.yaml", "model-b/v1.yaml"]),
    compareFiles: () => Promise.resolve(false),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
  if (events[0].kind === "error") {
    assertStringIncludes(events[0].error.message, "2 file(s) already exist");
    assertStringIncludes(events[0].error.message, "model-a/latest.yaml");
    assertStringIncludes(events[0].error.message, "model-b/v1.yaml");
    assertEquals(events[0].succeededDirectories, []);
  }
});

Deno.test("datastoreNamespaceMigrate: re-run after partial failure detects collisions before mutation", async () => {
  const ctx = createLibSwampContext({});
  const existingPaths = new Set([
    join(DS_PATH, "data"),
    join(DS_PATH, "outputs"),
    join(DS_PATH, NAMESPACE, "data"),
  ]);
  let renameCalled = false;
  let mergeCalled = false;

  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(existingPaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
    findFileCollisions: (src, _dst) => {
      if (src === join(DS_PATH, "data")) {
        return Promise.resolve(["colliding-file.yaml"]);
      }
      return Promise.resolve([]);
    },
    compareFiles: () => Promise.resolve(false),
    renameDir: () => {
      renameCalled = true;
      return Promise.resolve();
    },
    mergeDirInto: () => {
      mergeCalled = true;
      return Promise.resolve({ moved: 0, skipped: 0, skippedPaths: [] });
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const errorEvent = events.find((e) => e.kind === "error");
  assertEquals(errorEvent?.kind, "error");
  if (errorEvent?.kind === "error") {
    assertStringIncludes(
      errorEvent.error.message,
      "1 file(s) already exist",
    );
    assertStringIncludes(errorEvent.error.message, "colliding-file.yaml");
  }
  assertEquals(renameCalled, false);
  assertEquals(mergeCalled, false);
});

Deno.test("datastoreNamespaceMigrate: nested collisions across multiple subdirs are all reported", async () => {
  const ctx = createLibSwampContext({});
  const allPaths = new Set([
    join(DS_PATH, "data"),
    join(DS_PATH, NAMESPACE, "data"),
    join(DS_PATH, "outputs"),
    join(DS_PATH, NAMESPACE, "outputs"),
  ]);

  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(allPaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 3, totalBytes: 1000 }),
    findFileCollisions: (src, _dst) => {
      if (src === join(DS_PATH, "data")) {
        return Promise.resolve(["a/b/deep-file.yaml"]);
      }
      if (src === join(DS_PATH, "outputs")) {
        return Promise.resolve(["report.json"]);
      }
      return Promise.resolve([]);
    },
    compareFiles: () => Promise.resolve(false),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: false }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
  if (events[0].kind === "error") {
    assertStringIncludes(events[0].error.message, "2 file(s)");
    assertStringIncludes(events[0].error.message, "data/a/b/deep-file.yaml");
    assertStringIncludes(events[0].error.message, "outputs/report.json");
  }
});

Deno.test("datastoreNamespaceMigrate: mergeDirInto skipped files yield warning event", async () => {
  const ctx = createLibSwampContext({});
  const allPaths = new Set([
    join(DS_PATH, "data"),
    join(DS_PATH, NAMESPACE, "data"),
  ]);
  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(allPaths.has(path)),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
    findFileCollisions: () => Promise.resolve([]),
    mergeDirInto: () =>
      Promise.resolve({
        moved: 3,
        skipped: 1,
        skippedPaths: ["leftover.yaml"],
      }),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const warningEvent = events.find((e) => e.kind === "warning");
  assertEquals(warningEvent?.kind, "warning");
  if (warningEvent?.kind === "warning") {
    assertEquals(warningEvent.data.subdir, "data");
    assertEquals(warningEvent.data.skippedPaths, ["leftover.yaml"]);
    assertEquals(warningEvent.data.source, join(DS_PATH, "data"));
    assertEquals(
      warningEvent.data.destination,
      join(DS_PATH, NAMESPACE, "data"),
    );
  }

  const completedEvent = events.find((e) => e.kind === "completed");
  assertEquals(completedEvent?.kind, "completed");
});

Deno.test("datastoreNamespaceMigrate: no collision check on reverse migration", async () => {
  const ctx = createLibSwampContext({});
  const existingDirs = new Set([
    join(DS_PATH, NAMESPACE, "bundles"),
    join(DS_PATH, "bundles"),
  ]);
  let collisionCheckCalled = false;

  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(existingDirs.has(path)),
    dirHasDataFiles: () => Promise.resolve(false),
    dirSize: () => Promise.resolve({ fileCount: 3, totalBytes: 1000 }),
    findFileCollisions: () => {
      collisionCheckCalled = true;
      return Promise.resolve([]);
    },
    mergeDirInto: () =>
      Promise.resolve({ moved: 3, skipped: 0, skippedPaths: [] }),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: true }),
  );

  assertEquals(collisionCheckCalled, false);
  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
});

// ============================================================================
// Foreign data detection
// ============================================================================

Deno.test("datastoreNamespaceMigrate: forward migration blocked when foreign namespaces exist", async () => {
  const ctx = createLibSwampContext({});
  const deps = makeDeps({
    dirExists: () => Promise.resolve(true),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
    listLocalNamespaces: () => Promise.resolve(["infra", "other-project"]),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
  if (events[0].kind === "error") {
    assertStringIncludes(events[0].error.message, "other-project");
    assertStringIncludes(events[0].error.message, "absorbed during");
  }
});

Deno.test("datastoreNamespaceMigrate: forward migration allowed when only own namespace exists", async () => {
  const ctx = createLibSwampContext({});
  const deps = makeDeps({
    dirExists: () => Promise.resolve(true),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
    listLocalNamespaces: () => Promise.resolve(["infra"]),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: false }),
  );

  const preview = events.find((e) => e.kind === "preview");
  assertEquals(preview?.kind, "preview");
});

Deno.test("datastoreNamespaceMigrate: reverse migration not blocked by foreign namespaces", async () => {
  const ctx = createLibSwampContext({});
  const deps = makeDeps({
    dirExists: () => Promise.resolve(true),
    dirSize: () => Promise.resolve({ fileCount: 5, totalBytes: 2000 }),
    listLocalNamespaces: () => Promise.resolve(["infra", "other-project"]),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: true }),
  );

  const preview = events.find((e) => e.kind === "preview");
  assertEquals(preview?.kind, "preview");
});

Deno.test("datastoreNamespaceMigrate: forward migration deletes byte-identical collisions", async () => {
  const ctx = createLibSwampContext({});
  const removedFiles: string[] = [];

  const deps = makeDeps({
    dirExists: () => Promise.resolve(true),
    dirSize: () => Promise.resolve({ fileCount: 2, totalBytes: 100 }),
    findFileCollisions: () =>
      Promise.resolve(["data/file1.yaml", "data/file2.yaml"]),
    compareFiles: () => Promise.resolve(true),
    removeFile: (path: string) => {
      removedFiles.push(path);
      return Promise.resolve();
    },
    mergeDirInto: (): Promise<MergeDirResult> =>
      Promise.resolve({ moved: 0, skipped: 0, skippedPaths: [] }),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  assertEquals(removedFiles.length > 0, true);
});

Deno.test("datastoreNamespaceMigrate: forward migration errors on non-identical collisions", async () => {
  const ctx = createLibSwampContext({});

  const deps = makeDeps({
    dirExists: () => Promise.resolve(true),
    dirSize: () => Promise.resolve({ fileCount: 2, totalBytes: 100 }),
    findFileCollisions: () =>
      Promise.resolve(["data/file1.yaml", "data/file2.yaml"]),
    compareFiles: () => Promise.resolve(false),
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
  if (error?.kind === "error") {
    assertStringIncludes(
      error.error.message,
      "already exist at the destination",
    );
  }
});

Deno.test("datastoreNamespaceMigrate: forward migration with mixed identical and non-identical collisions errors", async () => {
  const ctx = createLibSwampContext({});
  let callCount = 0;

  const deps = makeDeps({
    dirExists: (path: string) => {
      if (path === join(DS_PATH, "data")) return Promise.resolve(true);
      if (path === join(DS_PATH, NAMESPACE, "data")) {
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    dirSize: () => Promise.resolve({ fileCount: 2, totalBytes: 100 }),
    findFileCollisions: () => Promise.resolve(["file1.yaml", "file2.yaml"]),
    compareFiles: () => {
      callCount++;
      return Promise.resolve(callCount <= 1);
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const error = events.find((e) => e.kind === "error");
  assertEquals(error?.kind, "error");
});

for (const reverse of [false, true]) {
  Deno.test(`datastoreNamespaceMigrate: refuses a namespace named after a layout directory before moving anything (reverse=${reverse})`, async () => {
    const touched: string[] = [];
    const deps = makeDeps({
      getNamespace: () => "data",
      dirExists: () => Promise.resolve(true),
      renameDir: (source) => {
        touched.push(source);
        return Promise.resolve();
      },
      mergeDirInto: (source) => {
        touched.push(source);
        return Promise.resolve({ moved: 0, skipped: 0, skippedPaths: [] });
      },
      removeFile: (path) => {
        touched.push(path);
        return Promise.resolve();
      },
    });
    const events = await collect<NamespaceMigrateEvent>(
      datastoreNamespaceMigrate(createLibSwampContext({}), deps, {
        confirm: true,
        reverse,
      }),
    );
    assertEquals(events.length, 1);
    assertEquals(events[0].kind, "error");
    if (events[0].kind === "error") {
      assertEquals(events[0].error.code, "validation_failed");
      assertStringIncludes(
        events[0].error.message,
        'Namespace "data" has the same name as a datastore layout directory',
      );
      assertStringIncludes(
        events[0].error.message,
        "swamp datastore namespace set <new-name>",
      );
      assertEquals(events[0].succeededDirectories, []);
    }
    assertEquals(touched, []);
  });
}

Deno.test("datastoreNamespaceMigrate: refuses a namespace equal to a configured datastore directory", async () => {
  const deps = makeDeps({
    getNamespace: () => "scratch",
    getDatastoreDirectories: () => ["data", "scratch"],
  });
  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(createLibSwampContext({}), deps, {
      confirm: true,
      reverse: false,
    }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
});

// --- the repo-local catalog is not datastore content (swamp-club#3316) ---

Deno.test("INFRASTRUCTURE_FILES: names the catalog and every SQLite sidecar", () => {
  assertEquals([...INFRASTRUCTURE_FILES].sort(), [
    "_catalog.db",
    "_catalog.db-journal",
    "_catalog.db-shm",
    "_catalog.db-wal",
  ]);
});

for (const reverse of [false, true]) {
  Deno.test(`datastoreNamespaceMigrate: a source holding only the catalog is nothing to move (reverse=${reverse})`, async () => {
    const ctx = createLibSwampContext({});
    const source = reverse
      ? join(DS_PATH, NAMESPACE, "data")
      : join(DS_PATH, "data");
    let moves = 0;
    const deps = makeDeps({
      dirExists: () => Promise.resolve(true),
      dirContents: (path) =>
        Promise.resolve(
          path === source
            ? { catalogFiles: 3, otherEntries: 0 }
            : { catalogFiles: 0, otherEntries: 0 },
        ),
      dirHasDataFiles: () => Promise.resolve(false),
      // The catalog would collide if the source were examined at all.
      findFileCollisions: (src) =>
        Promise.resolve(src === source ? ["_catalog.db"] : []),
      compareFiles: () => Promise.resolve(false),
      renameDir: () => {
        moves++;
        return Promise.resolve();
      },
      mergeDirInto: () => {
        moves++;
        return Promise.resolve({ moved: 0, skipped: 0, skippedPaths: [] });
      },
    });

    const events = await collect<NamespaceMigrateEvent>(
      datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse }),
    );

    const subdirs = events.flatMap((e) =>
      e.kind === "preview" ? e.data.directories.map((d) => d.subdir) : []
    );
    assertEquals(subdirs.includes("data"), false);
    assertEquals(events.some((e) => e.kind === "error"), false);
    const progressed = events.flatMap((e) =>
      e.kind === "progress" ? [e.data.subdir] : []
    );
    assertEquals(progressed.includes("data"), false);
    assertEquals(moves, progressed.length);
  });
}

Deno.test("datastoreNamespaceMigrate: re-run after a migration reports nothing to move", async () => {
  const ctx = createLibSwampContext({});
  // What a completed migration leaves behind: only the recreated catalog.
  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(path === join(DS_PATH, "data")),
    dirContents: () => Promise.resolve({ catalogFiles: 1, otherEntries: 0 }),
  });

  for (const confirm of [false, true]) {
    const events = await collect<NamespaceMigrateEvent>(
      datastoreNamespaceMigrate(ctx, deps, { confirm, reverse: false }),
    );
    assertEquals(events.map((e) => e.kind), ["preview", "completed"]);
    if (events[0].kind === "preview") {
      assertEquals(events[0].data.directories, []);
    }
  }
});

Deno.test("datastoreNamespaceMigrate: a source holding the catalog and data is merged, not renamed", async () => {
  const ctx = createLibSwampContext({});
  const sources = new Set([join(DS_PATH, "data"), join(DS_PATH, "outputs")]);
  const renamed: string[] = [];
  const merged: string[] = [];
  const ensured: string[] = [];
  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(sources.has(path)),
    dirContents: (path) =>
      Promise.resolve(
        path === join(DS_PATH, "data")
          ? { catalogFiles: 3, otherEntries: 2 }
          : { catalogFiles: 0, otherEntries: 2 },
      ),
    renameDir: (source) => {
      renamed.push(source);
      return Promise.resolve();
    },
    mergeDirInto: (source) => {
      merged.push(source);
      return Promise.resolve({ moved: 2, skipped: 0, skippedPaths: [] });
    },
    ensureDir: (path) => {
      ensured.push(path);
      return Promise.resolve();
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") throw new Error("expected completed");
  assertEquals(completed.data.migratedDirectories, ["data", "outputs"]);
  assertEquals(merged, [join(DS_PATH, "data")]);
  assertEquals(renamed, [join(DS_PATH, "outputs")]);
  assertEquals(ensured.includes(join(DS_PATH, NAMESPACE, "data")), true);
  assertEquals(ensured.includes(join(DS_PATH, NAMESPACE, "outputs")), false);
});

for (const reverse of [false, true]) {
  Deno.test(`datastoreNamespaceMigrate: confirm removes stale catalog copies from the namespace (reverse=${reverse})`, async () => {
    const ctx = createLibSwampContext({});
    const source = reverse
      ? join(DS_PATH, NAMESPACE, "outputs")
      : join(DS_PATH, "outputs");
    const calls: string[] = [];
    const deps = makeDeps({
      dirExists: (path) => Promise.resolve(path === source),
      removeOrphanedCatalogFiles: (dir) => {
        calls.push(dir);
        return Promise.resolve(3);
      },
    });

    await collect<NamespaceMigrateEvent>(
      datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse }),
    );
    assertEquals(calls, [], "preview must not delete");

    const events = await collect<NamespaceMigrateEvent>(
      datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse }),
    );
    assertEquals(events.at(-1)?.kind, "completed");
    assertEquals(calls, [join(DS_PATH, NAMESPACE, "data")]);
  });
}

Deno.test("datastoreNamespaceMigrate: stale catalog copies are removed when nothing is left to move", async () => {
  const ctx = createLibSwampContext({});
  const calls: string[] = [];
  const deps = makeDeps({
    removeOrphanedCatalogFiles: (dir) => {
      calls.push(dir);
      return Promise.resolve(1);
    },
  });

  await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: false }),
  );
  assertEquals(calls, [], "preview must not delete");

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );
  assertEquals(events.map((e) => e.kind), ["preview", "completed"]);
  assertEquals(calls, [join(DS_PATH, NAMESPACE, "data")]);
});

Deno.test("datastoreNamespaceMigrate: a failure to remove stale catalog copies does not fail the migration", async () => {
  const ctx = createLibSwampContext({});
  let catalogInvalidated = false;
  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(path === join(DS_PATH, "outputs")),
    removeOrphanedCatalogFiles: () =>
      Promise.reject(new Error("permission denied")),
    invalidateCatalog: () => {
      catalogInvalidated = true;
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  assertEquals(events.some((e) => e.kind === "error"), false);
  assertEquals(events.at(-1)?.kind, "completed");
  assertEquals(catalogInvalidated, true);
});

Deno.test("datastoreNamespaceMigrate: a failed move leaves stale catalog copies alone", async () => {
  const ctx = createLibSwampContext({});
  let removals = 0;
  const deps = makeDeps({
    dirExists: (path) => Promise.resolve(path === join(DS_PATH, "outputs")),
    renameDir: () => Promise.reject(new Error("Not a directory")),
    removeOrphanedCatalogFiles: () => {
      removals++;
      return Promise.resolve(0);
    },
  });

  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: true, reverse: false }),
  );

  assertEquals(events.at(-1)?.kind, "error");
  assertEquals(removals, 0);
});
