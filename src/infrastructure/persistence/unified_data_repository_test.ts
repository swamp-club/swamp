// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { FileSystemUnifiedDataRepository } from "./unified_data_repository.ts";
import { CatalogStore } from "./catalog_store.ts";
import { Data } from "../../domain/data/mod.ts";
import { ModelType } from "../../domain/models/model_type.ts";

const testType = ModelType.create("test/model");

Deno.test("getPath rejects dataName with path traversal", () => {
  const catalogStore = new CatalogStore(join("/tmp/test-repo", "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/test-repo",
    undefined,
    catalogStore,
  );
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

Deno.test("getPath rejects modelId with path traversal", () => {
  const catalogStore = new CatalogStore(join("/tmp/test-repo", "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/test-repo",
    undefined,
    catalogStore,
  );
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

Deno.test("getPath accepts valid modelId and dataName", () => {
  const catalogStore = new CatalogStore(join("/tmp/test-repo", "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/test-repo",
    undefined,
    catalogStore,
  );
  const path = repo.getPath(testType, "my-model-id", "my-data-name", 1);
  assertStringIncludes(path, "my-model-id");
  assertStringIncludes(path, "my-data-name");
});

Deno.test("listVersions rejects dataName with path traversal", async () => {
  const catalogStore = new CatalogStore(join("/tmp/test-repo", "_catalog.db"));
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/test-repo",
    undefined,
    catalogStore,
  );
  await assertRejects(
    () => repo.listVersions(testType, "valid-model", "../escape"),
    Error,
    "Path traversal detected",
  );
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

Deno.test("getLatestVersionSync returns null for missing data", () => {
  const catalogStore = new CatalogStore(
    join("/tmp/nonexistent-repo", "_catalog.db"),
  );
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/nonexistent-repo",
    undefined,
    catalogStore,
  );
  const result = repo.getLatestVersionSync(
    testType,
    "missing-model",
    "missing-data",
  );
  assertEquals(result, null);
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

Deno.test("findByNameSync returns null for missing data", () => {
  const catalogStore = new CatalogStore(
    join("/tmp/nonexistent-repo", "_catalog.db"),
  );
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/nonexistent-repo",
    undefined,
    catalogStore,
  );
  const result = repo.findByNameSync(
    testType,
    "missing-model",
    "missing-data",
  );
  assertEquals(result, null);
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

Deno.test("listVersionsSync returns empty for missing data", () => {
  const catalogStore = new CatalogStore(
    join("/tmp/nonexistent-repo", "_catalog.db"),
  );
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/nonexistent-repo",
    undefined,
    catalogStore,
  );
  const versions = repo.listVersionsSync(
    testType,
    "missing-model",
    "missing-data",
  );
  assertEquals(versions, []);
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

Deno.test("getContentSync returns null for missing content", () => {
  const catalogStore = new CatalogStore(
    join("/tmp/nonexistent-repo", "_catalog.db"),
  );
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/nonexistent-repo",
    undefined,
    catalogStore,
  );
  const result = repo.getContentSync(
    testType,
    "missing-model",
    "missing-data",
  );
  assertEquals(result, null);
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

Deno.test("findAllForModelSync returns empty for missing model", () => {
  const catalogStore = new CatalogStore(
    join("/tmp/nonexistent-repo", "_catalog.db"),
  );
  const repo = new FileSystemUnifiedDataRepository(
    "/tmp/nonexistent-repo",
    undefined,
    catalogStore,
  );
  const results = repo.findAllForModelSync(testType, "missing-model");
  assertEquals(results, []);
});

// Pins the markDirty contract from design/datastores.md: every public mutation
// that writes into the cache must call the sync service's markDirty hook before
// the write begins, so the fast-path sidecar cannot short-circuit past it. Also
// pins the per-call relPath granularity — pre-write notify sites (save, append,
// allocateVersion) pass the data-name directory because the version directory
// doesn't exist yet; finalizeVersion passes the version directory; delete
// passes the version dir or data-name dir based on whether a version was
// supplied; rename and collectGarbage pass undefined (bulk).
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

    // rename → bulk (undefined) at entry. Internal save() emits a per-path
    // signal for the new name. Rule 8: bulk must arrive first within the
    // operation so extensions can correctly fall back to a full walk.
    await repo.rename(testType, "model-1", "mark-dirty-save", "mark-dirty-ren");
    if (calls.length < afterAppend + 2) {
      throw new Error(`rename did not call markDirty: ${calls.length}`);
    }
    assertEquals(
      calls[afterAppend],
      undefined,
      "rename's first markDirty call must be bulk (undefined relPath) — rule 8",
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

    // delete without version → data-name directory (whole subtree)
    await repo.delete(testType, "model-1", "mark-dirty-ren");
    assertEquals(calls.length, afterRename + 2);
    assertEquals(
      calls[afterRename + 1],
      repo.getDataNameDir(testType, "model-1", "mark-dirty-ren"),
    );

    // collectGarbage (live) → bulk (undefined)
    await repo.collectGarbage(testType, "model-1");
    assertEquals(calls.length, afterRename + 3);
    assertEquals(
      calls[afterRename + 2],
      undefined,
      "collectGarbage must use bulk relPath",
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
