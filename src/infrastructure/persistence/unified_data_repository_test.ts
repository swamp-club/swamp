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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
    await Deno.remove(tmpDir, { recursive: true });
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
