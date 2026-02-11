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

import { assertEquals, assertThrows } from "@std/assert";
import {
  computeDefinitionHash,
  type ExecutionProvenance,
  ModelOutput,
} from "./model_output.ts";
import { createDefinitionId } from "../definitions/definition.ts";

const defaultProvenance: ExecutionProvenance = {
  definitionHash: "abc123",
  modelVersion: "2026.02.09.1",
  triggeredBy: "manual",
};

Deno.test("ModelOutput.create generates UUID if not provided", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });
  assertEquals(typeof output.id, "string");
  assertEquals(output.id.length, 36);
});

Deno.test("ModelOutput.create uses provided ID", () => {
  const id = "550e8400-e29b-41d4-a716-446655440001";
  const output = ModelOutput.create({
    id,
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });
  assertEquals(output.id, id);
});

Deno.test("ModelOutput.create defaults to pending status", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });
  assertEquals(output.status, "pending");
});

Deno.test("ModelOutput.create uses provided status", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });
  assertEquals(output.status, "running");
});

Deno.test("ModelOutput.create sets startedAt to now if not provided", () => {
  const before = new Date();
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });
  const after = new Date();

  assertEquals(output.startedAt >= before, true);
  assertEquals(output.startedAt <= after, true);
});

Deno.test("ModelOutput.create uses provided startedAt", () => {
  const startedAt = new Date("2023-01-01T00:00:00Z");
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    startedAt,
    provenance: defaultProvenance,
  });
  assertEquals(output.startedAt, startedAt);
});

Deno.test("ModelOutput.create stores method name", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "deploy",
    provenance: defaultProvenance,
  });
  assertEquals(output.methodName, "deploy");
});

Deno.test("ModelOutput.create stores provenance", () => {
  const provenance: ExecutionProvenance = {
    definitionHash: "xyz789",
    modelVersion: "2026.02.09.2",
    triggeredBy: "workflow",
    workflowId: "wf-123",
    workflowRunId: "run-456",
    stepName: "deploy-step",
  };
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance,
  });
  assertEquals(output.provenance, provenance);
});

Deno.test("ModelOutput.create defaults retry count to 0", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });
  assertEquals(output.retryCount, 0);
});

Deno.test("ModelOutput.markRunning transitions from pending", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });

  output.markRunning();

  assertEquals(output.status, "running");
});

Deno.test("ModelOutput.markRunning throws if not pending", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });

  assertThrows(
    () => output.markRunning(),
    Error,
    "Cannot mark output as running: status is running",
  );
});

Deno.test("ModelOutput.markSucceeded transitions from running", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });

  output.markSucceeded();

  assertEquals(output.status, "succeeded");
  assertEquals(output.isComplete, true);
  assertEquals(output.completedAt !== undefined, true);
  assertEquals(output.durationMs !== undefined, true);
});

Deno.test("ModelOutput.markSucceeded calculates duration", () => {
  const startedAt = new Date("2023-01-01T00:00:00.000Z");
  const completedAt = new Date("2023-01-01T00:00:05.000Z");
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    startedAt,
    provenance: defaultProvenance,
  });

  output.markSucceeded(completedAt);

  assertEquals(output.durationMs, 5000);
});

Deno.test("ModelOutput.markSucceeded throws if not running", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });

  assertThrows(
    () => output.markSucceeded(),
    Error,
    "Cannot mark output as succeeded: status is pending",
  );
});

Deno.test("ModelOutput.markFailed transitions from running", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });

  output.markFailed({ message: "Something went wrong", stack: "Error: ..." });

  assertEquals(output.status, "failed");
  assertEquals(output.isComplete, true);
  assertEquals(output.error?.message, "Something went wrong");
  assertEquals(output.error?.stack, "Error: ...");
});

Deno.test("ModelOutput.markFailed throws if not running", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });

  assertThrows(
    () => output.markFailed({ message: "error" }),
    Error,
    "Cannot mark output as failed: status is pending",
  );
});

Deno.test("ModelOutput.incrementRetryCount", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });

  assertEquals(output.retryCount, 0);
  output.incrementRetryCount();
  assertEquals(output.retryCount, 1);
  output.incrementRetryCount();
  assertEquals(output.retryCount, 2);
});

Deno.test("ModelOutput.addDataArtifact", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });

  output.addDataArtifact({
    dataId: "550e8400-e29b-41d4-a716-446655440001",
    name: "test-resource",
    version: 1,
    tags: { type: "resource" },
  });

  assertEquals(output.artifacts.dataArtifacts.length, 1);
  assertEquals(
    output.artifacts.dataArtifacts[0].dataId,
    "550e8400-e29b-41d4-a716-446655440001",
  );
  assertEquals(output.artifacts.dataArtifacts[0].name, "test-resource");
  assertEquals(output.artifacts.dataArtifacts[0].version, 1);
  assertEquals(output.artifacts.dataArtifacts[0].tags.type, "resource");
});

Deno.test("ModelOutput.addDataArtifact multiple artifacts", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });

  output.addDataArtifact({
    dataId: "550e8400-e29b-41d4-a716-446655440001",
    name: "test-resource",
    version: 1,
    tags: { type: "resource" },
  });
  output.addDataArtifact({
    dataId: "550e8400-e29b-41d4-a716-446655440002",
    name: "test-data",
    version: 1,
    tags: { type: "data" },
  });
  output.addDataArtifact({
    dataId: "550e8400-e29b-41d4-a716-446655440003",
    name: "test-log",
    version: 1,
    tags: { type: "log" },
  });

  assertEquals(output.artifacts.dataArtifacts.length, 3);
});

Deno.test("ModelOutput.isComplete returns false for pending/running", () => {
  const pending = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });
  assertEquals(pending.isComplete, false);

  const running = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });
  assertEquals(running.isComplete, false);
});

Deno.test("ModelOutput toData/fromData roundtrip", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "deploy",
    status: "running",
    provenance: {
      definitionHash: "hash123",
      modelVersion: "2026.02.09.3",
      triggeredBy: "workflow",
      workflowId: "wf-1",
    },
  });
  output.markSucceeded();
  output.addDataArtifact({
    dataId: "550e8400-e29b-41d4-a716-446655440001",
    name: "test-resource",
    version: 1,
    tags: { type: "resource" },
  });
  output.addDataArtifact({
    dataId: "550e8400-e29b-41d4-a716-446655440002",
    name: "test-log",
    version: 1,
    tags: { type: "log" },
  });

  const data = output.toData();
  const restored = ModelOutput.fromData(data);

  assertEquals(restored.id, output.id);
  assertEquals(restored.definitionId, output.definitionId);
  assertEquals(restored.methodName, output.methodName);
  assertEquals(restored.status, output.status);
  assertEquals(restored.startedAt.getTime(), output.startedAt.getTime());
  assertEquals(restored.completedAt?.getTime(), output.completedAt?.getTime());
  assertEquals(restored.durationMs, output.durationMs);
  assertEquals(restored.provenance, output.provenance);
  assertEquals(restored.artifacts.dataArtifacts.length, 2);
  assertEquals(
    restored.artifacts.dataArtifacts[0].dataId,
    "550e8400-e29b-41d4-a716-446655440001",
  );
  assertEquals(
    restored.artifacts.dataArtifacts[1].dataId,
    "550e8400-e29b-41d4-a716-446655440002",
  );
});

Deno.test("ModelOutput fromData with explicit data", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const definitionId = "660e8400-e29b-41d4-a716-446655440000";
  const startedAt = "2023-01-01T00:00:00.000Z";
  const completedAt = "2023-01-01T00:00:10.000Z";

  const data = {
    id,
    definitionId,
    methodName: "delete",
    status: "failed" as const,
    startedAt,
    completedAt,
    durationMs: 10000,
    error: { message: "Resource not found" },
    retryCount: 2,
    provenance: {
      definitionHash: "hash",
      modelVersion: "2026.02.09.1",
      triggeredBy: "manual" as const,
    },
    artifacts: {
      dataArtifacts: [
        {
          dataId: "550e8400-e29b-41d4-a716-446655440003",
          name: "test-log",
          version: 1,
          tags: { type: "log" },
        },
      ],
    },
  };

  const output = ModelOutput.fromData(data);
  assertEquals(output.id, id);
  assertEquals(output.definitionId, definitionId);
  assertEquals(output.methodName, "delete");
  assertEquals(output.status, "failed");
  assertEquals(output.error?.message, "Resource not found");
  assertEquals(output.retryCount, 2);
  assertEquals(output.artifacts.dataArtifacts.length, 1);
  assertEquals(
    output.artifacts.dataArtifacts[0].dataId,
    "550e8400-e29b-41d4-a716-446655440003",
  );
});

Deno.test("ModelOutput artifacts getter returns copy", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });
  output.addDataArtifact({
    dataId: "550e8400-e29b-41d4-a716-446655440001",
    name: "test-resource",
    version: 1,
    tags: { type: "resource" },
  });

  const artifacts = output.artifacts;
  artifacts.dataArtifacts.push({
    dataId: "550e8400-e29b-41d4-a716-446655440002",
    name: "modified",
    version: 1,
    tags: {},
  });

  assertEquals(output.artifacts.dataArtifacts.length, 1);
});

Deno.test("ModelOutput error getter returns copy", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });
  output.markFailed({ message: "original" });

  const error = output.error;
  if (error) {
    error.message = "modified";
  }

  assertEquals(output.error?.message, "original");
});

// computeDefinitionHash tests

Deno.test("computeDefinitionHash produces consistent hash", async () => {
  const attributes = { name: "test", count: 42 };

  const hash1 = await computeDefinitionHash(attributes);
  const hash2 = await computeDefinitionHash(attributes);

  assertEquals(hash1, hash2);
  assertEquals(hash1.length, 64); // SHA-256 produces 64 hex chars
});

Deno.test("computeDefinitionHash is order-independent", async () => {
  const attrs1 = { b: 2, a: 1 };
  const attrs2 = { a: 1, b: 2 };

  const hash1 = await computeDefinitionHash(attrs1);
  const hash2 = await computeDefinitionHash(attrs2);

  assertEquals(hash1, hash2);
});

Deno.test("computeDefinitionHash different for different values", async () => {
  const attrs1 = { name: "test1" };
  const attrs2 = { name: "test2" };

  const hash1 = await computeDefinitionHash(attrs1);
  const hash2 = await computeDefinitionHash(attrs2);

  assertEquals(hash1 !== hash2, true);
});
