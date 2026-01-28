import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ModelType } from "../../domain/models/model_type.ts";
import { createModelInputId } from "../../domain/models/model_input.ts";
import {
  createModelResourceId,
  ModelResource,
} from "../../domain/models/model_resource.ts";
import { YamlResourceRepository } from "./yaml_resource_repository.ts";

const TEST_INPUT_ID = "550e8400-e29b-41d4-a716-446655440000";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("YamlResourceRepository.save creates directory structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");
    const resource = ModelResource.create({ inputId: TEST_INPUT_ID });

    await repo.save(type, resource);

    const expectedDir = join(dir, "resources", "swamp/echo");
    const stat = await Deno.stat(expectedDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("YamlResourceRepository.save creates yaml file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");
    const resource = ModelResource.create({
      inputId: TEST_INPUT_ID,
      attributes: { message: "hello", timestamp: "2024-01-15" },
    });

    await repo.save(type, resource);

    const path = repo.getPath(type, resource.id);
    const content = await Deno.readTextFile(path);
    assertStringIncludes(content, "message: hello");
    assertStringIncludes(content, "timestamp:");
  });
});

Deno.test("YamlResourceRepository.findById returns saved resource", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");
    const resource = ModelResource.create({
      inputId: TEST_INPUT_ID,
      attributes: { message: "hello" },
    });

    await repo.save(type, resource);
    const found = await repo.findById(type, resource.id);

    assertEquals(found?.id, resource.id);
    assertEquals(found?.inputId, TEST_INPUT_ID);
    assertEquals(found?.attributes, { message: "hello" });
  });
});

Deno.test("YamlResourceRepository.findById returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelResourceId("550e8400-e29b-41d4-a716-446655440001");

    const found = await repo.findById(type, id);
    assertEquals(found, null);
  });
});

Deno.test("YamlResourceRepository.findAll returns all resources of type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");

    const resource1 = ModelResource.create({
      inputId: TEST_INPUT_ID,
      attributes: { n: 1 },
    });
    const resource2 = ModelResource.create({
      inputId: TEST_INPUT_ID,
      attributes: { n: 2 },
    });
    await repo.save(type, resource1);
    await repo.save(type, resource2);

    const all = await repo.findAll(type);
    assertEquals(all.length, 2);
  });
});

Deno.test("YamlResourceRepository.findAll returns empty array when no resources", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");

    const all = await repo.findAll(type);
    assertEquals(all, []);
  });
});

Deno.test("YamlResourceRepository.findByInputId finds resource by input ID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");

    const resource = ModelResource.create({ inputId: TEST_INPUT_ID });
    await repo.save(type, resource);

    const inputId = createModelInputId(TEST_INPUT_ID);
    const found = await repo.findByInputId(type, inputId);
    assertEquals(found?.id, resource.id);
    assertEquals(found?.inputId, TEST_INPUT_ID);
  });
});

Deno.test("YamlResourceRepository.findByInputId returns null when not found", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");

    const inputId = createModelInputId("550e8400-e29b-41d4-a716-446655440099");
    const found = await repo.findByInputId(type, inputId);
    assertEquals(found, null);
  });
});

Deno.test("YamlResourceRepository.delete removes resource file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");
    const resource = ModelResource.create({ inputId: TEST_INPUT_ID });

    await repo.save(type, resource);
    assertEquals(await repo.findById(type, resource.id) !== null, true);

    await repo.delete(type, resource.id);
    assertEquals(await repo.findById(type, resource.id), null);
  });
});

Deno.test("YamlResourceRepository.delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlResourceRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelResourceId("550e8400-e29b-41d4-a716-446655440001");

    // Should not throw even if file doesn't exist
    await repo.delete(type, id);
  });
});

Deno.test("YamlResourceRepository.nextId generates valid UUID", () => {
  const repo = new YamlResourceRepository("/tmp");
  const id = repo.nextId();
  assertEquals(typeof id, "string");
  assertEquals(id.length, 36);
});

Deno.test("YamlResourceRepository.getPath returns correct path", () => {
  const repo = new YamlResourceRepository("/repo");
  const type = ModelType.create("swamp/echo");
  const id = createModelResourceId("550e8400-e29b-41d4-a716-446655440001");

  const path = repo.getPath(type, id);
  assertEquals(
    path,
    "/repo/resources/swamp/echo/550e8400-e29b-41d4-a716-446655440001.yaml",
  );
});
