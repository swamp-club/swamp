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
 * Integration tests for data ownership enforcement.
 *
 * Tests the full flow:
 * 1. Create data with owner definition
 * 2. Attempt unauthorized data write
 * 3. Verify ownership validation rejects unauthorized updates
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
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
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-ownership-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
}

function createOwner(
  ownerType: "model-method" | "workflow-step" | "manual",
  ref: string,
  workflowId?: string,
  workflowRunId?: string,
): OwnerDefinition {
  return {
    ownerType,
    ownerRef: ref,
    workflowId,
    workflowRunId,
  };
}

// ============================================================================
// Basic Ownership
// ============================================================================

Deno.test("Data Ownership: create data with model-method owner", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("model-method", "test/model:create");

    const data = Data.create({
      name: "owned-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    const result = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ value: 1 })),
    );

    assertEquals(result.version, 1);

    // Verify owner is stored
    const loaded = await repo.findByName(type, modelId, "owned-data");
    assertExists(loaded);
    assertExists(loaded.ownerDefinition);
    assertEquals(loaded.ownerDefinition.ownerType, "model-method");
    assertEquals(loaded.ownerDefinition.ownerRef, "test/model:create");
  });
});

Deno.test("Data Ownership: create data with workflow-step owner", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const workflowRunId = crypto.randomUUID();
    const owner = createOwner(
      "workflow-step",
      "my-workflow:build-job:compile-step",
      workflowId,
      workflowRunId,
    );

    const data = Data.create({
      name: "workflow-owned",
      contentType: "application/json",
      lifetime: "workflow",
      garbageCollection: 5,
      tags: { type: "resource", source: "step-output" },
      ownerDefinition: owner,
    });

    const result = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ output: "compiled" })),
    );

    assertEquals(result.version, 1);

    const loaded = await repo.findByName(type, modelId, "workflow-owned");
    assertExists(loaded);
    assertEquals(loaded.ownerDefinition.ownerType, "workflow-step");
    assertEquals(loaded.ownerDefinition.workflowId, workflowId);
    assertEquals(loaded.ownerDefinition.workflowRunId, workflowRunId);
  });
});

Deno.test("Data Ownership: create data with manual owner", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("manual", "user:admin@example.com");

    const data = Data.create({
      name: "manual-data",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "config" },
      ownerDefinition: owner,
    });

    const result = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode("manual content"),
    );

    assertEquals(result.version, 1);

    const loaded = await repo.findByName(type, modelId, "manual-data");
    assertExists(loaded);
    assertEquals(loaded.ownerDefinition.ownerType, "manual");
    assertEquals(loaded.ownerDefinition.ownerRef, "user:admin@example.com");
  });
});

// ============================================================================
// Ownership Validation
// ============================================================================

Deno.test("Data Ownership: same owner can write new versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("model-method", "test/model:update");

    const data = Data.create({
      name: "update-test",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "state" },
      ownerDefinition: owner,
    });

    // First write
    const result1 = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ version: 1 })),
    );
    assertEquals(result1.version, 1);

    // Second write with same owner
    const result2 = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ version: 2 })),
    );
    assertEquals(result2.version, 2);

    // Third write with same owner
    const result3 = await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode(JSON.stringify({ version: 3 })),
    );
    assertEquals(result3.version, 3);
  });
});

Deno.test("Data Ownership: different owner is rejected", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();

    const owner1 = createOwner(
      "model-method",
      "test/model:original-owner",
    );
    const owner2 = createOwner(
      "model-method",
      "test/model:different-owner",
    );

    // Create data with owner1
    const data1 = Data.create({
      name: "protected-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "protected" },
      ownerDefinition: owner1,
    });

    await repo.save(
      type,
      modelId,
      data1,
      new TextEncoder().encode(JSON.stringify({ owner: "original" })),
    );

    // Try to write with owner2 - should fail
    const data2 = Data.create({
      name: "protected-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "protected" },
      ownerDefinition: owner2,
    });

    await assertRejects(
      () =>
        repo.save(
          type,
          modelId,
          data2,
          new TextEncoder().encode(JSON.stringify({ owner: "attacker" })),
        ),
      OwnershipValidationError,
      "Ownership validation failed",
    );

    // Verify original data is unchanged
    const loaded = await repo.findByName(type, modelId, "protected-data");
    assertExists(loaded);
    assertEquals(loaded.version, 1);
  });
});

Deno.test("Data Ownership: different owner type is rejected", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();

    // Same ref, different type
    const modelOwner = createOwner("model-method", "shared-ref");
    const workflowOwner = createOwner("workflow-step", "shared-ref");

    // Create with model-method owner
    const data1 = Data.create({
      name: "type-protected",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: modelOwner,
    });

    await repo.save(
      type,
      modelId,
      data1,
      new TextEncoder().encode("original"),
    );

    // Try to write with workflow-step owner - should fail
    const data2 = Data.create({
      name: "type-protected",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: workflowOwner,
    });

    await assertRejects(
      () =>
        repo.save(
          type,
          modelId,
          data2,
          new TextEncoder().encode("malicious"),
        ),
      OwnershipValidationError,
    );
  });
});

Deno.test("Data Ownership: modified ownerRef is rejected", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();

    const owner = createOwner("model-method", "test/model:original");

    const data = Data.create({
      name: "ref-protected",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    await repo.save(
      type,
      modelId,
      data,
      new TextEncoder().encode("original"),
    );

    // Try with modified owner ref but keeping same type
    const modifiedOwner = createOwner(
      "model-method",
      "test/model:modified",
    );

    const dataWithModifiedOwner = Data.create({
      name: "ref-protected",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: modifiedOwner,
    });

    await assertRejects(
      () =>
        repo.save(
          type,
          modelId,
          dataWithModifiedOwner,
          new TextEncoder().encode("tampered"),
        ),
      OwnershipValidationError,
    );
  });
});

// ============================================================================
// Multiple Data Items with Different Owners
// ============================================================================

Deno.test("Data Ownership: multiple data items can have different owners", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();

    const owner1 = createOwner("model-method", "test/model:method1");
    const owner2 = createOwner("model-method", "test/model:method2");
    const owner3 = createOwner("workflow-step", "workflow:step1");

    // Create data with owner1
    const data1 = Data.create({
      name: "method1-data",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "output" },
      ownerDefinition: owner1,
    });

    // Create data with owner2
    const data2 = Data.create({
      name: "method2-data",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "output" },
      ownerDefinition: owner2,
    });

    // Create data with owner3
    const data3 = Data.create({
      name: "workflow-data",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource", source: "step-output" },
      ownerDefinition: owner3,
    });

    await repo.save(
      type,
      modelId,
      data1,
      new TextEncoder().encode("from method1"),
    );
    await repo.save(
      type,
      modelId,
      data2,
      new TextEncoder().encode("from method2"),
    );
    await repo.save(
      type,
      modelId,
      data3,
      new TextEncoder().encode("from workflow"),
    );

    // Each owner can update their own data
    await repo.save(
      type,
      modelId,
      data1,
      new TextEncoder().encode("method1 v2"),
    );
    await repo.save(
      type,
      modelId,
      data2,
      new TextEncoder().encode("method2 v2"),
    );
    await repo.save(
      type,
      modelId,
      data3,
      new TextEncoder().encode("workflow v2"),
    );

    // Cross-owner updates should fail
    const crossData = Data.create({
      name: "method1-data", // Trying to update owner1's data
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "output" },
      ownerDefinition: owner2, // But using owner2
    });

    await assertRejects(
      () =>
        repo.save(type, modelId, crossData, new TextEncoder().encode("cross")),
      OwnershipValidationError,
    );
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("Data Ownership: new data with non-existing name succeeds", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();

    // Different owners for different data items - all should succeed
    const owners = await Promise.all([
      createOwner("model-method", "ref1"),
      createOwner("model-method", "ref2"),
      createOwner("model-method", "ref3"),
    ]);

    for (let i = 0; i < owners.length; i++) {
      const data = Data.create({
        name: `unique-data-${i}`,
        contentType: "text/plain",
        lifetime: "infinite",
        garbageCollection: 5,
        tags: { type: "test" },
        ownerDefinition: owners[i],
      });

      const result = await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(`content ${i}`),
      );
      assertEquals(result.version, 1);
    }

    // All data exists
    const allData = await repo.findAllForModel(type, modelId);
    assertEquals(allData.length, 3);
  });
});

Deno.test("Data Ownership: same ownerType+ownerRef matches regardless of other fields", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();

    // Create data with one owner
    const owner1 = createOwner("model-method", "test/model:method");

    const data1 = Data.create({
      name: "factory-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner1,
    });

    await repo.save(
      type,
      modelId,
      data1,
      new TextEncoder().encode(JSON.stringify({ input: "first" })),
    );

    // Create data with same ownerType+ownerRef (simulates factory pattern
    // where different inputs produce different content but same logical owner)
    const owner2 = createOwner("model-method", "test/model:method");

    const data2 = Data.create({
      name: "factory-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner2,
    });

    // Should succeed because ownerType + ownerRef match
    const result = await repo.save(
      type,
      modelId,
      data2,
      new TextEncoder().encode(JSON.stringify({ input: "second" })),
    );
    assertEquals(result.version, 2);
  });
});

Deno.test("Data Ownership: rejected write doesn't corrupt existing data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();

    const originalOwner = createOwner("model-method", "original");
    const attackerOwner = createOwner("model-method", "attacker");

    // Create original data
    const originalData = Data.create({
      name: "valuable-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "important" },
      ownerDefinition: originalOwner,
    });

    const originalContent = JSON.stringify({
      secret: "valuable-secret",
      critical: true,
    });

    await repo.save(
      type,
      modelId,
      originalData,
      new TextEncoder().encode(originalContent),
    );

    // Attempt unauthorized write
    const maliciousData = Data.create({
      name: "valuable-data",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "important" },
      ownerDefinition: attackerOwner,
    });

    const maliciousContent = JSON.stringify({ secret: "corrupted" });

    try {
      await repo.save(
        type,
        modelId,
        maliciousData,
        new TextEncoder().encode(maliciousContent),
      );
    } catch {
      // Expected to fail
    }

    // Verify original data is intact
    const loaded = await repo.findByName(type, modelId, "valuable-data");
    assertExists(loaded);
    assertEquals(loaded.version, 1);

    const content = await repo.getContent(type, modelId, "valuable-data");
    assertExists(content);
    assertEquals(new TextDecoder().decode(content), originalContent);
  });
});

Deno.test("Data Ownership: owner persists across multiple versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("model-method", "persistent-owner");

    const data = Data.create({
      name: "multi-version",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write 5 versions
    for (let i = 1; i <= 5; i++) {
      await repo.save(type, modelId, data, new TextEncoder().encode(`v${i}`));
    }

    // Check owner on each version
    for (let v = 1; v <= 5; v++) {
      const loaded = await repo.findByName(type, modelId, "multi-version", v);
      assertExists(loaded);
      assertEquals(loaded.ownerDefinition.ownerType, "model-method");
      assertEquals(loaded.ownerDefinition.ownerRef, "persistent-owner");
    }
  });
});

// ============================================================================
// Ownership in Model Context
// ============================================================================

Deno.test("Data Ownership: different models can own data with same name", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");

    // Two different model instances
    const modelId1 = crypto.randomUUID();
    const modelId2 = crypto.randomUUID();

    const owner1 = createOwner("model-method", "model1:method");
    const owner2 = createOwner("model-method", "model2:method");

    // Same data name, different model instances, different owners
    const data1 = Data.create({
      name: "shared-name",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner1,
    });

    const data2 = Data.create({
      name: "shared-name",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner2,
    });

    // Both should succeed since they're different model instances
    await repo.save(
      type,
      modelId1,
      data1,
      new TextEncoder().encode("model1 data"),
    );
    await repo.save(
      type,
      modelId2,
      data2,
      new TextEncoder().encode("model2 data"),
    );

    // Verify each model has its own data
    const loaded1 = await repo.findByName(type, modelId1, "shared-name");
    assertExists(loaded1);
    assertEquals(loaded1.ownerDefinition.ownerRef, "model1:method");

    const loaded2 = await repo.findByName(type, modelId2, "shared-name");
    assertExists(loaded2);
    assertEquals(loaded2.ownerDefinition.ownerRef, "model2:method");
  });
});
