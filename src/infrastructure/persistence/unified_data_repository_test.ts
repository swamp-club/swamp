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

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  FileSystemUnifiedDataRepository,
  sortedSubdirectoryNames,
} from "./unified_data_repository.ts";
import { CatalogStore } from "./catalog_store.ts";
import { Data } from "../../domain/data/mod.ts";
import { createNamespace, SOLO_NAMESPACE } from "../../domain/data/mod.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { RenameForward } from "../../domain/data/repositories.ts";

const testType = ModelType.create("test/model");

/** Runs `fn` with a fresh repo dir and a catalog in it, removing both after. */
async function withTempRepo(
  fn: (repo: FileSystemUnifiedDataRepository) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  const catalogStore = new CatalogStore(join(dir, "_catalog.db"));
  try {
    await fn(new FileSystemUnifiedDataRepository(dir, undefined, catalogStore));
  } finally {
    catalogStore.close();
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("getPath rejects dataName with path traversal", async () => {
  await withTempRepo((repo) => {
    try {
      repo.getPath(testType, "valid-model", "../escape", 1);
      throw new Error("Expected path traversal error");
    } catch (e) {
      assertStringIncludes(
        (e as Error).message,
        "Path traversal detected",
      );
    }
  });
});

Deno.test("getPath rejects modelId with path traversal", async () => {
  await withTempRepo((repo) => {
    try {
      repo.getPath(testType, "../escape", "valid-data", 1);
      throw new Error("Expected path traversal error");
    } catch (e) {
      assertStringIncludes(
        (e as Error).message,
        "Path traversal detected",
      );
    }
  });
});

Deno.test("getPath accepts valid modelId and dataName", async () => {
  await withTempRepo((repo) => {
    const path = repo.getPath(testType, "my-model-id", "my-data-name", 1);
    assertStringIncludes(path, "my-model-id");
    assertStringIncludes(path, "my-data-name");
  });
});

Deno.test("listVersions rejects dataName with path traversal", async () => {
  await withTempRepo(async (repo) => {
    await assertRejects(
      () => repo.listVersions(testType, "valid-model", "../escape"),
      Error,
      "Path traversal detected",
    );
  });
});

Deno.test("findAllForModel: warns and returns empty for model name instead of UUID", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const result = await repo.findAllForModel(testType, "my-model-name");
    assertEquals(result, []);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContent: warns and returns null for model name instead of UUID", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const result = await repo.getContent(
      testType,
      "my-model-name",
      "some-data",
    );
    assertEquals(result, null);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

const owner = {
  ownerType: "model-method" as const,
  ownerRef: "test/model:test-method",
};

function makeData(name: string): Data {
  return Data.create({
    name,
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "test" },
    ownerDefinition: owner,
  });
}

Deno.test("concurrent allocateVersion returns unique versions", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("concurrent-alloc");
    const concurrency = 10;

    const results = await Promise.all(
      Array.from(
        { length: concurrency },
        () => repo.allocateVersion(testType, "model-1", data),
      ),
    );

    const versions = results.map((r) => r.version);
    const uniqueVersions = new Set(versions);
    assertEquals(
      uniqueVersions.size,
      concurrency,
      `Expected ${concurrency} unique versions, got ${uniqueVersions.size}: [${
        versions.join(", ")
      }]`,
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("concurrent save returns unique versions with distinct content", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("concurrent-save");
    const concurrency = 10;

    const results = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => {
        const content = new TextEncoder().encode(`content-${i}`);
        return repo.save(testType, "model-1", data, content);
      }),
    );

    // All versions must be unique
    const versions = results.map((r) => r.version);
    const uniqueVersions = new Set(versions);
    assertEquals(
      uniqueVersions.size,
      concurrency,
      `Expected ${concurrency} unique versions, got ${uniqueVersions.size}: [${
        versions.join(", ")
      }]`,
    );

    // All content must be preserved
    for (const version of versions) {
      const saved = await repo.getContent(
        testType,
        "model-1",
        "concurrent-save",
        version,
      );
      assertEquals(saved !== null, true, `Version ${version} content is null`);
    }
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save rejects reserved data name 'latest'", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("latest");
    const content = new TextEncoder().encode("test");

    await assertRejects(
      () => repo.save(testType, "model-1", data, content),
      Error,
      "reserved for internal use",
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save rejects reserved data name case-insensitively", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("LATEST");
    const content = new TextEncoder().encode("test");

    await assertRejects(
      () => repo.save(testType, "model-1", data, content),
      Error,
      "reserved for internal use",
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("allocateVersion rejects reserved data name 'latest'", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("latest");

    await assertRejects(
      () => repo.allocateVersion(testType, "model-1", data),
      Error,
      "reserved for internal use",
    );
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// ============================================================================
// Sync read methods
// ============================================================================

function makeJsonData(name: string): Data {
  return Data.create({
    name,
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: "resource" },
    ownerDefinition: owner,
  });
}

Deno.test("getLatestVersionSync reads latest symlink", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeJsonData("sync-latest");

    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode('{"v":1}'),
    );
    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode('{"v":2}'),
    );

    const latest = repo.getLatestVersionSync(
      testType,
      "model-1",
      "sync-latest",
    );
    assertEquals(latest, 2);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getLatestVersionSync returns null for missing data", async () => {
  await withTempRepo((repo) => {
    const result = repo.getLatestVersionSync(
      testType,
      "missing-model",
      "missing-data",
    );
    assertEquals(result, null);
  });
});

Deno.test("namespace defaults to SOLO_NAMESPACE and stamps catalog rows", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    assertEquals(repo.namespace, SOLO_NAMESPACE);

    await repo.save(
      testType,
      "model-1",
      makeData("solo-data"),
      new TextEncoder().encode("hi"),
    );

    const rows = [...catalogStore.iterate()];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].namespace, "");
    catalogStore.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("configured namespace round-trips into the catalog row", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      undefined,
      createNamespace("infra"),
    );
    assertEquals(repo.namespace, "infra");

    await repo.save(
      testType,
      "model-1",
      makeData("ns-data"),
      new TextEncoder().encode("hello"),
    );

    const rows = [...catalogStore.iterate()];
    assertEquals(rows.length, 1);
    assertEquals(rows[0].namespace, "infra");
    catalogStore.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findByNameSync reads metadata", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeJsonData("sync-find");

    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode('{"key":"value"}'),
    );

    const result = repo.findByNameSync(testType, "model-1", "sync-find");
    assertExists(result);
    assertEquals(result.name, "sync-find");
    assertEquals(result.contentType, "application/json");
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findByNameSync returns null for missing data", async () => {
  await withTempRepo((repo) => {
    const result = repo.findByNameSync(
      testType,
      "missing-model",
      "missing-data",
    );
    assertEquals(result, null);
  });
});

Deno.test("listVersionsSync returns sorted version numbers", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeJsonData("sync-list");

    for (let i = 0; i < 3; i++) {
      await repo.save(
        testType,
        "model-1",
        data,
        new TextEncoder().encode(`{"i":${i}}`),
      );
    }

    const versions = repo.listVersionsSync(testType, "model-1", "sync-list");
    assertEquals(versions, [1, 2, 3]);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("listVersionsSync returns empty for missing data", async () => {
  await withTempRepo((repo) => {
    const versions = repo.listVersionsSync(
      testType,
      "missing-model",
      "missing-data",
    );
    assertEquals(versions, []);
  });
});

Deno.test("getContentSync reads content bytes", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeJsonData("sync-content");
    const content = new TextEncoder().encode('{"hello":"world"}');

    await repo.save(testType, "model-1", data, content);

    const result = repo.getContentSync(testType, "model-1", "sync-content");
    assertExists(result);
    assertEquals(new TextDecoder().decode(result), '{"hello":"world"}');
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContentSync returns null for missing content", async () => {
  await withTempRepo((repo) => {
    const result = repo.getContentSync(
      testType,
      "missing-model",
      "missing-data",
    );
    assertEquals(result, null);
  });
});

Deno.test("findAllForModelSync returns all data items", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    const data1 = makeJsonData("item-a");
    const data2 = makeJsonData("item-b");

    await repo.save(
      testType,
      "model-1",
      data1,
      new TextEncoder().encode('{"a":1}'),
    );
    await repo.save(
      testType,
      "model-1",
      data2,
      new TextEncoder().encode('{"b":2}'),
    );

    const results = repo.findAllForModelSync(testType, "model-1");
    assertEquals(results.length, 2);
    const names = results.map((d) => d.name).sort();
    assertEquals(names, ["item-a", "item-b"]);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForModelSync returns empty for missing model", async () => {
  await withTempRepo((repo) => {
    const results = repo.findAllForModelSync(testType, "missing-model");
    assertEquals(results, []);
  });
});

Deno.test("findAllForType: returns data scoped to one model type", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    const otherType = ModelType.create("other/type");
    const data1 = makeJsonData("item-a");
    const data2 = makeJsonData("item-b");
    const data3 = makeJsonData("item-c");

    await repo.save(
      testType,
      "model-1",
      data1,
      new TextEncoder().encode('{"a":1}'),
    );
    await repo.save(
      otherType,
      "model-2",
      data2,
      new TextEncoder().encode('{"b":2}'),
    );
    await repo.save(
      testType,
      "model-3",
      data3,
      new TextEncoder().encode('{"c":3}'),
    );

    const results = await repo.findAllForType(testType);
    assertEquals(results.length, 2);
    const names = results.map((r) => r.data.name).sort();
    assertEquals(names, ["item-a", "item-c"]);
    for (const r of results) {
      assertEquals(r.modelType.normalized, testType.normalized);
    }
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForType: returns empty for missing type directory", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    const results = await repo.findAllForType(
      ModelType.create("nonexistent/type"),
    );
    assertEquals(results, []);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// Pins the markDirty contract from design/enablers/datastores.md: every public mutation
// that writes into the cache must call the sync service's markDirty hook before
// the write begins, so the fast-path sidecar cannot short-circuit past it. Also
// pins the per-call relPath granularity — pre-write notify sites (save, append,
// allocateVersion) pass the data-name directory because the version directory
// doesn't exist yet; finalizeVersion passes the version directory; delete
// passes the version dir or data-name dir based on whether a version was
// supplied; rename passes undefined (bulk); collectGarbage passes each version
// directory being removed (per-path, so the sync service can detect deletions).
//
// Regression coverage for the datastore fast-path contract violation that
// silently lost writes when the sidecar stayed clean.
Deno.test("mutations call markDirty before writing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );

    // save → data-name directory (version not yet allocated)
    const data = makeData("mark-dirty-save");
    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode("hello"),
    );
    assertEquals(calls.length, 1);
    assertEquals(
      calls[0],
      repo.getDataNameDir(testType, "model-1", "mark-dirty-save"),
    );

    // allocateVersion → data-name directory; finalizeVersion → version dir
    const data2 = makeData("mark-dirty-alloc");
    const { version, contentPath } = await repo.allocateVersion(
      testType,
      "model-1",
      data2,
    );
    assertEquals(calls.length, 2);
    assertEquals(
      calls[1],
      repo.getDataNameDir(testType, "model-1", "mark-dirty-alloc"),
    );
    await Deno.writeFile(contentPath, new TextEncoder().encode("direct"));
    await repo.finalizeVersion(testType, "model-1", data2, version);
    assertEquals(calls.length, 3);
    assertEquals(
      calls[2],
      repo.getPath(testType, "model-1", "mark-dirty-alloc", version),
    );

    // append → data-name directory (matches save/allocateVersion granularity).
    // notifyDirty fires before the streaming-configured check throws, so the
    // signal lands even though the operation aborts. Tolerate the throw.
    try {
      await repo.append(
        testType,
        "model-1",
        "mark-dirty-save",
        new TextEncoder().encode("more"),
      );
    } catch {
      // Expected — mark-dirty-save isn't streaming-configured.
    }
    assertEquals(calls.length, 4);
    assertEquals(
      calls[3],
      repo.getDataNameDir(testType, "model-1", "mark-dirty-save"),
    );
    const afterAppend = calls.length;

    // rename → old-name directory at entry. Internal save() emits a per-path
    // signal for the new name.
    await repo.rename(testType, "model-1", "mark-dirty-save", "mark-dirty-ren");
    if (calls.length < afterAppend + 2) {
      throw new Error(`rename did not call markDirty: ${calls.length}`);
    }
    assertEquals(
      calls[afterAppend],
      repo.getDataNameDir(testType, "model-1", "mark-dirty-save"),
      "rename's first markDirty call must be old-name directory",
    );
    // The inner save() emits a per-path signal for the new name. Verify by
    // looking for the new-name data-name directory in the subsequent calls.
    const renameTail = calls.slice(afterAppend + 1);
    const expectedRenameInner = repo.getDataNameDir(
      testType,
      "model-1",
      "mark-dirty-ren",
    );
    if (!renameTail.some((c) => c === expectedRenameInner)) {
      throw new Error(
        `rename's inner save() did not emit per-path signal for new name: ${
          JSON.stringify(renameTail)
        }`,
      );
    }
    const afterRename = calls.length;

    // delete with specific version → version directory
    await repo.delete(testType, "model-1", "mark-dirty-ren", 1);
    assertEquals(calls.length, afterRename + 1);
    assertEquals(
      calls[afterRename],
      repo.getPath(testType, "model-1", "mark-dirty-ren", 1),
    );

    // delete without version → latest marker file (data-name dir already
    // removed by the prior specific-version delete that left no versions;
    // listVersions returns [] so only the latest marker signal fires).
    await repo.delete(testType, "model-1", "mark-dirty-ren");
    assertEquals(calls.length, afterRename + 2);
    assertEquals(
      calls[afterRename + 1],
      join(
        repo.getDataNameDir(testType, "model-1", "mark-dirty-ren"),
        "latest",
      ),
    );

    // collectGarbage (live) with nothing to GC → no markDirty calls
    await repo.collectGarbage(testType, "model-1");
    assertEquals(
      calls.length,
      afterRename + 2,
      "collectGarbage with no excess versions must not call markDirty",
    );

    // collectGarbage (dry-run) must not notify — it does not touch the cache
    const before = calls.length;
    await repo.collectGarbage(testType, "model-1", { dryRun: true });
    assertEquals(calls.length, before);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("delete: full delete emits per-version markDirty signals", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );

    const data = makeData("multi-ver");
    await repo.save(testType, "m1", data, new TextEncoder().encode("v1"));
    await repo.save(testType, "m1", data, new TextEncoder().encode("v2"));
    await repo.save(testType, "m1", data, new TextEncoder().encode("v3"));
    calls.length = 0;

    await repo.delete(testType, "m1", "multi-ver");

    // Must emit one signal per version directory + one for the latest marker.
    const expectedVersionPaths = [1, 2, 3].map((v) =>
      repo.getPath(testType, "m1", "multi-ver", v)
    );
    const expectedLatest = join(
      repo.getDataNameDir(testType, "m1", "multi-ver"),
      "latest",
    );
    assertEquals(calls.length, 4);
    for (const vp of expectedVersionPaths) {
      assertStringIncludes(
        JSON.stringify(calls),
        JSON.stringify(vp),
      );
    }
    assertEquals(calls[3], expectedLatest);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("collectGarbage: emits per-path markDirty for each removed version", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );

    const gcData = Data.create({
      name: "gc-dirty",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 2,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    });

    for (let i = 0; i < 4; i++) {
      await repo.save(
        testType,
        "gc-model",
        gcData,
        new TextEncoder().encode(`v${i}`),
      );
    }

    calls.length = 0;

    const result = await repo.collectGarbage(testType, "gc-model");
    assertEquals(result.versionsRemoved, 2);

    const v1Dir = repo.getPath(testType, "gc-model", "gc-dirty", 1);
    const v2Dir = repo.getPath(testType, "gc-model", "gc-dirty", 2);
    const pruneCalls = calls.filter((c) => c === v1Dir || c === v2Dir);
    assertEquals(pruneCalls.length, 2);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("markDirty is not called on read paths", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: string[] = [];
    const markDirty = () => {
      calls.push("markDirty");
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
    );

    // Seed data with a write (counts as 1 call).
    const data = makeData("read-probe");
    await repo.save(
      testType,
      "model-1",
      data,
      new TextEncoder().encode("x"),
    );
    assertEquals(calls.length, 1);

    // All reads below must not increment the count.
    await repo.findAllGlobal();
    await repo.findByName(testType, "model-1", "read-probe");
    await repo.findAllForModel(testType, "model-1");
    await repo.listVersions(testType, "model-1", "read-probe");
    await repo.getContent(testType, "model-1", "read-probe");
    repo.findAllForModelSync(testType, "model-1");
    repo.findByNameSync(testType, "model-1", "read-probe");
    repo.getContentSync(testType, "model-1", "read-probe");
    assertEquals(calls.length, 1);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// ============================================================================
// findAllGlobalSince — mirrors the workflow-run repo tests so the three
// implementations of the same two-stage filter stay in lockstep.
// ============================================================================

async function withDataRepo(
  fn: (
    repo: FileSystemUnifiedDataRepository,
    tmpDir: string,
  ) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    await fn(repo, tmpDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
}

Deno.test("findAllGlobalSince: returns only in-window data items", async () => {
  await withDataRepo(async (repo) => {
    const old = makeData("old-data");
    await repo.save(testType, "model-1", old, new TextEncoder().encode("x"));

    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oldMetadataPath = repo.getMetadataPath(
      testType,
      "model-1",
      "old-data",
      1,
    );
    await Deno.utime(oldMetadataPath, oldDate, oldDate);

    const fresh = makeData("fresh-data");
    await repo.save(testType, "model-1", fresh, new TextEncoder().encode("y"));

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const found = await repo.findAllGlobalSince(cutoff);

    assertEquals(found.length, 1);
    assertEquals(found[0].data.name, "fresh-data");
  });
});

Deno.test(
  "findAllGlobalSince: file deleted mid-iteration is skipped, not fatal",
  async () => {
    await withDataRepo(async (repo) => {
      const keep = makeData("keep-data");
      await repo.save(testType, "model-1", keep, new TextEncoder().encode("x"));

      const doomed = makeData("doomed-data");
      await repo.save(
        testType,
        "model-1",
        doomed,
        new TextEncoder().encode("y"),
      );

      // Concurrent deletion of the doomed item's metadata file. The data
      // repo already wraps stat in per-file try/catch; this test pins
      // that behavior so future refactors don't lose it.
      await Deno.remove(
        repo.getMetadataPath(testType, "model-1", "doomed-data", 1),
      );

      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const found = await repo.findAllGlobalSince(cutoff);

      assertEquals(found.length, 1);
      assertEquals(found[0].data.name, "keep-data");
    });
  },
);

Deno.test("getContent: accepts string type parameter", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("string-type-content");
    const content = new TextEncoder().encode("hello");
    await repo.save(testType, "model-1", data, content);

    const result = await repo.getContent(
      "test/model",
      "model-1",
      "string-type-content",
    );
    assertExists(result);
    assertEquals(new TextDecoder().decode(result), "hello");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findByName: accepts string type parameter", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("string-type-find");
    const content = new TextEncoder().encode("data");
    await repo.save(testType, "model-1", data, content);

    const result = await repo.findByName(
      "test/model",
      "model-1",
      "string-type-find",
    );
    assertExists(result);
    assertEquals(result.name, "string-type-find");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("findAllForModel: accepts string type parameter", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    const data = makeData("string-type-all");
    const content = new TextEncoder().encode("data");
    await repo.save(testType, "model-1", data, content);

    const results = await repo.findAllForModel("test/model", "model-1");
    assertEquals(results.length, 1);
    assertEquals(results[0].name, "string-type-all");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContent: calls hydrateFile hook when raw file is missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const expectedContent = new TextEncoder().encode("hydrated-content");

    const hydrateFile = async (absPath: string): Promise<boolean> => {
      // Hook receives absolute path (same pattern as MarkDirtyHook)
      await Deno.mkdir(join(absPath, ".."), { recursive: true });
      await Deno.writeFile(absPath, expectedContent);
      return true;
    };

    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      hydrateFile,
    );

    // Create a data item with content, then delete the raw file to simulate
    // lazy hydration state (metadata exists but raw is missing)
    const data = makeData("hydrate-test");
    await repo.save(testType, "model-1", data, expectedContent);
    const contentPath = repo.getContentPath(
      testType,
      "model-1",
      "hydrate-test",
      1,
    );
    await Deno.remove(contentPath);

    // getContent should call hydrateFile and return the content
    const result = await repo.getContent(
      testType,
      "model-1",
      "hydrate-test",
      1,
    );
    assertExists(result);
    assertEquals(new TextDecoder().decode(result), "hydrated-content");
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContent: returns null when hydrateFile returns false", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));

    const hydrateFile = (_absPath: string): Promise<boolean> => {
      return Promise.resolve(false);
    };

    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      hydrateFile,
    );

    // Create a data item then delete the raw file
    const data = makeData("hydrate-fail");
    const content = new TextEncoder().encode("temp");
    await repo.save(testType, "model-1", data, content);
    const contentPath = repo.getContentPath(
      testType,
      "model-1",
      "hydrate-fail",
      1,
    );
    await Deno.remove(contentPath);

    // getContent should return null since hydrateFile returned false
    const result = await repo.getContent(
      testType,
      "model-1",
      "hydrate-fail",
      1,
    );
    assertEquals(result, null);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("getContent: returns null without hook when raw file is missing", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    // Create a data item then delete the raw file
    const data = makeData("no-hook");
    const content = new TextEncoder().encode("temp");
    await repo.save(testType, "model-1", data, content);
    const contentPath = repo.getContentPath(testType, "model-1", "no-hook", 1);
    await Deno.remove(contentPath);

    // Without hydrateFile hook, getContent returns null
    const result = await repo.getContent(testType, "model-1", "no-hook", 1);
    assertEquals(result, null);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save: does not prune versions without enableWriteGc", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );

    const data = Data.create({
      name: "no-prune",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 3,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    });

    for (let i = 0; i < 8; i++) {
      await repo.save(
        testType,
        "prune-model",
        data,
        new TextEncoder().encode(`v${i}`),
      );
    }

    const versions = await repo.listVersions(
      testType,
      "prune-model",
      "no-prune",
    );
    assertEquals(versions.length, 8);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save: prunes versions at write time with enableWriteGc", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      undefined,
      undefined,
      SOLO_NAMESPACE,
      true,
    );

    const data = Data.create({
      name: "capped",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 3,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    });

    for (let i = 0; i < 8; i++) {
      await repo.save(
        testType,
        "prune-model",
        data,
        new TextEncoder().encode(`v${i}`),
      );
    }

    const versions = await repo.listVersions(testType, "prune-model", "capped");
    assertEquals(versions.length, 3);
    assertEquals(versions, [6, 7, 8]);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

Deno.test("save: write-time pruning emits markDirty for each pruned version", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const calls: Array<string | undefined> = [];
    const markDirty = (relPath?: string) => {
      calls.push(relPath);
      return Promise.resolve();
    };
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
      markDirty,
      undefined,
      SOLO_NAMESPACE,
      true,
    );

    const data = Data.create({
      name: "dirty-prune",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 2,
      streaming: false,
      tags: { type: "resource" },
      ownerDefinition: { ownerType: "manual", ownerRef: "test" },
    });

    await repo.save(testType, "m", data, new TextEncoder().encode("a"));
    await repo.save(testType, "m", data, new TextEncoder().encode("b"));
    calls.length = 0;

    await repo.save(testType, "m", data, new TextEncoder().encode("c"));

    const v1Dir = repo.getPath(testType, "m", "dirty-prune", 1);
    const pruneMarkDirty = calls.filter((c) => c === v1Dir);
    assertEquals(pruneMarkDirty.length, 1);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// ============================================================================
// Numeric data names — models that key resources by an external numeric id
// (TMDB id, issue number) produce `{model-id}/{207333}/{1}/`, which the tree
// walk must not confuse with `{model-id}/{data-name}/{version}/`.
// ============================================================================

Deno.test(
  "findAllGlobal: finds data whose names are purely numeric",
  async () => {
    await withDataRepo(async (repo) => {
      for (const name of ["207333", "124364", "289324"]) {
        await repo.save(
          testType,
          "model-1",
          makeData(name),
          new TextEncoder().encode("x"),
        );
      }

      const found = await repo.findAllGlobal();

      assertEquals(found.length, 3);
      assertEquals(
        found.map((f) => f.data.name).sort(),
        ["124364", "207333", "289324"],
      );
      // The type must survive the walk intact — deriving it from a truncated
      // path is what silently drops these records.
      for (const f of found) {
        assertEquals(f.modelType.normalized, testType.normalized);
        assertEquals(f.modelId, "model-1");
      }
    });
  },
);

Deno.test(
  "findAllGlobalSync: finds data whose names are purely numeric",
  async () => {
    await withDataRepo(async (repo) => {
      await repo.save(
        testType,
        "model-1",
        makeData("207333"),
        new TextEncoder().encode("x"),
      );

      const found = repo.findAllGlobalSync();

      assertEquals(found.length, 1);
      assertEquals(found[0].data.name, "207333");
      assertEquals(found[0].modelType.normalized, testType.normalized);
      assertEquals(found[0].modelId, "model-1");
    });
  },
);

Deno.test(
  "findAllGlobal: numeric and named data coexist under one model",
  async () => {
    await withDataRepo(async (repo) => {
      await repo.save(
        testType,
        "model-1",
        makeData("207333"),
        new TextEncoder().encode("x"),
      );
      await repo.save(
        testType,
        "model-1",
        makeData("recommendations"),
        new TextEncoder().encode("y"),
      );

      const found = await repo.findAllGlobal();

      assertEquals(
        found.map((f) => f.data.name).sort(),
        ["207333", "recommendations"],
      );
    });
  },
);

async function withRenameRepo(
  fn: (
    repo: FileSystemUnifiedDataRepository,
    catalogStore: CatalogStore,
    modelId: string,
  ) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const catalogStore = new CatalogStore(join(tmpDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      tmpDir,
      undefined,
      catalogStore,
    );
    await fn(repo, catalogStore, crypto.randomUUID());
    catalogStore.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
}

Deno.test("rename: records the rename forward in the catalog", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "old", "new");

    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "old",
      ),
      "new",
    );
    assertEquals(
      [...catalogStore.iterate()].some((r) =>
        r.model_id === modelId && r.data_name === "old" && r.is_latest === 1
      ),
      false,
    );
  });
});

Deno.test("save: writing a renamed-away name again ends its forward", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("b"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "b", "c");
    await repo.save(testType, modelId, makeData("b"), new Uint8Array([2]));

    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "b",
      ),
      null,
    );
    assertEquals((await repo.findByName(testType, modelId, "b"))?.name, "b");
  });
});

Deno.test("findAllGlobal: reports each rename marker it follows past", async () => {
  await withRenameRepo(async (repo, _catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("x"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "x", "y");
    await repo.rename(testType, modelId, "y", "z");
    await repo.save(testType, modelId, makeData("plain"), new Uint8Array([2]));

    for (const sync of [false, true]) {
      const renames: RenameForward[] = [];
      const all = sync
        ? repo.findAllGlobalSync({ renames })
        : await repo.findAllGlobal({ renames });
      assertEquals(all.map((d) => d.data.name).sort(), ["plain", "z"]);
      assertEquals(
        renames.map((r) => [r.modelId, r.dataName, r.renamedTo]).sort(),
        [[modelId, "x", "y"], [modelId, "y", "z"]],
      );
    }
  });
});

Deno.test("rename: a failed forward write leaves the rename in place", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    catalogStore.recordRename = () => {
      throw new Error("database is locked");
    };

    const result = await repo.rename(testType, modelId, "old", "new");

    assertEquals(result.newName, "new");
    assertEquals(
      (await repo.findByName(testType, modelId, "old"))?.name,
      "new",
    );
    assertEquals(
      new TextDecoder().decode(
        (await repo.getContent(testType, modelId, "new"))!,
      ),
      "\x01",
    );
  });
});

Deno.test("delete: deleting a renamed name ends its forward", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "old", "new");
    await repo.delete(testType, modelId, "old");

    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "old",
      ),
      null,
    );
    assertEquals(await repo.findByName(testType, modelId, "old"), null);
  });
});

Deno.test("delete: deleting an old version keeps the forward of a rename marker that stays latest", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "old", "new");
    await repo.delete(testType, modelId, "old", 1);

    assertEquals(
      (await repo.findByName(testType, modelId, "old"))?.name,
      "new",
    );
    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "old",
      ),
      "new",
    );
    assertEquals(
      [...catalogStore.iterate()].some((r) =>
        r.model_id === modelId && r.data_name === "old" && r.is_latest === 1
      ),
      false,
      "the tombstone is not a catalog row",
    );
  });
});

Deno.test("removeLatestMarker: an expired renamed name ends its forward", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    await repo.save(testType, modelId, makeData("old"), new Uint8Array([1]));
    await repo.rename(testType, modelId, "old", "new");
    await repo.removeLatestMarker(testType, modelId, "old");

    assertEquals(
      catalogStore.findRenameTarget(
        SOLO_NAMESPACE,
        testType.normalized,
        modelId,
        "old",
      ),
      null,
    );
  });
});

Deno.test("delete: deleting an old version of an item with a deletion marker keeps its history rows", async () => {
  await withRenameRepo(async (repo, catalogStore, modelId) => {
    const data = makeData("r");
    await repo.save(testType, modelId, data, new Uint8Array([1]));
    await repo.save(testType, modelId, data, new Uint8Array([2]));
    const v2 = await repo.findByName(testType, modelId, "r");
    await repo.save(
      testType,
      modelId,
      v2!.withDeletionMarker({ version: v2!.version + 1 }),
      new TextEncoder().encode("{}"),
    );

    await repo.delete(testType, modelId, "r", 1);

    const versions = [...catalogStore.iterate()]
      .filter((r) => r.model_id === modelId && r.data_name === "r")
      .map((r) => r.version)
      .sort();
    assertEquals(versions, [2, 3]);
  });
});

Deno.test("sortedSubdirectoryNames: keeps only directories, in code-unit order", () => {
  const entries = [
    { name: "b", isDirectory: true },
    { name: "latest", isDirectory: false },
    { name: "a", isDirectory: true },
    { name: "Z", isDirectory: true },
    { name: "c", isDirectory: true },
  ];
  assertEquals(sortedSubdirectoryNames(entries), ["Z", "a", "b", "c"]);
});

/** Saves one JSON item per name under `modelId`, in the order given. */
async function saveNamed(
  repo: FileSystemUnifiedDataRepository,
  type: ModelType,
  modelId: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    await repo.save(
      type,
      modelId,
      makeJsonData(name),
      new TextEncoder().encode(`{"name":"${name}"}`),
    );
  }
}

Deno.test("findAllForModel: returns data in name order regardless of save order", async () => {
  await withTempRepo(async (repo) => {
    await saveNamed(repo, testType, "model-1", ["c", "a", "b"]);
    const names = (await repo.findAllForModel(testType, "model-1")).map((d) =>
      d.name
    );
    assertEquals(names, ["a", "b", "c"]);
    assertEquals(
      repo.findAllForModelSync(testType, "model-1").map((d) => d.name),
      ["a", "b", "c"],
    );
  });
});

Deno.test("findAllGlobal: walks types, model ids and data names in name order", async () => {
  await withTempRepo(async (repo) => {
    const otherType = ModelType.create("other/type");
    await saveNamed(repo, testType, "model-b", ["y", "x"]);
    await saveNamed(repo, otherType, "model-c", ["q"]);
    await saveNamed(repo, testType, "model-a", ["n", "m"]);
    const expected = [
      "other/type model-c q",
      "test/model model-a m",
      "test/model model-a n",
      "test/model model-b x",
      "test/model model-b y",
    ];
    const key = (
      r: { data: { name: string }; modelType: ModelType; modelId: string },
    ) => `${r.modelType.normalized} ${r.modelId} ${r.data.name}`;
    assertEquals((await repo.findAllGlobal()).map(key), expected);
    assertEquals(repo.findAllGlobalSync().map(key), expected);
    assertEquals(
      (await repo.findAllForType(testType)).map(key),
      expected.slice(1),
    );
  });
});
