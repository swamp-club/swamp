import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelInputId,
  ModelInput,
} from "../../domain/models/model_input.ts";
import { YamlInputRepository } from "./yaml_input_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("YamlInputRepository.save creates directory structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");
    const input = ModelInput.create({ name: "test-input" });

    await repo.save(type, input);

    const expectedDir = join(dir, "inputs", "swamp/echo");
    const stat = await Deno.stat(expectedDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("YamlInputRepository.save creates yaml file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");
    const input = ModelInput.create({
      name: "test-input",
      attributes: { message: "hello" },
    });

    await repo.save(type, input);

    const path = repo.getPath(type, input.id);
    const content = await Deno.readTextFile(path);
    assertStringIncludes(content, "name: test-input");
    assertStringIncludes(content, "message: hello");
  });
});

Deno.test("YamlInputRepository.findById returns saved input", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");
    const input = ModelInput.create({
      name: "test-input",
      tags: { env: "prod" },
      attributes: { message: "hello" },
    });

    await repo.save(type, input);
    const found = await repo.findById(type, input.id);

    assertEquals(found?.id, input.id);
    assertEquals(found?.name, "test-input");
    assertEquals(found?.tags, { env: "prod" });
    assertEquals(found?.attributes, { message: "hello" });
  });
});

Deno.test("YamlInputRepository.findById returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelInputId("550e8400-e29b-41d4-a716-446655440000");

    const found = await repo.findById(type, id);
    assertEquals(found, null);
  });
});

Deno.test("YamlInputRepository.findAll returns all inputs of type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");

    const input1 = ModelInput.create({ name: "input-1" });
    const input2 = ModelInput.create({ name: "input-2" });
    await repo.save(type, input1);
    await repo.save(type, input2);

    const all = await repo.findAll(type);
    assertEquals(all.length, 2);
    assertEquals(all.map((i) => i.name).sort(), ["input-1", "input-2"]);
  });
});

Deno.test("YamlInputRepository.findAll returns empty array when no inputs", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");

    const all = await repo.findAll(type);
    assertEquals(all, []);
  });
});

Deno.test("YamlInputRepository.findByName finds input by name", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");

    const input = ModelInput.create({ name: "my-input" });
    await repo.save(type, input);

    const found = await repo.findByName(type, "my-input");
    assertEquals(found?.id, input.id);
    assertEquals(found?.name, "my-input");
  });
});

Deno.test("YamlInputRepository.findByName returns null when not found", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");

    const found = await repo.findByName(type, "nonexistent");
    assertEquals(found, null);
  });
});

Deno.test("YamlInputRepository.delete removes input file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");
    const input = ModelInput.create({ name: "test-input" });

    await repo.save(type, input);
    assertEquals(await repo.findById(type, input.id) !== null, true);

    await repo.delete(type, input.id);
    assertEquals(await repo.findById(type, input.id), null);
  });
});

Deno.test("YamlInputRepository.delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");
    const id = createModelInputId("550e8400-e29b-41d4-a716-446655440000");

    // Should not throw even if file doesn't exist
    await repo.delete(type, id);
  });
});

Deno.test("YamlInputRepository.nextId generates valid UUID", () => {
  const repo = new YamlInputRepository("/tmp");
  const id = repo.nextId();
  assertEquals(typeof id, "string");
  assertEquals(id.length, 36);
});

Deno.test("YamlInputRepository.getPath returns correct path", () => {
  const repo = new YamlInputRepository("/repo");
  const type = ModelType.create("swamp/echo");
  const id = createModelInputId("550e8400-e29b-41d4-a716-446655440000");

  const path = repo.getPath(type, id);
  assertEquals(
    path,
    "/repo/inputs/swamp/echo/550e8400-e29b-41d4-a716-446655440000.yaml",
  );
});

Deno.test("YamlInputRepository handles nested type paths", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("AWS::EC2::VPC");
    const input = ModelInput.create({ name: "my-vpc" });

    await repo.save(type, input);

    const path = repo.getPath(type, input.id);
    assertStringIncludes(path, "aws/ec2/vpc");

    const found = await repo.findById(type, input.id);
    assertEquals(found?.name, "my-vpc");
  });
});

Deno.test("YamlInputRepository.findByNameGlobal finds input across all types", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const echoType = ModelType.create("swamp/echo");
    const otherType = ModelType.create("swamp/other");

    const echoInput = ModelInput.create({ name: "echo-input" });
    const otherInput = ModelInput.create({ name: "other-input" });
    await repo.save(echoType, echoInput);
    await repo.save(otherType, otherInput);

    // Should find input from echo type
    const foundEcho = await repo.findByNameGlobal("echo-input");
    assertEquals(foundEcho?.input.id, echoInput.id);
    assertEquals(foundEcho?.type.normalized, "swamp/echo");

    // Should find input from other type
    const foundOther = await repo.findByNameGlobal("other-input");
    assertEquals(foundOther?.input.id, otherInput.id);
    assertEquals(foundOther?.type.normalized, "swamp/other");
  });
});

Deno.test("YamlInputRepository.findByNameGlobal returns null when not found", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);
    const type = ModelType.create("swamp/echo");
    const input = ModelInput.create({ name: "my-input" });
    await repo.save(type, input);

    const found = await repo.findByNameGlobal("nonexistent");
    assertEquals(found, null);
  });
});

Deno.test("YamlInputRepository.findByNameGlobal returns null when no inputs exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlInputRepository(dir);

    const found = await repo.findByNameGlobal("nonexistent");
    assertEquals(found, null);
  });
});
