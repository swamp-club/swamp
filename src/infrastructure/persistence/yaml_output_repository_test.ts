import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createModelOutputId,
  type ExecutionProvenance,
  ModelOutput,
} from "../../domain/models/model_output.ts";
import { createModelInputId } from "../../domain/models/model_input.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { YamlOutputRepository } from "./yaml_output_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const defaultProvenance: ExecutionProvenance = {
  inputHash: "abc123",
  modelVersion: 1,
  triggeredBy: "manual",
};

const testType = ModelType.create("test/type");

Deno.test("YamlOutputRepository.save creates directory structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      modelInputId: createModelInputId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output);

    const expectedDir = join(
      dir,
      "data",
      "outputs",
      testType.normalized,
      "create",
    );
    const stat = await Deno.stat(expectedDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("YamlOutputRepository.save creates yaml file with correct path structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const modelInputId = createModelInputId(crypto.randomUUID());
    const output = ModelOutput.create({
      modelInputId,
      methodName: "deploy",
      provenance: {
        inputHash: "xyz789",
        modelVersion: 2,
        triggeredBy: "workflow",
        workflowId: "wf-123",
      },
    });

    await repo.save(testType, "deploy", output);

    const path = repo.getPath(testType, "deploy", output);
    // Path should be: outputs/{type}/{method}/{model-id}-{timestamp}.yaml
    assertStringIncludes(path, "outputs");
    assertStringIncludes(path, testType.normalized);
    assertStringIncludes(path, "deploy");
    assertStringIncludes(path, modelInputId);
    assertStringIncludes(path, ".yaml");

    const content = await Deno.readTextFile(path);
    assertStringIncludes(content, "methodName: deploy");
    assertStringIncludes(content, "status: pending");
    assertStringIncludes(content, "workflowId: wf-123");
  });
});

Deno.test("YamlOutputRepository.findById returns saved output", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const modelInputId = createModelInputId(crypto.randomUUID());
    const output = ModelOutput.create({
      modelInputId,
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output);
    const found = await repo.findById(testType, "create", output.id);

    assertEquals(found?.id, output.id);
    assertEquals(found?.modelInputId, modelInputId);
    assertEquals(found?.methodName, "create");
    assertEquals(found?.status, "pending");
    assertEquals(found?.provenance.inputHash, "abc123");
  });
});

Deno.test("YamlOutputRepository.findById returns null for non-existent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const id = createModelOutputId("550e8400-e29b-41d4-a716-446655440001");

    const found = await repo.findById(testType, "create", id);
    assertEquals(found, null);
  });
});

Deno.test("YamlOutputRepository.findAll returns all outputs for a type", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);

    const output1 = ModelOutput.create({
      modelInputId: createModelInputId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      modelInputId: createModelInputId(crypto.randomUUID()),
      methodName: "delete",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output1);
    await repo.save(testType, "delete", output2);

    const all = await repo.findAll(testType);
    assertEquals(all.length, 2);
  });
});

Deno.test("YamlOutputRepository.findAll returns empty array when none", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);

    const all = await repo.findAll(testType);
    assertEquals(all, []);
  });
});

Deno.test("YamlOutputRepository.findByModelInput filters by input ID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const inputId1 = createModelInputId(crypto.randomUUID());
    const inputId2 = createModelInputId(crypto.randomUUID());

    const output1 = ModelOutput.create({
      modelInputId: inputId1,
      methodName: "create",
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      modelInputId: inputId1,
      methodName: "update",
      provenance: defaultProvenance,
    });
    const output3 = ModelOutput.create({
      modelInputId: inputId2,
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output1);
    await repo.save(testType, "update", output2);
    await repo.save(testType, "create", output3);

    const forInput1 = await repo.findByModelInput(testType, inputId1);
    assertEquals(forInput1.length, 2);

    const forInput2 = await repo.findByModelInput(testType, inputId2);
    assertEquals(forInput2.length, 1);
  });
});

Deno.test("YamlOutputRepository.findLatestByModelInput returns most recent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const inputId = createModelInputId(crypto.randomUUID());

    const output1 = ModelOutput.create({
      modelInputId: inputId,
      methodName: "create",
      startedAt: new Date("2023-01-01T00:00:00Z"),
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      modelInputId: inputId,
      methodName: "update",
      startedAt: new Date("2023-01-02T00:00:00Z"),
      provenance: defaultProvenance,
    });
    const output3 = ModelOutput.create({
      modelInputId: inputId,
      methodName: "delete",
      startedAt: new Date("2023-01-01T12:00:00Z"),
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output1);
    await repo.save(testType, "update", output2);
    await repo.save(testType, "delete", output3);

    const latest = await repo.findLatestByModelInput(testType, inputId);
    assertEquals(latest?.id, output2.id);
    assertEquals(latest?.methodName, "update");
  });
});

Deno.test("YamlOutputRepository.findLatestByModelInput returns null when none", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const inputId = createModelInputId(crypto.randomUUID());

    const latest = await repo.findLatestByModelInput(testType, inputId);
    assertEquals(latest, null);
  });
});

Deno.test("YamlOutputRepository.delete removes output file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      modelInputId: createModelInputId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output);
    assertEquals(
      await repo.findById(testType, "create", output.id) !== null,
      true,
    );

    await repo.delete(testType, "create", output.id);
    assertEquals(await repo.findById(testType, "create", output.id), null);
  });
});

Deno.test("YamlOutputRepository.delete is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const id = createModelOutputId("550e8400-e29b-41d4-a716-446655440001");

    // Should not throw even if file doesn't exist
    await repo.delete(testType, "create", id);
  });
});

Deno.test("YamlOutputRepository.nextId generates valid UUID", () => {
  const repo = new YamlOutputRepository("/tmp");
  const id = repo.nextId();
  assertEquals(typeof id, "string");
  assertEquals(id.length, 36);
});

Deno.test("YamlOutputRepository preserves completed output state", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      modelInputId: createModelInputId(crypto.randomUUID()),
      methodName: "create",
      status: "running",
      provenance: defaultProvenance,
    });
    output.markSucceeded();
    output.setArtifacts({
      resourceId: "550e8400-e29b-41d4-a716-446655440010",
      logIds: ["550e8400-e29b-41d4-a716-446655440011"],
    });

    await repo.save(testType, "create", output);
    const found = await repo.findById(testType, "create", output.id);

    assertEquals(found?.status, "succeeded");
    assertEquals(found?.isComplete, true);
    assertEquals(
      found?.artifacts?.resourceId,
      "550e8400-e29b-41d4-a716-446655440010",
    );
    assertEquals(
      found?.artifacts?.logIds,
      ["550e8400-e29b-41d4-a716-446655440011"],
    );
  });
});

Deno.test("YamlOutputRepository preserves failed output state", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      modelInputId: createModelInputId(crypto.randomUUID()),
      methodName: "deploy",
      status: "running",
      provenance: defaultProvenance,
    });
    output.markFailed({
      message: "Deployment failed",
      stack: "Error: Connection timeout\n  at deploy()",
    });

    await repo.save(testType, "deploy", output);
    const found = await repo.findById(testType, "deploy", output.id);

    assertEquals(found?.status, "failed");
    assertEquals(found?.error?.message, "Deployment failed");
    assertEquals(found?.error?.stack?.includes("Connection timeout"), true);
  });
});

Deno.test("YamlOutputRepository.getPath uses correct format", () => {
  const repo = new YamlOutputRepository("/tmp/test");
  const modelInputId = createModelInputId(
    "550e8400-e29b-41d4-a716-446655440000",
  );
  const output = ModelOutput.create({
    modelInputId,
    methodName: "create",
    startedAt: new Date("2023-01-15T10:30:00.000Z"),
    provenance: defaultProvenance,
  });

  const path = repo.getPath(testType, "create", output);

  // Path should include: outputs/{type}/{method}/{model-id}-{timestamp}.yaml
  assertStringIncludes(path, "outputs");
  assertStringIncludes(path, testType.normalized);
  assertStringIncludes(path, "create");
  assertStringIncludes(path, "550e8400-e29b-41d4-a716-446655440000");
  assertStringIncludes(path, "2023-01-15T10-30-00-000Z");
  assertStringIncludes(path, ".yaml");
});
