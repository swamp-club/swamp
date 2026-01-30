import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelDataId,
  ModelData,
} from "../../domain/models/model_data.ts";
import { YamlDataRepository } from "./yaml_data_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("YamlDataRepository.save creates directory structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/echo");
    const data = ModelData.create({});

    await repo.save(type, data);

    const expectedDir = join(dir, "data", "swamp/echo");
    const stat = await Deno.stat(expectedDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("YamlDataRepository.save creates yaml file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/echo");
    const data = ModelData.create({
      attributes: { result: "success", count: 42 },
    });

    await repo.save(type, data);

    const path = repo.getPath(type, data.id);
    const content = await Deno.readTextFile(path);
    assertStringIncludes(content, "result: success");
    assertStringIncludes(content, "count: 42");
  });
});

Deno.test("YamlDataRepository.findById returns saved data", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/echo");
    const data = ModelData.create({
      attributes: { items: [1, 2, 3], total: 6 },
    });

    await repo.save(type, data);
    const found = await repo.findById(type, data.id);

    assertEquals(found?.id, data.id);
    assertEquals(found?.attributes, { items: [1, 2, 3], total: 6 });
  });
});

Deno.test("YamlDataRepository.findById returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelDataId("550e8400-e29b-41d4-a716-446655440001");

    const found = await repo.findById(type, id);
    assertEquals(found, null);
  });
});

Deno.test("YamlDataRepository.findAll returns all data of type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/echo");

    const data1 = ModelData.create({
      attributes: { n: 1 },
    });
    const data2 = ModelData.create({
      attributes: { n: 2 },
    });
    await repo.save(type, data1);
    await repo.save(type, data2);

    const all = await repo.findAll(type);
    assertEquals(all.length, 2);
  });
});

Deno.test("YamlDataRepository.findAll returns empty array when no data", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/echo");

    const all = await repo.findAll(type);
    assertEquals(all, []);
  });
});

Deno.test("YamlDataRepository.delete removes data file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/echo");
    const data = ModelData.create({});

    await repo.save(type, data);
    assertEquals(await repo.findById(type, data.id) !== null, true);

    await repo.delete(type, data.id);
    assertEquals(await repo.findById(type, data.id), null);
  });
});

Deno.test("YamlDataRepository.delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelDataId("550e8400-e29b-41d4-a716-446655440001");

    // Should not throw even if file doesn't exist
    await repo.delete(type, id);
  });
});

Deno.test("YamlDataRepository.nextId generates valid UUID", () => {
  const repo = new YamlDataRepository("/tmp");
  const id = repo.nextId();
  assertEquals(typeof id, "string");
  assertEquals(id.length, 36);
});

Deno.test("YamlDataRepository.getPath returns correct path", () => {
  const repo = new YamlDataRepository("/repo");
  const type = ModelType.create("swamp/echo");
  const id = createModelDataId("550e8400-e29b-41d4-a716-446655440001");

  const path = repo.getPath(type, id);
  assertEquals(
    path,
    "/repo/data/swamp/echo/550e8400-e29b-41d4-a716-446655440001.yaml",
  );
});

Deno.test("YamlDataRepository preserves complex nested attributes", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlDataRepository(dir);
    const type = ModelType.create("swamp/query");
    const data = ModelData.create({
      attributes: {
        results: [
          { id: 1, name: "first" },
          { id: 2, name: "second" },
        ],
        metadata: {
          totalCount: 2,
          page: 1,
          filters: { status: "active" },
        },
      },
    });

    await repo.save(type, data);
    const found = await repo.findById(type, data.id);

    assertEquals(found?.attributes, data.attributes);
  });
});
