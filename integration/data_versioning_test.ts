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
 * Integration tests for data versioning.
 *
 * Tests the full flow:
 * 1. Write multiple versions of same data
 * 2. Verify versioning works correctly
 * 3. Verify version retention settings (garbage collection)
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { ensureDir, existsSync } from "@std/fs";
import { Data } from "../src/domain/data/data.ts";
import type { OwnerDefinition } from "../src/domain/data/data_metadata.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { ModelResolver } from "../src/domain/expressions/model_resolver.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-versioning-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function setupRepoDir(dir: string): Promise<void> {
  await ensureDir(join(dir, ".swamp", "data"));
  await ensureDir(join(dir, "models"));
}

function createOwner(ref: string): OwnerDefinition {
  return {
    ownerType: "model-method",
    ownerRef: ref,
  };
}

// ============================================================================
// Write Multiple Versions
// ============================================================================

Deno.test("Data Versioning: write multiple versions of same data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:versioning");

    const data = Data.create({
      name: "versioned-state",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "state" },
      ownerDefinition: owner,
    });

    // Write 5 versions
    const versions: { version: number; content: string }[] = [];
    for (let i = 1; i <= 5; i++) {
      const content = JSON.stringify({ version: i, timestamp: Date.now() });
      const result = await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(content),
      );
      versions.push({ version: result.version, content });
    }

    // Verify all versions exist
    assertEquals(versions.length, 5);
    assertEquals(versions[0].version, 1);
    assertEquals(versions[4].version, 5);

    // List versions
    const versionList = await repo.listVersions(
      type,
      modelId,
      "versioned-state",
    );
    assertEquals(versionList, [1, 2, 3, 4, 5]);

    // Latest should be version 5
    const latest = await repo.findByName(type, modelId, "versioned-state");
    assertExists(latest);
    assertEquals(latest.version, 5);
  });
});

Deno.test("Data Versioning: retrieve specific versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:retrieve");

    const data = Data.create({
      name: "retrieve-test",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write 3 versions with different content
    const contents = [
      { step: 1, message: "first" },
      { step: 2, message: "second" },
      { step: 3, message: "third" },
    ];

    for (const content of contents) {
      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(JSON.stringify(content)),
      );
    }

    // Retrieve each specific version
    for (let v = 1; v <= 3; v++) {
      const found = await repo.findByName(type, modelId, "retrieve-test", v);
      assertExists(found);
      assertEquals(found.version, v);

      const content = await repo.getContent(type, modelId, "retrieve-test", v);
      assertExists(content);
      const parsed = JSON.parse(new TextDecoder().decode(content));
      assertEquals(parsed.step, v);
      assertEquals(parsed.message, contents[v - 1].message);
    }
  });
});

Deno.test("Data Versioning: latest symlink points to newest version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:symlink");

    const data = Data.create({
      name: "symlink-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write initial version
    await repo.save(type, modelId, data, new TextEncoder().encode("v1"));
    let latest = await repo.findByName(type, modelId, "symlink-test");
    assertEquals(latest?.version, 1);

    // Write second version
    await repo.save(type, modelId, data, new TextEncoder().encode("v2"));
    latest = await repo.findByName(type, modelId, "symlink-test");
    assertEquals(latest?.version, 2);

    // Write third version
    await repo.save(type, modelId, data, new TextEncoder().encode("v3"));
    latest = await repo.findByName(type, modelId, "symlink-test");
    assertEquals(latest?.version, 3);

    // Verify latest marker file exists in filesystem (text file, not symlink)
    const latestPath = join(
      repoDir,
      ".swamp",
      "data",
      type.toDirectoryPath(),
      modelId,
      "symlink-test",
      "latest",
    );
    assertEquals(existsSync(latestPath), true);

    const stat = await Deno.lstat(latestPath);
    assertEquals(stat.isFile, true);
    const latestContent = await Deno.readTextFile(latestPath);
    assertEquals(latestContent.trim(), "3");
  });
});

// ============================================================================
// Version Retention Settings (Garbage Collection)
// ============================================================================

Deno.test("Data Versioning: garbage collection by version count", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:gc-count");

    // Keep only 3 most recent versions
    const data = Data.create({
      name: "gc-count-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 3,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write 6 versions
    for (let i = 1; i <= 6; i++) {
      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(`version-${i}`),
      );
    }

    // Before GC, all 6 versions exist
    let versions = await repo.listVersions(type, modelId, "gc-count-test");
    assertEquals(versions, [1, 2, 3, 4, 5, 6]);

    // Run garbage collection
    const gcResult = await repo.collectGarbage(type, modelId);
    assertEquals(gcResult.versionsRemoved, 3); // Should remove versions 1, 2, 3

    // After GC, only 3 most recent versions remain
    versions = await repo.listVersions(type, modelId, "gc-count-test");
    assertEquals(versions, [4, 5, 6]);

    // Can still access remaining versions
    const v4 = await repo.findByName(type, modelId, "gc-count-test", 4);
    assertExists(v4);
    assertEquals(v4.version, 4);

    const v6 = await repo.findByName(type, modelId, "gc-count-test", 6);
    assertExists(v6);
    assertEquals(v6.version, 6);
  });
});

Deno.test("Data Versioning: garbage collection preserves minimum versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:gc-preserve");

    // Keep 5 versions
    const data = Data.create({
      name: "gc-preserve-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write only 3 versions (less than retention count)
    for (let i = 1; i <= 3; i++) {
      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(`v${i}`),
      );
    }

    // Run garbage collection
    const gcResult = await repo.collectGarbage(type, modelId);
    assertEquals(gcResult.versionsRemoved, 0); // Nothing should be removed

    // All versions still exist
    const versions = await repo.listVersions(type, modelId, "gc-preserve-test");
    assertEquals(versions, [1, 2, 3]);
  });
});

Deno.test("Data Versioning: multiple data items with different GC policies", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:multi-gc");

    // Data item with 2 version retention
    const data1 = Data.create({
      name: "data-keep-2",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 2,
      tags: { type: "state" },
      ownerDefinition: owner,
    });

    // Data item with 5 version retention
    const data2 = Data.create({
      name: "data-keep-5",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "logs" },
      ownerDefinition: owner,
    });

    // Write 4 versions to each
    for (let i = 1; i <= 4; i++) {
      await repo.save(
        type,
        modelId,
        data1,
        new TextEncoder().encode(`d1-v${i}`),
      );
      await repo.save(
        type,
        modelId,
        data2,
        new TextEncoder().encode(`d2-v${i}`),
      );
    }

    // Run garbage collection
    const gcResult = await repo.collectGarbage(type, modelId);
    assertEquals(gcResult.versionsRemoved, 2); // Only data1 should have versions removed

    // Verify data1 has 2 versions
    const versions1 = await repo.listVersions(type, modelId, "data-keep-2");
    assertEquals(versions1, [3, 4]);

    // Verify data2 has all 4 versions
    const versions2 = await repo.listVersions(type, modelId, "data-keep-5");
    assertEquals(versions2, [1, 2, 3, 4]);
  });
});

// ============================================================================
// Version Access via CEL Expressions
// ============================================================================

Deno.test("Data Versioning: access specific version via data.version()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    // Create a model definition
    const definition = Definition.create({
      name: "version-access-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:version-access");

    // Create versioned data
    const data = Data.create({
      name: "results",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "output", modelName: "version-access-model" },
      ownerDefinition: owner,
    });

    // Write 3 versions with different attributes
    for (let i = 1; i <= 3; i++) {
      await dataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode(JSON.stringify({
          value: i * 100,
          computed: i * 100 + i,
        })),
      );
    }

    // Build context with data namespace
    const catalog = new CatalogStore(
      join(repoDir, ".swamp", "data", "_catalog.db"),
    );
    const dqs = new DataQueryService(catalog, dataRepo);
    await dqs.query('name == ""');
    try {
      const modelResolver = new ModelResolver(definitionRepo, {
        repoDir,
        dataRepo,
        dataQueryService: dqs,
      });
      const context = await modelResolver.buildContext();

      assertExists(context.data);

      // Access specific versions
      const v1 = await context.data.version(
        "version-access-model",
        "results",
        1,
      );
      assertExists(v1);
      assertEquals(v1.version, 1);
      assertEquals(v1.attributes.value, 100);

      const v2 = await context.data.version(
        "version-access-model",
        "results",
        2,
      );
      assertExists(v2);
      assertEquals(v2.version, 2);
      assertEquals(v2.attributes.value, 200);

      const v3 = await context.data.version(
        "version-access-model",
        "results",
        3,
      );
      assertExists(v3);
      assertEquals(v3.version, 3);
      assertEquals(v3.attributes.value, 300);

      // Latest should be v3
      const latest = await context.data.latest(
        "version-access-model",
        "results",
      );
      assertExists(latest);
      assertEquals(latest.version, 3);
    } finally {
      catalog.close();
    }
  });
});

Deno.test("Data Versioning: listVersions returns all versions in order", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(repoDir);
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "list-versions-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:list-versions");

    const data = Data.create({
      name: "history",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 100,
      tags: { type: "audit" },
      ownerDefinition: owner,
    });

    // Write 10 versions
    for (let i = 1; i <= 10; i++) {
      await dataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode(JSON.stringify({ entry: i })),
      );
    }

    // Build context
    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
    });
    const context = await modelResolver.buildContext();

    assertExists(context.data);

    const versions = context.data.listVersions(
      "list-versions-model",
      "history",
    );
    assertEquals(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

// ============================================================================
// Content Integrity
// ============================================================================

Deno.test("Data Versioning: each version has independent content", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:content-integrity");

    const data = Data.create({
      name: "independent-content",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write versions with unique content
    const expectedContents = [
      "Content for version 1 - unique data here",
      "Content for version 2 - completely different",
      "Content for version 3 - third set of data",
    ];

    for (const content of expectedContents) {
      await repo.save(type, modelId, data, new TextEncoder().encode(content));
    }

    // Verify each version has correct content
    for (let v = 1; v <= 3; v++) {
      const content = await repo.getContent(
        type,
        modelId,
        "independent-content",
        v,
      );
      assertExists(content);
      assertEquals(
        new TextDecoder().decode(content),
        expectedContents[v - 1],
      );
    }
  });
});

Deno.test("Data Versioning: version metadata is preserved", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:metadata");

    const data = Data.create({
      name: "metadata-test",
      contentType: "application/octet-stream",
      lifetime: "7d",
      garbageCollection: 5,
      tags: { type: "binary", format: "raw" },
      ownerDefinition: owner,
    });

    await repo.save(type, modelId, data, new TextEncoder().encode("test"));

    const loaded = await repo.findByName(type, modelId, "metadata-test");
    assertExists(loaded);
    assertEquals(loaded.contentType, "application/octet-stream");
    assertEquals(loaded.lifetime, "7d");
    assertEquals(loaded.garbageCollection, 5);
    assertEquals(loaded.tags.type, "binary");
    assertEquals(loaded.tags.format, "raw");
    assertExists(loaded.createdAt);
    assertExists(loaded.ownerDefinition);
    assertEquals(loaded.ownerDefinition.ownerType, "model-method");
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

Deno.test("Data Versioning: non-existent version returns null", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:nonexistent");

    const data = Data.create({
      name: "sparse-versions",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write only one version
    await repo.save(type, modelId, data, new TextEncoder().encode("only-one"));

    // Version 1 exists
    const v1 = await repo.findByName(type, modelId, "sparse-versions", 1);
    assertExists(v1);

    // Version 2 does not exist
    const v2 = await repo.findByName(type, modelId, "sparse-versions", 2);
    assertEquals(v2, null);

    // Version 99 does not exist
    const v99 = await repo.findByName(type, modelId, "sparse-versions", 99);
    assertEquals(v99, null);
  });
});

Deno.test("Data Versioning: delete specific version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:delete-version");

    const data = Data.create({
      name: "delete-test",
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

    // Verify all 5 exist
    let versions = await repo.listVersions(type, modelId, "delete-test");
    assertEquals(versions, [1, 2, 3, 4, 5]);

    // Delete version 3
    await repo.delete(type, modelId, "delete-test", 3);

    // Verify version 3 is gone
    versions = await repo.listVersions(type, modelId, "delete-test");
    assertEquals(versions, [1, 2, 4, 5]);

    // Can still access other versions
    const v2 = await repo.findByName(type, modelId, "delete-test", 2);
    assertExists(v2);

    const v4 = await repo.findByName(type, modelId, "delete-test", 4);
    assertExists(v4);
  });
});

Deno.test("Data Versioning: delete all versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(repoDir);
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:delete-all");

    const data = Data.create({
      name: "delete-all-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write 3 versions
    for (let i = 1; i <= 3; i++) {
      await repo.save(type, modelId, data, new TextEncoder().encode(`v${i}`));
    }

    // Delete all (no version specified)
    await repo.delete(type, modelId, "delete-all-test");

    // Data is gone
    const found = await repo.findByName(type, modelId, "delete-all-test");
    assertEquals(found, null);

    const versions = await repo.listVersions(type, modelId, "delete-all-test");
    assertEquals(versions, []);
  });
});
