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

const testDataWithResource: ModelMethodRunData = {
  modelId: "550e8400-e29b-41d4-a716-446655440000",
  modelName: "test-model",
  type: "aws/ec2/instance",
  methodName: "create",
  resource: {
    id: "660e8400-e29b-41d4-a716-446655440000",
    path:
      "/path/to/resources/aws/ec2/instance/660e8400-e29b-41d4-a716-446655440000.yaml",
    attributes: {
      instanceId: "i-1234567890abcdef0",
      state: "running",
    },
  },
};

const testDataWithData: ModelMethodRunData = {
  modelId: "550e8400-e29b-41d4-a716-446655440000",
  modelName: "test-model",
  type: "swamp/echo",
  methodName: "write",
  data: {
    id: "660e8400-e29b-41d4-a716-446655440000",
    path: "/path/to/data/swamp/echo/660e8400-e29b-41d4-a716-446655440000.yaml",
    attributes: {
      message: "Hello, world!",
      timestamp: "2026-01-28T12:00:00.000Z",
    },
  },
};

Deno.test({
  name: "ModelMethodRunDisplay renders method name",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelMethodRunDisplay {...testDataWithData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "write");
    assertStringIncludes(output, "executed successfully");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders model name and type",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelMethodRunDisplay {...testDataWithData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-model");
    assertStringIncludes(output, "swamp/echo");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders data ID",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelMethodRunDisplay {...testDataWithData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "660e8400-e29b-41d4-a716-446655440000");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders data path",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelMethodRunDisplay {...testDataWithData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "/path/to/data/swamp/echo");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders data attributes",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelMethodRunDisplay {...testDataWithData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "message:");
    assertStringIncludes(output, "Hello, world!");
    assertStringIncludes(output, "timestamp:");
    assertStringIncludes(output, "2026-01-28");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders resource attributes",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelMethodRunDisplay {...testDataWithResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "instanceId:");
    assertStringIncludes(output, "i-1234567890abcdef0");
    assertStringIncludes(output, "state:");
    assertStringIncludes(output, "running");
  },
});

Deno.test({
  name: "ModelMethodRunDisplay renders checkmark",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelMethodRunDisplay {...testDataWithData} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "\u2713");
  },
});

Deno.test("renderModelMethodRun with json mode outputs valid JSON for data", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodRun(testDataWithData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelId, testDataWithData.modelId);
    assertEquals(parsed.modelName, testDataWithData.modelName);
    assertEquals(parsed.type, testDataWithData.type);
    assertEquals(parsed.methodName, testDataWithData.methodName);
    assertEquals(parsed.data.id, testDataWithData.data!.id);
    assertEquals(parsed.data.path, testDataWithData.data!.path);
    assertEquals(parsed.data.attributes.message, "Hello, world!");
    assertEquals(
      parsed.data.attributes.timestamp,
      "2026-01-28T12:00:00.000Z",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelMethodRun with json mode outputs valid JSON for resource", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodRun(testDataWithResource, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.modelId, testDataWithResource.modelId);
    assertEquals(parsed.resource.id, testDataWithResource.resource!.id);
    assertEquals(parsed.resource.attributes.instanceId, "i-1234567890abcdef0");
    assertEquals(parsed.resource.attributes.state, "running");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelMethodRun JSON preserves attribute types", () => {
  const dataWithNumber: ModelMethodRunData = {
    ...testDataWithData,
    data: {
      ...testDataWithData.data!,
      attributes: {
        count: 42,
        enabled: true,
      },
    },
  };

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelMethodRun(dataWithNumber, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.data.attributes.count, 42);
    assertEquals(parsed.data.attributes.enabled, true);
  } finally {
    console.log = originalLog;
  }
});
