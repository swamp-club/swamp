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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createModelOutputId,
  type ExecutionProvenance,
  ModelOutput,
} from "../../domain/models/model_output.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
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
  definitionHash: "abc123",
  modelVersion: "2026.02.09.1",
  triggeredBy: "manual",
};

const testType = ModelType.create("test/type");

Deno.test("YamlOutputRepository.save creates directory structure", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output);

    const expectedDir = join(
      dir,
      ".swamp",
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
    const definitionId = createDefinitionId(crypto.randomUUID());
    const output = ModelOutput.create({
      definitionId,
      methodName: "deploy",
      provenance: {
        definitionHash: "xyz789",
        modelVersion: "2026.02.09.2",
        triggeredBy: "workflow",
        workflowId: "wf-123",
      },
    });

    await repo.save(testType, "deploy", output);

    const path = repo.getPath(testType, "deploy", output);
    // Path should be: outputs/{type}/{method}/{definition-id}-{timestamp}.yaml
    assertStringIncludes(path, "outputs");
    assertStringIncludes(path, testType.normalized);
    assertStringIncludes(path, "deploy");
    assertStringIncludes(path, definitionId);
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
    const definitionId = createDefinitionId(crypto.randomUUID());
    const output = ModelOutput.create({
      definitionId,
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output);
    const found = await repo.findById(testType, "create", output.id);

    assertEquals(found?.id, output.id);
    assertEquals(found?.definitionId, definitionId);
    assertEquals(found?.methodName, "create");
    assertEquals(found?.status, "pending");
    assertEquals(found?.provenance.definitionHash, "abc123");
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
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
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

Deno.test("YamlOutputRepository.findByDefinition filters by definition ID", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const defId1 = createDefinitionId(crypto.randomUUID());
    const defId2 = createDefinitionId(crypto.randomUUID());

    const output1 = ModelOutput.create({
      definitionId: defId1,
      methodName: "create",
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      definitionId: defId1,
      methodName: "update",
      provenance: defaultProvenance,
    });
    const output3 = ModelOutput.create({
      definitionId: defId2,
      methodName: "create",
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output1);
    await repo.save(testType, "update", output2);
    await repo.save(testType, "create", output3);

    const forDef1 = await repo.findByDefinition(testType, defId1);
    assertEquals(forDef1.length, 2);

    const forDef2 = await repo.findByDefinition(testType, defId2);
    assertEquals(forDef2.length, 1);
  });
});

Deno.test("YamlOutputRepository.findLatestByDefinition returns most recent", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const defId = createDefinitionId(crypto.randomUUID());

    const output1 = ModelOutput.create({
      definitionId: defId,
      methodName: "create",
      startedAt: new Date("2023-01-01T00:00:00Z"),
      provenance: defaultProvenance,
    });
    const output2 = ModelOutput.create({
      definitionId: defId,
      methodName: "update",
      startedAt: new Date("2023-01-02T00:00:00Z"),
      provenance: defaultProvenance,
    });
    const output3 = ModelOutput.create({
      definitionId: defId,
      methodName: "delete",
      startedAt: new Date("2023-01-01T12:00:00Z"),
      provenance: defaultProvenance,
    });

    await repo.save(testType, "create", output1);
    await repo.save(testType, "update", output2);
    await repo.save(testType, "delete", output3);

    const latest = await repo.findLatestByDefinition(testType, defId);
    assertEquals(latest?.id, output2.id);
    assertEquals(latest?.methodName, "update");
  });
});

Deno.test("YamlOutputRepository.findLatestByDefinition returns null when none", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const defId = createDefinitionId(crypto.randomUUID());

    const latest = await repo.findLatestByDefinition(testType, defId);
    assertEquals(latest, null);
  });
});

Deno.test("YamlOutputRepository.delete removes output file", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
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
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      status: "running",
      provenance: defaultProvenance,
    });
    output.markSucceeded();
    output.addDataArtifact({
      dataId: "550e8400-e29b-41d4-a716-446655440010",
      name: "test-resource",
      version: 1,
      tags: { type: "resource" },
    });
    output.addDataArtifact({
      dataId: "550e8400-e29b-41d4-a716-446655440011",
      name: "test-log",
      version: 1,
      tags: { type: "log" },
    });

    await repo.save(testType, "create", output);
    const found = await repo.findById(testType, "create", output.id);

    assertEquals(found?.status, "succeeded");
    assertEquals(found?.isComplete, true);
    assertEquals(found?.artifacts.dataArtifacts.length, 2);
    assertEquals(
      found?.artifacts.dataArtifacts[0].dataId,
      "550e8400-e29b-41d4-a716-446655440010",
    );
    assertEquals(
      found?.artifacts.dataArtifacts[1].dataId,
      "550e8400-e29b-41d4-a716-446655440011",
    );
  });
});

Deno.test("YamlOutputRepository preserves failed output state", async () => {
  await withTempDir(async (dir) => {
    const repo = new YamlOutputRepository(dir);
    const output = ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
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
  const definitionId = createDefinitionId(
    "550e8400-e29b-41d4-a716-446655440000",
  );
  const output = ModelOutput.create({
    definitionId,
    methodName: "create",
    startedAt: new Date("2023-01-15T10:30:00.000Z"),
    provenance: defaultProvenance,
  });

  const path = repo.getPath(testType, "create", output);

  // Path should include: outputs/{type}/{method}/{definition-id}-{timestamp}.yaml
  assertStringIncludes(path, "outputs");
  assertStringIncludes(path, testType.normalized);
  assertStringIncludes(path, "create");
  assertStringIncludes(path, "550e8400-e29b-41d4-a716-446655440000");
  assertStringIncludes(path, "2023-01-15T10-30-00-000Z");
  assertStringIncludes(path, ".yaml");
});
