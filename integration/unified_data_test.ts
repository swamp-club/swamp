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

/**
 * Integration tests for the UnifiedDataRepository.
 *
 * Tests the full flow:
 * 1. Create data with versioning
 * 2. Verify ownership enforcement
 * 3. Test streaming data
 */

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { existsSync } from "@std/fs";
import { ensureDir } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import type { OwnerDefinition } from "../src/domain/data/data_metadata.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import {
  FileSystemUnifiedDataRepository,
  OwnershipValidationError,
} from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-unified-data-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
}

function createOwner(ref: string): OwnerDefinition {
  return {
    ownerType: "model-method",
    ownerRef: ref,
  };
}

// ============================================================================
// Basic CRUD Operations
// ============================================================================

Deno.test("Integration: save creates directory structure and symlink", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:create");

    const data = Data.create({
      name: "test-data",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    const content = new TextEncoder().encode("Hello, World!");
    const result = await repo.save(type, modelId, data, content);

    assertEquals(result.version, 1);

    // Verify directory structure
    const baseDir = join(
      repoDir,
      ".swamp",
      "data",
      type.toDirectoryPath(),
      modelId,
      "test-data",
    );
    assertEquals(existsSync(join(baseDir, "1")), true);
    assertEquals(existsSync(join(baseDir, "1", "metadata.yaml")), true);
    assertEquals(existsSync(join(baseDir, "1", "raw")), true);
    assertEquals(existsSync(join(baseDir, "latest")), true);

    // Verify content
    const savedContent = await Deno.readFile(join(baseDir, "1", "raw"));
    assertEquals(new TextDecoder().decode(savedContent), "Hello, World!");
  });
});

Deno.test("Integration: save auto-increments version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:version");

    const data = Data.create({
      name: "versioned-data",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    // Save version 1
    const result1 = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode("v1"),
    );
    assertEquals(result1.version, 1);

    // Save version 2
    const result2 = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode("v2"),
    );
    assertEquals(result2.version, 2);

    // Save version 3
    const result3 = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode("v3"),
    );
    assertEquals(result3.version, 3);

    // Verify latest points to v3
    const latest = await repo.findByName(type, modelId, "versioned-data");
    assertEquals(latest?.version, 3);
  });
});

Deno.test("Integration: save validates ownership", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner1 = createOwner("test/model:owner1");
    const owner2 = createOwner("test/model:owner2");

    // Save with owner1
    const data1 = Data.create({
      name: "owned-data",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner1,
    });
    await repo.save(type, modelId, data1, new TextEncoder().encode("owner1"));

    // Try to save with owner2 - should fail
    const data2 = Data.create({
      name: "owned-data",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner2,
    });

    await assertRejects(
      () => repo.save(type, modelId, data2, new TextEncoder().encode("owner2")),
      OwnershipValidationError,
      "Ownership validation failed",
    );

    // Same owner should succeed
    const result = await repo.save(
      type,
      modelId,
      data1,
      new TextEncoder().encode("owner1 again"),
    );
    assertEquals(result.version, 2);
  });
});

// ============================================================================
// Find Operations
// ============================================================================

Deno.test("Integration: findByName returns latest version by default", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:find");

    const data = Data.create({
      name: "find-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await repo.save(type, modelId, data, new TextEncoder().encode("v1"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v2"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v3"));

    const found = await repo.findByName(type, modelId, "find-test");
    assertEquals(found?.version, 3);
  });
});

Deno.test("Integration: findByName returns specific version when requested", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:find");

    const data = Data.create({
      name: "version-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await repo.save(type, modelId, data, new TextEncoder().encode("v1"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v2"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v3"));

    const v1 = await repo.findByName(type, modelId, "version-test", 1);
    assertEquals(v1?.version, 1);

    const v2 = await repo.findByName(type, modelId, "version-test", 2);
    assertEquals(v2?.version, 2);
  });
});

Deno.test("Integration: listVersions returns sorted version list", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:list");

    const data = Data.create({
      name: "list-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await repo.save(type, modelId, data, new TextEncoder().encode("v1"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v2"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v3"));

    const versions = await repo.listVersions(type, modelId, "list-test");
    assertEquals(versions, [1, 2, 3]);
  });
});

Deno.test("Integration: findAllForModel returns all data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:all");

    const data1 = Data.create({
      name: "data-1",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    const data2 = Data.create({
      name: "data-2",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "log" },
      ownerDefinition: owner,
    });

    await repo.save(type, modelId, data1, new TextEncoder().encode("content1"));
    await repo.save(type, modelId, data2, new TextEncoder().encode("content2"));

    const all = await repo.findAllForModel(type, modelId);
    assertEquals(all.length, 2);
    assertEquals(
      all.map((d) => d.name).sort(),
      ["data-1", "data-2"],
    );
  });
});

// ============================================================================
// Content Operations
// ============================================================================

Deno.test("Integration: getContent returns data content", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:content");

    const data = Data.create({
      name: "content-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    const originalContent = "Hello, World!";
    await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(originalContent),
    );

    const content = await repo.getContent(type, modelId, "content-test");
    assertEquals(new TextDecoder().decode(content!), originalContent);
  });
});

Deno.test("Integration: stream returns content chunks", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:stream");

    const data = Data.create({
      name: "stream-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    const originalContent = "Hello, World!";
    await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(originalContent),
    );

    const chunks: Uint8Array[] = [];
    for await (const chunk of repo.stream(type, modelId, "stream-test")) {
      chunks.push(chunk);
    }

    const combined = new Uint8Array(
      chunks.reduce((acc, chunk) => acc + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    assertEquals(new TextDecoder().decode(combined), originalContent);
  });
});

// ============================================================================
// Streaming Data
// ============================================================================

Deno.test("Integration: append works for streaming data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:append");

    const data = Data.create({
      name: "append-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      streaming: true,
      tags: { type: "log" },
      ownerDefinition: owner,
    });

    // Save initial content
    await repo.save(type, modelId, data, new TextEncoder().encode("line1\n"));

    // Append more content
    await repo.append(
      type,
      modelId,
      "append-test",
      new TextEncoder().encode("line2\n"),
    );
    await repo.append(
      type,
      modelId,
      "append-test",
      new TextEncoder().encode("line3\n"),
    );

    // Verify content
    const content = await repo.getContent(type, modelId, "append-test");
    assertEquals(new TextDecoder().decode(content!), "line1\nline2\nline3\n");

    // Verify size is correct after appends
    const found = await repo.findByName(type, modelId, "append-test");
    assertEquals(found?.size, "line1\nline2\nline3\n".length);

    // Checksum should be removed after append (content changed, old checksum is stale)
    assertEquals(found?.checksum, undefined);
  });
});

// ============================================================================
// Delete Operations
// ============================================================================

Deno.test("Integration: delete removes specific version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:delete");

    const data = Data.create({
      name: "delete-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await repo.save(type, modelId, data, new TextEncoder().encode("v1"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v2"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v3"));

    // Delete v2
    await repo.delete(type, modelId, "delete-test", 2);

    const versions = await repo.listVersions(type, modelId, "delete-test");
    assertEquals(versions, [1, 3]);
  });
});

Deno.test("Integration: delete removes all versions when no version specified", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:delete-all");

    const data = Data.create({
      name: "delete-all-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await repo.save(type, modelId, data, new TextEncoder().encode("v1"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v2"));

    // Delete all versions
    await repo.delete(type, modelId, "delete-all-test");

    const found = await repo.findByName(type, modelId, "delete-all-test");
    assertEquals(found, null);
  });
});

// ============================================================================
// Garbage Collection
// ============================================================================

Deno.test("Integration: collectGarbage removes old versions by count", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:gc");

    // Create data with keep 2 versions policy
    const data = Data.create({
      name: "gc-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 2,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    await repo.save(type, modelId, data, new TextEncoder().encode("v1"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v2"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v3"));
    await repo.save(type, modelId, data, new TextEncoder().encode("v4"));

    const result = await repo.collectGarbage(type, modelId);

    assertEquals(result.versionsRemoved, 2);
    const versions = await repo.listVersions(type, modelId, "gc-test");
    assertEquals(versions, [3, 4]);
  });
});

// ============================================================================
// Full Lifecycle Test
// ============================================================================

Deno.test("Integration: full lifecycle - create, write versions, read by version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:lifecycle");

    // Create initial data
    const data = Data.create({
      name: "lifecycle-test",
      contentType: "application/json",
      lifetime: "7d",
      garbageCollection: 10,
      tags: { type: "state", environment: "test" },
      ownerDefinition: owner,
    });

    // Write version 1
    const v1Content = { version: 1, message: "Initial state" };
    await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify(v1Content)),
    );

    // Write version 2
    const v2Content = { version: 2, message: "Updated state" };
    await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify(v2Content)),
    );

    // Read latest (v2)
    const latest = await repo.findByName(type, modelId, "lifecycle-test");
    assertEquals(latest?.version, 2);
    const latestContent = await repo.getContent(
      type,
      modelId,
      "lifecycle-test",
    );
    assertEquals(
      JSON.parse(new TextDecoder().decode(latestContent!)),
      v2Content,
    );

    // Read specific version (v1)
    const v1 = await repo.findByName(type, modelId, "lifecycle-test", 1);
    assertEquals(v1?.version, 1);
    const v1Data = await repo.getContent(type, modelId, "lifecycle-test", 1);
    assertEquals(JSON.parse(new TextDecoder().decode(v1Data!)), v1Content);

    // Verify metadata
    assertEquals(latest?.contentType, "application/json");
    assertEquals(latest?.lifetime, "7d");
    assertEquals(latest?.garbageCollection, 10);
    assertEquals(latest?.tags.type, "state");
    assertEquals(latest?.tags.environment, "test");
  });
});
