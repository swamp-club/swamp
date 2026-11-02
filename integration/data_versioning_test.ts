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

import { RunSensitiveValues } from "../src/domain/secrets/mod.ts";
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
import { DefaultDataLifecycleService } from "../src/domain/data/data_lifecycle_service.ts";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-data-versioning-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
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

Deno.test("Data Versioning: write multiple versions of same data", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
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

    assertEquals(versions.length, 5);
    assertEquals(versions[0].version, 1);
    assertEquals(versions[4].version, 5);

    const versionList = await repo.listVersions(
      type,
      modelId,
      "versioned-state",
    );
    assertEquals(versionList, [1, 2, 3, 4, 5]);

    const latest = await repo.findByName(type, modelId, "versioned-state");
    assertExists(latest);
    assertEquals(latest.version, 5);
  });
});

Deno.test("Data Versioning: retrieve specific versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
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

Deno.test("Data Versioning: latest marker points to newest version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
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

    await repo.save(type, modelId, data, new TextEncoder().encode("v1"));
    let latest = await repo.findByName(type, modelId, "symlink-test");
    assertEquals(latest?.version, 1);

    await repo.save(type, modelId, data, new TextEncoder().encode("v2"));
    latest = await repo.findByName(type, modelId, "symlink-test");
    assertEquals(latest?.version, 2);

    await repo.save(type, modelId, data, new TextEncoder().encode("v3"));
    latest = await repo.findByName(type, modelId, "symlink-test");
    assertEquals(latest?.version, 3);

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

Deno.test("Data Versioning: garbage collection by version count", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:gc-count");

    const data = Data.create({
      name: "gc-count-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 3,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    // Write 6 versions — no write-time pruning (enableWriteGc defaults to false)
    for (let i = 1; i <= 6; i++) {
      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(`version-${i}`),
      );
    }

    let versions = await repo.listVersions(type, modelId, "gc-count-test");
    assertEquals(versions, [1, 2, 3, 4, 5, 6]);

    const gcResult = await repo.collectGarbage(type, modelId);
    assertEquals(gcResult.versionsRemoved, 3);

    versions = await repo.listVersions(type, modelId, "gc-count-test");
    assertEquals(versions, [4, 5, 6]);

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
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:gc-preserve");

    const data = Data.create({
      name: "gc-preserve-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 3; i++) {
      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(`v${i}`),
      );
    }

    const gcResult = await repo.collectGarbage(type, modelId);
    assertEquals(gcResult.versionsRemoved, 0);

    const versions = await repo.listVersions(type, modelId, "gc-preserve-test");
    assertEquals(versions, [1, 2, 3]);
  });
});

Deno.test("Data Versioning: garbage collection dry-run reports counts without deleting", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:gc-dryrun");

    const data = Data.create({
      name: "gc-dryrun-test",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 3,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 7; i++) {
      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(`v${i}`),
      );
    }

    const before = await repo.listVersions(type, modelId, "gc-dryrun-test");
    assertEquals(before, [1, 2, 3, 4, 5, 6, 7]);

    const gcResult = await repo.collectGarbage(type, modelId, { dryRun: true });
    assertEquals(gcResult.versionsRemoved, 4);

    const after = await repo.listVersions(type, modelId, "gc-dryrun-test");
    assertEquals(after, [1, 2, 3, 4, 5, 6, 7]);
  });
});

Deno.test("Data Versioning: multiple data items with different GC policies", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const type = ModelType.create("test/model");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/model:multi-gc");

    const data1 = Data.create({
      name: "data-keep-2",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 2,
      tags: { type: "state" },
      ownerDefinition: owner,
    });

    const data2 = Data.create({
      name: "data-keep-5",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "logs" },
      ownerDefinition: owner,
    });

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

    const gcResult = await repo.collectGarbage(type, modelId);
    assertEquals(gcResult.versionsRemoved, 2);

    const versions1 = await repo.listVersions(type, modelId, "data-keep-2");
    assertEquals(versions1, [3, 4]);

    const versions2 = await repo.listVersions(type, modelId, "data-keep-5");
    assertEquals(versions2, [1, 2, 3, 4]);
  });
});

Deno.test("Data Versioning: access specific version via data.version()", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const type = ModelType.create("test/model");

    const definition = Definition.create({
      name: "version-access-model",
      tags: {},
      globalArguments: {},
    });
    await definitionRepo.save(type, definition);

    const owner = createOwner("test/model:version-access");

    const data = Data.create({
      name: "results",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "output", modelName: "version-access-model" },
      ownerDefinition: owner,
    });

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
      const context = await modelResolver.buildContext(
        new RunSensitiveValues(),
      );

      assertExists(context.data);

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
    const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
    );
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
      tags: { type: "audit", modelName: "list-versions-model" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 10; i++) {
      await dataRepo.save(
        type,
        definition.id,
        data,
        new TextEncoder().encode(JSON.stringify({ entry: i })),
      );
    }

    const modelResolver = new ModelResolver(definitionRepo, {
      repoDir,
      dataRepo,
      dataQueryService: new DataQueryService(catalog, dataRepo),
    });
    const context = await modelResolver.buildContext(new RunSensitiveValues());

    assertExists(context.data);

    const versions = context.data.listVersions(
      "list-versions-model",
      "history",
    );
    assertEquals(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

Deno.test("Data Versioning: each version has independent content", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
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

    const expectedContents = [
      "Content for version 1 - unique data here",
      "Content for version 2 - completely different",
      "Content for version 3 - third set of data",
    ];

    for (const content of expectedContents) {
      await repo.save(type, modelId, data, new TextEncoder().encode(content));
    }

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
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
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

Deno.test("Data Versioning: non-existent version returns null", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
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

    await repo.save(type, modelId, data, new TextEncoder().encode("only-one"));

    const v1 = await repo.findByName(type, modelId, "sparse-versions", 1);
    assertExists(v1);

    const v2 = await repo.findByName(type, modelId, "sparse-versions", 2);
    assertEquals(v2, null);

    const v99 = await repo.findByName(type, modelId, "sparse-versions", 99);
    assertEquals(v99, null);
  });
});

Deno.test("Data Versioning: delete specific version", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      new CatalogStore(join(repoDir, "_catalog.db")),
    );
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

    for (let i = 1; i <= 5; i++) {
      await repo.save(type, modelId, data, new TextEncoder().encode(`v${i}`));
    }

    let versions = await repo.listVersions(type, modelId, "delete-test");
    assertEquals(versions, [1, 2, 3, 4, 5]);

    await repo.delete(type, modelId, "delete-test", 3);

    versions = await repo.listVersions(type, modelId, "delete-test");
    assertEquals(versions, [1, 2, 4, 5]);

    const v2 = await repo.findByName(type, modelId, "delete-test", 2);
    assertExists(v2);

    const v4 = await repo.findByName(type, modelId, "delete-test", 4);
    assertExists(v4);
  });
});

Deno.test("Data Versioning: delete all versions", async () => {
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
      garbageCollection: 10,
      tags: { type: "test" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 3; i++) {
      await repo.save(type, modelId, data, new TextEncoder().encode(`v${i}`));
    }

    await repo.delete(type, modelId, "delete-all-test");

    const found = await repo.findByName(type, modelId, "delete-all-test");
    assertEquals(found, null);

    const versions = await repo.listVersions(type, modelId, "delete-all-test");
    assertEquals(versions, []);
  });
});

Deno.test("Data Versioning: deleteExpiredData removes excess version directories from disk", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    await ensureDir(join(repoDir, ".swamp", "workflow-runs"));
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );
    const workflowRunRepo = new YamlWorkflowRunRepository(repoDir);
    const service = new DefaultDataLifecycleService(repo, workflowRunRepo);

    const type = ModelType.create("test/gc-e2e");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/gc-e2e:run");

    const data = Data.create({
      name: "findings",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 25; i++) {
      await repo.save(
        type,
        modelId,
        data,
        new TextEncoder().encode(JSON.stringify({ run: i })),
      );
    }

    const dataNameDir = repo.getDataNameDir(type, modelId, "findings");
    let versionDirsBefore = 0;
    for await (const entry of Deno.readDir(dataNameDir)) {
      if (entry.isDirectory && entry.name !== "latest") versionDirsBefore++;
    }
    assertEquals(versionDirsBefore, 25);

    const result = await service.deleteExpiredData();

    assertEquals(result.dataEntriesExpired, 0);
    assertEquals(result.versionsDeleted, 20);

    let versionDirsAfter = 0;
    for await (const entry of Deno.readDir(dataNameDir)) {
      if (entry.isDirectory && entry.name !== "latest") versionDirsAfter++;
    }
    assertEquals(
      versionDirsAfter,
      5,
      `Expected 5 version dirs, got ${versionDirsAfter}`,
    );

    const survivingVersions = await repo.listVersions(
      type,
      modelId,
      "findings",
    );
    assertEquals(survivingVersions, [21, 22, 23, 24, 25]);
  });
});

Deno.test("Data Versioning: deleteExpiredData with expired + excess versions", async () => {
  await withTempDir(async (repoDir) => {
    await setupRepoDir(repoDir);
    await ensureDir(join(repoDir, ".swamp", "workflow-runs"));
    const catalogStore = new CatalogStore(join(repoDir, "_catalog.db"));
    const repo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );
    const workflowRunRepo = new YamlWorkflowRunRepository(repoDir);
    const service = new DefaultDataLifecycleService(repo, workflowRunRepo);

    const type = ModelType.create("test/gc-mixed");
    const modelId = crypto.randomUUID();
    const owner = createOwner("test/gc-mixed:run");

    const expiredData = Data.create({
      name: "expired-item",
      contentType: "text/plain",
      lifetime: "1m",
      garbageCollection: 5,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    const gcData = Data.create({
      name: "gc-target",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 3,
      tags: { type: "resource" },
      ownerDefinition: owner,
    });

    for (let i = 1; i <= 10; i++) {
      await repo.save(
        type,
        modelId,
        expiredData,
        new TextEncoder().encode(`expired-v${i}`),
      );
      await repo.save(
        type,
        modelId,
        gcData,
        new TextEncoder().encode(`gc-v${i}`),
      );
    }

    const expiredDataNameDir = repo.getDataNameDir(
      type,
      modelId,
      "expired-item",
    );

    const expiredVersions = await repo.listVersions(
      type,
      modelId,
      "expired-item",
    );
    for (const v of expiredVersions) {
      const metaPath = join(
        repo.getPath(type, modelId, "expired-item", v),
        "metadata.yaml",
      );
      const content = await Deno.readTextFile(metaPath);
      const backdated = content.replace(
        /createdAt: .*/,
        "createdAt: '2020-01-01T00:00:00.000Z'",
      );
      await Deno.writeTextFile(metaPath, backdated);
    }

    const gcDataNameDir = repo.getDataNameDir(type, modelId, "gc-target");
    let gcVersionsBefore = 0;
    for await (const entry of Deno.readDir(gcDataNameDir)) {
      if (entry.isDirectory && entry.name !== "latest") gcVersionsBefore++;
    }
    assertEquals(gcVersionsBefore, 10);

    const result = await service.deleteExpiredData();

    assertEquals(result.dataEntriesExpired, 1);

    assertEquals(existsSync(expiredDataNameDir), false);

    let gcVersionsAfter = 0;
    for await (const entry of Deno.readDir(gcDataNameDir)) {
      if (entry.isDirectory && entry.name !== "latest") gcVersionsAfter++;
    }
    assertEquals(
      gcVersionsAfter,
      3,
      `Expected 3 version dirs for gc-target after GC, got ${gcVersionsAfter}`,
    );

    const survivingVersions = await repo.listVersions(
      type,
      modelId,
      "gc-target",
    );
    assertEquals(survivingVersions, [8, 9, 10]);
  });
});
