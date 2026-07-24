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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { setColorEnabled } from "@std/fmt/colors";
import {
  consumeStream,
  type ModelMethodRunEvent,
  type ModelMethodRunView,
} from "../../libswamp/mod.ts";
import { createModelMethodRunRenderer } from "./model_method_run.ts";
import { UserError } from "../../domain/errors.ts";
import { AUTH_NUDGE_MESSAGE } from "../../domain/auth/auth_nudge.ts";

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
      modelId: "test-model-id",
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

function captureOutput(fn: () => void): string[] {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  setColorEnabled(false);
  try {
    fn();
  } finally {
    console.log = origLog;
    setColorEnabled(true);
  }
  return lines;
}

async function captureOutputAsync(
  fn: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  setColorEnabled(false);
  try {
    await fn();
  } finally {
    console.log = origLog;
    setColorEnabled(true);
  }
  return lines;
}

// --- ConsoleModelMethodRunRenderer tests ---

Deno.test("ConsoleModelMethodRunRenderer: succeeded run shows Resolved, Executing, Completed", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: true,
  });
  const events = fullEventStream(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(renderer.runFailed(), false);
  const output = lines.join("\n");
  assertStringIncludes(output, "Resolved");
  assertStringIncludes(output, "test-model");
  assertStringIncludes(output, "(test/type)");
  assertStringIncludes(output, "Executing");
  assertStringIncludes(output, "hello world");
  assertStringIncludes(output, "Completed");
  assertStringIncludes(output, "run on test-model");
});

Deno.test("ConsoleModelMethodRunRenderer: failed run shows Failed with log path", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: true,
  });
  const events: ModelMethodRunEvent[] = [
    { kind: "validating_inputs" },
    {
      kind: "model_resolved",
      modelName: "test-model",
      modelType: "test/type",
      modelId: "id",
      methodName: "run",
    },
    { kind: "completed", run: makeRunView("failed") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(renderer.runFailed(), true);
  const output = lines.join("\n");
  assertStringIncludes(output, "Failed");
  assertStringIncludes(output, "/tmp/test.log");
});

Deno.test("ConsoleModelMethodRunRenderer: method_output writes both stdout and stderr without color distinction", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: true,
  });
  const events: ModelMethodRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "executing", modelName: "test-model", methodName: "run" },
    {
      kind: "method_output",
      modelName: "test-model",
      methodName: "run",
      stream: "stdout",
      line: "stdout-line",
    },
    {
      kind: "method_output",
      modelName: "test-model",
      methodName: "run",
      stream: "stderr",
      line: "stderr-line",
    },
    { kind: "completed", run: makeRunView("succeeded") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "stdout-line");
  assertStringIncludes(output, "stderr-line");
});

Deno.test("ConsoleModelMethodRunRenderer: shows inline data artifacts on success", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: true,
  });
  const events = fullEventStream(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Data produced");
  assertStringIncludes(output, "result");
  assertStringIncludes(output, "exitCode");
});

Deno.test("ConsoleModelMethodRunRenderer: error event throws UserError", () => {
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

Deno.test("ConsoleModelMethodRunRenderer: shows auth nudge when not authenticated", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: false,
  });
  const events = fullEventStream(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, AUTH_NUDGE_MESSAGE);
});

Deno.test("ConsoleModelMethodRunRenderer: suppresses auth nudge when authenticated", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: true,
  });
  const events = fullEventStream(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertEquals(output.includes(AUTH_NUDGE_MESSAGE), false);
});

Deno.test("ConsoleModelMethodRunRenderer: suppresses auth nudge on failure", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: false,
  });
  const events: ModelMethodRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "completed", run: makeRunView("failed") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertEquals(output.includes(AUTH_NUDGE_MESSAGE), false);
});

Deno.test("ConsoleModelMethodRunRenderer: quiet mode buffers output and discards on success", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: true,
    quiet: true,
  });
  const events = fullEventStream(makeRunView("succeeded"));
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertEquals(output.includes("hello world"), false);
  assertStringIncludes(output, "Completed");
});

Deno.test("ConsoleModelMethodRunRenderer: quiet mode replays buffer on failure", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
    isAuthenticated: true,
    quiet: true,
  });
  const events: ModelMethodRunEvent[] = [
    { kind: "validating_inputs" },
    { kind: "executing", modelName: "test-model", methodName: "run" },
    {
      kind: "method_output",
      modelName: "test-model",
      methodName: "run",
      stream: "stdout",
      line: "important output",
    },
    { kind: "completed", run: makeRunView("failed") },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "important output");
  assertStringIncludes(output, "Failed");
});

Deno.test("ConsoleModelMethodRunRenderer: handles cancelled run", async () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
  });
  const events: ModelMethodRunEvent[] = [
    { kind: "validating_inputs" },
    {
      kind: "cancelled",
      run: makeRunView("failed"),
      reason: "user interrupt",
    },
  ];
  const lines = await captureOutputAsync(async () => {
    await consumeStream(toStream(events), renderer.handlers());
  });
  assertEquals(renderer.runFailed(), true);
  const output = lines.join("\n");
  assertStringIncludes(output, "Cancelled");
  assertStringIncludes(output, "user interrupt");
});

Deno.test("ConsoleModelMethodRunRenderer: handles method_event types", () => {
  const renderer = createModelMethodRunRenderer("log", {
    modelName: "test-model",
    methodName: "run",
  });
  const handlers = renderer.handlers();
  const lines = captureOutput(() => {
    handlers.method_event({
      kind: "method_event",
      modelName: "test-model",
      methodName: "run",
      event: {
        type: "vault_secret_stored",
        fieldPath: "password",
        vaultName: "default",
        vaultKey: "key",
      },
    });
    handlers.method_event({
      kind: "method_event",
      modelName: "test-model",
      methodName: "run",
      event: {
        type: "schema_validation_warning",
        specName: "resource",
        instanceName: "inst",
        error: "field required",
      },
    });
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "password");
  assertStringIncludes(output, "Warning");
  assertStringIncludes(output, "field required");
});

// --- JsonModelMethodRunRenderer tests ---

Deno.test("JsonModelMethodRunRenderer: intermediate events produce no output", () => {
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
        modelId: "test-model-id",
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

Deno.test("JsonModelMethodRunRenderer: completed serializes ModelMethodRunView", async () => {
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
    assertEquals(parsed.dataArtifacts[0].attributes.exitCode, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelMethodRunRenderer: failed run sets runFailed()", async () => {
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

Deno.test("JsonModelMethodRunRenderer: error event throws UserError", () => {
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

Deno.test("JsonModelMethodRunRenderer: auto_gc_completed does not write to stdout", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodRunRenderer("json", {
      modelName: "test-model",
      methodName: "run",
    });
    const runView = makeRunView("succeeded");
    const events: ModelMethodRunEvent[] = [
      ...fullEventStream(runView),
      {
        kind: "auto_gc_completed",
        versionsDeleted: 3,
        bytesReclaimed: 4096,
        dataEntriesExpired: 0,
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonModelMethodRunRenderer: never shows auth nudge", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createModelMethodRunRenderer("json", {
      modelName: "test-model",
      methodName: "run",
      isAuthenticated: false,
    });
    const events = fullEventStream(makeRunView("succeeded"));
    await consumeStream(toStream(events), renderer.handlers());
    const combined = logs.join("\n");
    assertEquals(combined.includes(AUTH_NUDGE_MESSAGE), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("createModelMethodRunRenderer: factory returns correct type per mode", () => {
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
