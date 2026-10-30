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

import { assertEquals, assertThrows } from "@std/assert";
import {
  computeDefinitionHash,
  executionErrorFrom,
  type ExecutionProvenance,
  isSettledStatus,
  ModelOutput,
  type ModelOutputData,
  redactedError,
} from "./model_output.ts";
import { createDefinitionId } from "../definitions/definition.ts";
import { errorPaths, markErrorPaths, UserError } from "../errors.ts";

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

Deno.test("ModelOutput.markSucceeded: completion before start gives a zero duration", () => {
  const startedAt = new Date("2023-01-01T00:00:01.000Z");
  const completedAt = new Date("2023-01-01T00:00:00.165Z");
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    startedAt,
    provenance: defaultProvenance,
  });

  output.markSucceeded(completedAt);

  assertEquals(output.durationMs, 0);
  assertEquals(output.completedAt, completedAt);
});

Deno.test("ModelOutput.markFailed: completion before start gives a zero duration", () => {
  const startedAt = new Date("2023-01-01T00:00:01.000Z");
  const completedAt = new Date("2023-01-01T00:00:00.165Z");
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    startedAt,
    provenance: defaultProvenance,
  });

  output.markFailed({ message: "boom" }, completedAt);

  assertEquals(output.durationMs, 0);
  assertEquals(output.completedAt, completedAt);
});

Deno.test("ModelOutput.markCancelled: completion before start gives a zero duration", () => {
  // markCancelled always completes at the current time, so start in the future.
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    startedAt: new Date(Date.now() + 60_000),
    provenance: defaultProvenance,
  });

  output.markCancelled();

  assertEquals(output.durationMs, 0);
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

// durationMs is unknown so tests can feed values a YAML file could hold but
// ModelOutputData's type does not allow.
function persistedOutput(durationMs: unknown): ModelOutputData {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    definitionId: "660e8400-e29b-41d4-a716-446655440000",
    methodName: "approve",
    status: "succeeded",
    startedAt: "2026-08-21T21:35:41.471Z",
    completedAt: "2026-08-21T21:35:40.636Z",
    durationMs: durationMs as number,
    retryCount: 0,
    provenance: defaultProvenance,
  };
}

Deno.test("ModelOutput.fromData: reads a negative durationMs as 0", () => {
  const data = persistedOutput(-835);

  const output = ModelOutput.fromData(data);

  assertEquals(output.durationMs, 0);
  assertEquals(output.status, "succeeded");
  assertEquals(output.startedAt.toISOString(), "2026-08-21T21:35:41.471Z");
  assertEquals(output.completedAt?.toISOString(), "2026-08-21T21:35:40.636Z");
  assertEquals(data.durationMs, -835);
});

Deno.test("ModelOutput.fromData: still rejects a non-integer durationMs", () => {
  assertThrows(() => ModelOutput.fromData(persistedOutput(1.5)));
  assertThrows(() => ModelOutput.fromData(persistedOutput("835")));
});

Deno.test("ModelOutput.create: still rejects a negative durationMs", () => {
  assertThrows(() =>
    ModelOutput.create({
      definitionId: createDefinitionId(crypto.randomUUID()),
      methodName: "create",
      durationMs: -1,
      provenance: defaultProvenance,
    })
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

// markCancelled tests

Deno.test("ModelOutput.markCancelled: marks running output as cancelled", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });

  output.markCancelled();

  assertEquals(output.status, "cancelled");
  assertEquals(output.completedAt !== undefined, true);
  assertEquals(output.durationMs !== undefined, true);
  assertEquals(output.error, undefined);
});

Deno.test("ModelOutput.markCancelled: stores reason in error", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });

  output.markCancelled("User requested cancellation");

  assertEquals(output.status, "cancelled");
  assertEquals(output.error?.message, "User requested cancellation");
});

Deno.test("ModelOutput.markCancelled: works from pending status", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });

  output.markCancelled();

  assertEquals(output.status, "cancelled");
  assertEquals(output.isComplete, true);
});

Deno.test("ModelOutput.markCancelled: throws if already succeeded", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });
  output.markSucceeded();

  assertThrows(
    () => output.markCancelled(),
    Error,
    "Cannot mark output as cancelled: status is succeeded",
  );
});

Deno.test("ModelOutput.markCancelled: throws if already failed", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance: defaultProvenance,
  });
  output.markFailed({ message: "error" });

  assertThrows(
    () => output.markCancelled(),
    Error,
    "Cannot mark output as cancelled: status is failed",
  );
});

Deno.test("ModelOutput.isComplete: returns true for cancelled", () => {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    provenance: defaultProvenance,
  });

  output.markCancelled();

  assertEquals(output.isComplete, true);
});

// bundleFingerprint provenance round-trip tests

Deno.test("ModelOutput toData/fromData round-trips bundleFingerprint", () => {
  const provenance: ExecutionProvenance = {
    definitionHash: "hash123",
    modelVersion: "2026.02.09.3",
    triggeredBy: "manual",
    bundleFingerprint: "sha256:deadbeef",
  };
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "create",
    status: "running",
    provenance,
  });
  output.markSucceeded();

  const data = output.toData();
  const restored = ModelOutput.fromData(data);

  assertEquals(restored.provenance.bundleFingerprint, "sha256:deadbeef");
});

Deno.test("ModelOutput fromData: missing bundleFingerprint defaults to undefined", () => {
  const data = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    definitionId: "660e8400-e29b-41d4-a716-446655440000",
    methodName: "create",
    status: "succeeded" as const,
    startedAt: "2023-01-01T00:00:00.000Z",
    completedAt: "2023-01-01T00:00:05.000Z",
    durationMs: 5000,
    retryCount: 0,
    provenance: {
      definitionHash: "hash",
      modelVersion: "2026.02.09.1",
      triggeredBy: "manual" as const,
    },
  };

  const output = ModelOutput.fromData(data);

  assertEquals(output.provenance.bundleFingerprint, undefined);
});

Deno.test("executionErrorFrom: passes the message and stack through the redactor, and keeps them without one", () => {
  const error = new Error("token hunter2-long leaked");
  assertEquals(executionErrorFrom(error).message, "token hunter2-long leaked");
  assertEquals(typeof executionErrorFrom(error).stack, "string");
  const redactor = {
    hasSecrets: true,
    redact: (text: string) => text.replaceAll("hunter2-long", "***"),
  };
  const clean = executionErrorFrom(error, redactor);
  assertEquals(clean.message, "token *** leaked");
  assertEquals(clean.stack?.includes("hunter2-long"), false);
  assertEquals(clean.stack?.includes("***"), true);
  // A thrown non-Error has a message and no stack.
  assertEquals(executionErrorFrom("plain failure", redactor), {
    message: "plain failure",
  });
  // A redactor holding nothing is not asked.
  const idle = {
    hasSecrets: false,
    redact: (): string => {
      throw new Error("not called");
    },
  };
  assertEquals(executionErrorFrom(new Error("m"), idle).message, "m");
});

const secretRedactor = {
  hasSecrets: true,
  redact: (text: string) => text.replaceAll("hunter2-long", "***"),
};

Deno.test("redactedError: a coded UserError that echoes a secret stays a UserError with its code, cause, own properties and marked paths, its message and stack redacted (swamp-club#3746)", () => {
  const cause = new Error("inner");
  const error = markErrorPaths(
    new UserError("token hunter2-long rejected", "auth_failed"),
    ["/repo/a"],
  );
  Object.defineProperty(error, "cause", {
    value: cause,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  (error as unknown as Record<string, unknown>).dataArtifacts = [{ name: "d" }];
  const shown = redactedError(error, secretRedactor);
  if (!(shown instanceof UserError)) {
    throw new Error("expected the copy to stay a UserError");
  }
  assertEquals(shown === error, false);
  assertEquals(shown.code, "auth_failed");
  assertEquals(shown.name, "UserError");
  assertEquals(shown.message, "token *** rejected");
  assertEquals(shown.stack?.includes("hunter2-long"), false);
  assertEquals(shown.cause, cause);
  assertEquals(
    (shown as unknown as Record<string, unknown>).dataArtifacts,
    [{ name: "d" }],
  );
  assertEquals(errorPaths(shown), ["/repo/a"]);
  // The original is left as it was.
  assertEquals(error.message, "token hunter2-long rejected");
  assertEquals(errorPaths(error), ["/repo/a"]);
});

Deno.test("redactedError: a UserError code that echoes a secret is redacted, and the copy stays a UserError (swamp-club#3773)", () => {
  const error = new UserError("denied", "auth_failed_hunter2-long");
  const shown = redactedError(error, secretRedactor);
  if (!(shown instanceof UserError)) {
    throw new Error("expected the copy to stay a UserError");
  }
  assertEquals(shown === error, false);
  assertEquals(shown.code, "auth_failed_***");
  assertEquals(shown.message, "denied");
  // The original is left as it was.
  assertEquals(error.code, "auth_failed_hunter2-long");
  // A code with nothing to hide leaves an error with nothing to hide as is.
  const clean = new UserError("denied", "auth_failed");
  assertEquals(redactedError(clean, secretRedactor), clean);
});

Deno.test("redactedError: a code that is an accessor, non-configurable or inherited is redacted onto the copy without throwing", () => {
  const accessor = new Error("denied");
  Object.defineProperty(accessor, "code", {
    get: () => "auth_failed_hunter2-long",
    enumerable: true,
    configurable: true,
  });
  const fixed = new Error("denied");
  Object.defineProperty(fixed, "code", {
    value: "auth_failed_hunter2-long",
    enumerable: false,
    writable: false,
    configurable: false,
  });
  class InheritedCodeError extends Error {
    get code(): string {
      return "auth_failed_hunter2-long";
    }
  }
  const inherited = new InheritedCodeError("denied");
  for (const error of [accessor, fixed, inherited]) {
    const shown = redactedError(error, secretRedactor) as Error & {
      code?: unknown;
    };
    assertEquals(shown === error, false);
    assertEquals(shown.code, "auth_failed_***");
    assertEquals(Object.getPrototypeOf(shown), Object.getPrototypeOf(error));
  }
  assertEquals(
    Object.getOwnPropertyDescriptor(
      redactedError(fixed, secretRedactor),
      "code",
    )?.enumerable,
    false,
  );
});

Deno.test("redactedError: an AggregateError keeps its errors, and an error without a cause gains none (swamp-club#3746)", () => {
  const inner = new Error("inner");
  const shown = redactedError(
    new AggregateError([inner], "batch hunter2-long failed"),
    secretRedactor,
  );
  if (!(shown instanceof AggregateError)) {
    throw new Error("expected the copy to stay an AggregateError");
  }
  assertEquals(shown.message, "batch *** failed");
  assertEquals(shown.errors, [inner]);
  assertEquals(Object.hasOwn(shown, "cause"), false);
});

Deno.test("redactedError: a thrown non-Error that echoes a secret becomes its redacted text; anything else, and any value without a redactor holding secrets, is returned as it is (swamp-club#3746)", () => {
  assertEquals(
    redactedError("request failed: hunter2-long", secretRedactor),
    "request failed: ***",
  );
  const thrown = { message: "hunter2-long" };
  assertEquals(redactedError(thrown, secretRedactor), thrown);
  const clean = new Error("nothing to hide");
  assertEquals(redactedError(clean, secretRedactor), clean);
  const leaky = new Error("token hunter2-long");
  assertEquals(redactedError(leaky), leaky);
  const idle = {
    hasSecrets: false,
    redact: (): string => {
      throw new Error("not called");
    },
  };
  assertEquals(redactedError(leaky, idle), leaky);
  assertEquals(redactedError("hunter2-long", idle), "hunter2-long");
});

Deno.test("isSettledStatus: only a finished run is settled", () => {
  assertEquals(isSettledStatus("pending"), false);
  assertEquals(isSettledStatus("running"), false);
  assertEquals(isSettledStatus("succeeded"), true);
  assertEquals(isSettledStatus("failed"), true);
  assertEquals(isSettledStatus("cancelled"), true);
});
