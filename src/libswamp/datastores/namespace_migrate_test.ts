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
    dirExists: () => Promise.resolve(false),
    dirSize: () => Promise.resolve({ fileCount: 0, totalBytes: 0 }),
    renameDir: () => Promise.resolve(),
    ensureDir: () => Promise.resolve(),
    invalidateCatalog: () => {},
    markDirtyBulk: () => Promise.resolve(),
    removeNamespaceManifest: () => Promise.resolve(),
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

Deno.test("datastoreNamespaceMigrate: errors when no data directories exist", async () => {
  const ctx = createLibSwampContext({});
  const deps = makeDeps();
  const events = await collect<NamespaceMigrateEvent>(
    datastoreNamespaceMigrate(ctx, deps, { confirm: false, reverse: false }),
  );
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "error");
  if (events[0].kind === "error") {
    assertStringIncludes(events[0].error.message, "No data directories found");
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
