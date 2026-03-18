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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  consumeStream,
  type ModelMethodRunEvent,
  type ModelMethodRunView,
} from "../../libswamp/mod.ts";
import { createModelMethodRunRenderer } from "./model_method_run.ts";
import { UserError } from "../../domain/errors.ts";

await initializeLogging({});

function makeRunView(
  status: "succeeded" | "failed",
): ModelMethodRunView {
  return {
    modelId: "def-1",
    modelName: "test-model",
    modelType: "test/type",
    methodName: "run",
    status,
    duration: 100,
    outputId: "out-1",
    logFile: "/tmp/test.log",
    dataArtifacts: [{
      id: "art-1",
      name: "result",
      path: "/data/result/v1",
      attributes: { exitCode: 0 },
    }],
  };
}

function fullEventStream(
  runView: ModelMethodRunView,
): ModelMethodRunEvent[] {
  return [
    { kind: "validating_inputs" },
    { kind: "resolving_model", modelIdOrName: "test-model" },
    {
      kind: "model_resolved",
      modelName: "test-model",
      modelType: "test/type",
      methodName: "run",
    },
    { kind: "evaluating_expressions", lastEvaluated: false },
    { kind: "executing", modelName: "test-model", methodName: "run" },
    {
      kind: "method_output",
      modelName: "test-model",
      methodName: "run",
      stream: "stdout",
      line: "hello world",
    },
    {
      kind: "data_artifact_saved",
      name: "result",
      path: "/data/result/v1",
    },
    { kind: "completed", run: runView },
  ];
}

async function* toStream(
  events: ModelMethodRunEvent[],
): AsyncGenerator<ModelMethodRunEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogModelMethodRunRenderer - succeeded run sets runFailed() to false", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
  });
  const events = fullEventStream(makeRunView("succeeded"));
  await consumeStream(toStream(events), renderer.handlers());
  assertEquals(renderer.runFailed(), false);
});

Deno.test("LogModelMethodRunRenderer - failed run sets runFailed() to true", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
  });
  const events: ModelMethodRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "resolving_model", modelIdOrName: "test-model" },
    {
      kind: "model_resolved",
      modelName: "test-model",
      modelType: "test/type",
      methodName: "run",
    },
    { kind: "completed", run: makeRunView("failed") },
  ];
  await consumeStream(toStream(events), renderer.handlers());
  assertEquals(renderer.runFailed(), true);
});

Deno.test("LogModelMethodRunRenderer - error event throws UserError", () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
  });
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});

Deno.test("LogModelMethodRunRenderer - handles method_output and method_event without error", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
  });
  const events: ModelMethodRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "resolving_model", modelIdOrName: "test-model" },
    {
      kind: "model_resolved",
      modelName: "test-model",
      modelType: "test/type",
      methodName: "run",
    },
    { kind: "evaluating_expressions", lastEvaluated: false },
    { kind: "executing", modelName: "test-model", methodName: "run" },
    {
      kind: "method_output",
      modelName: "test-model",
      methodName: "run",
      stream: "stdout",
      line: "hello",
    },
    {
      kind: "method_output",
      modelName: "test-model",
      methodName: "run",
      stream: "stderr",
      line: "warning",
    },
    {
      kind: "method_event",
      modelName: "test-model",
      methodName: "run",
      event: {
        type: "vault_secret_stored",
        fieldPath: "password",
        vaultName: "default",
        vaultKey: "key",
      },
    },
    {
      kind: "method_event",
      modelName: "test-model",
      methodName: "run",
      event: {
        type: "schema_validation_warning",
        specName: "resource",
        instanceName: "inst",
        error: "field required",
      },
    },
    { kind: "completed", run: makeRunView("succeeded") },
  ];
  await consumeStream(toStream(events), renderer.handlers());
  assertEquals(renderer.runFailed(), false);
});

Deno.test("JsonModelMethodRunRenderer - intermediate events produce no output", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodRunRenderer("json", {
      modelName: "test-model",
      methodName: "run",
    });
    const events: ModelMethodRunEvent[] = [
      { kind: "validating_inputs" },
      { kind: "resolving_model", modelIdOrName: "test-model" },
      {
        kind: "model_resolved",
        modelName: "test-model",
        modelType: "test/type",
        methodName: "run",
      },
      { kind: "evaluating_expressions", lastEvaluated: false },
      { kind: "executing", modelName: "test-model", methodName: "run" },
      {
        kind: "method_output",
        modelName: "test-model",
        methodName: "run",
        stream: "stdout",
        line: "hello",
      },
      {
        kind: "method_event",
        modelName: "test-model",
        methodName: "run",
        event: {
          type: "vault_secret_stored",
          fieldPath: "p",
          vaultName: "v",
          vaultKey: "k",
        },
      },
      {
        kind: "data_artifact_saved",
        name: "result",
        path: "/data/result/v1",
      },
    ];
    for (const event of events) {
      const handler = renderer.handlers()[event.kind];
      // deno-lint-ignore no-explicit-any
      handler(event as any);
    }
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelMethodRunRenderer - completed serializes ModelMethodRunView directly", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodRunRenderer("json", {
      modelName: "test-model",
      methodName: "run",
    });
    const runView = makeRunView("succeeded");
    const events = fullEventStream(runView);
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelId, "def-1");
    assertEquals(parsed.modelName, "test-model");
    assertEquals(parsed.modelType, "test/type");
    assertEquals(parsed.methodName, "run");
    assertEquals(parsed.dataArtifacts[0].id, "art-1");
    assertEquals(parsed.dataArtifacts[0].path, "/data/result/v1");
    assertEquals(parsed.dataArtifacts[0].attributes.exitCode, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelMethodRunRenderer - failed run sets runFailed() to true", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodRunRenderer("json", {
      modelName: "test-model",
      methodName: "run",
    });
    const events: ModelMethodRunEvent[] = [
      { kind: "validating_inputs" },
      { kind: "completed", run: makeRunView("failed") },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(renderer.runFailed(), true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelMethodRunRenderer - succeeded run sets runFailed() to false", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodRunRenderer("json", {
      modelName: "test-model",
      methodName: "run",
    });
    const events: ModelMethodRunEvent[] = [
      { kind: "validating_inputs" },
      { kind: "completed", run: makeRunView("succeeded") },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(renderer.runFailed(), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelMethodRunRenderer - error event throws UserError", () => {
  const renderer = createModelMethodRunRenderer("json", {
    modelName: "test-model",
    methodName: "run",
  });
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});

Deno.test("createModelMethodRunRenderer - factory returns correct type per mode", () => {
  const logRenderer = createModelMethodRunRenderer("log", {
    modelName: "m",
    methodName: "r",
  });
  const jsonRenderer = createModelMethodRunRenderer("json", {
    modelName: "m",
    methodName: "r",
  });

  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof logRenderer.runFailed, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.runFailed, "function");
});
