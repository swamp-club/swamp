// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  type ModelMethodRunData,
  ModelMethodRunDisplay,
  renderModelMethodRun,
} from "./model_method_run_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testData: ModelMethodRunData = {
  modelId: "550e8400-e29b-41d4-a716-446655440000",
  modelName: "test-model",
  type: "swamp/echo",
  methodName: "write",
  resourceId: "660e8400-e29b-41d4-a716-446655440000",
  resourcePath:
    "/path/to/resources/swamp/echo/660e8400-e29b-41d4-a716-446655440000.yaml",
  resourceAttributes: {
    message: "Hello, world!",
    timestamp: "2026-01-28T12:00:00.000Z",
  },
};

Deno.test({
  name: "ModelMethodRunDisplay renders method name",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelMethodRunDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "write");
    assertStringIncludes(output, "executed successfully");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders model name and type",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelMethodRunDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-model");
    assertStringIncludes(output, "swamp/echo");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders resource ID",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelMethodRunDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "660e8400-e29b-41d4-a716-446655440000");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders resource path",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelMethodRunDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "/path/to/resources/swamp/echo");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders resource attributes",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelMethodRunDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "message:");
    assertStringIncludes(output, "Hello, world!");
    assertStringIncludes(output, "timestamp:");
    assertStringIncludes(output, "2026-01-28");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders checkmark",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<ModelMethodRunDisplay {...testData} />);
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "\u2713");
  },
});

Deno.test("renderModelMethodRun with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodRun(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelId, testData.modelId);
    assertEquals(parsed.modelName, testData.modelName);
    assertEquals(parsed.type, testData.type);
    assertEquals(parsed.methodName, testData.methodName);
    assertEquals(parsed.resourceId, testData.resourceId);
    assertEquals(parsed.resourcePath, testData.resourcePath);
    assertEquals(parsed.resourceAttributes.message, "Hello, world!");
    assertEquals(
      parsed.resourceAttributes.timestamp,
      "2026-01-28T12:00:00.000Z",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelMethodRun JSON preserves attribute types", () => {
  const dataWithNumber: ModelMethodRunData = {
    ...testData,
    resourceAttributes: {
      count: 42,
      enabled: true,
    },
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodRun(dataWithNumber, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.resourceAttributes.count, 42);
    assertEquals(parsed.resourceAttributes.enabled, true);
  } finally {
    console.log = originalLog;
  }
});
