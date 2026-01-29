// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import {
  type ModelGetData,
  ModelGetDisplay,
  renderModelGet,
} from "./model_get_output.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

const testDataWithoutResource: ModelGetData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  version: 1,
  tags: { env: "test", project: "demo" },
  attributes: { message: "Hello World" },
};

const testDataWithResource: ModelGetData = {
  ...testDataWithoutResource,
  resource: {
    id: "660e8400-e29b-41d4-a716-446655440001",
    createdAt: "2024-01-15T10:30:00.000Z",
    attributes: { result: "processed", timestamp: "2024-01-15T10:30:00.000Z" },
  },
};

Deno.test({
  name: "ModelGetDisplay renders model name as header",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelGetDisplay data={testDataWithoutResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "test-echo");
  },
});

Deno.test({
  name: "ModelGetDisplay renders model ID",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelGetDisplay data={testDataWithoutResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "550e8400-e29b-41d4-a716-446655440000");
  },
});

Deno.test({
  name: "ModelGetDisplay renders model type",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelGetDisplay data={testDataWithoutResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "swamp/echo");
  },
});

Deno.test({
  name: "ModelGetDisplay renders tags",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelGetDisplay data={testDataWithoutResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "env");
    assertStringIncludes(output, "test");
    assertStringIncludes(output, "project");
    assertStringIncludes(output, "demo");
  },
});

Deno.test({
  name: "ModelGetDisplay renders input attributes",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelGetDisplay data={testDataWithoutResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "message");
    assertStringIncludes(output, "Hello World");
  },
});

Deno.test({
  name: "ModelGetDisplay shows no resource message when resource is undefined",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelGetDisplay data={testDataWithoutResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "no resource created yet");
  },
});

Deno.test({
  name: "ModelGetDisplay renders resource when present",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <ModelGetDisplay data={testDataWithResource} />,
    );
    const output = lastFrame() ?? "";

    assertStringIncludes(output, "660e8400-e29b-41d4-a716-446655440001");
    assertStringIncludes(output, "2024-01-15T10:30:00.000Z");
  },
});

Deno.test("renderModelGet with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testDataWithoutResource, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, testDataWithoutResource.id);
    assertEquals(parsed.name, testDataWithoutResource.name);
    assertEquals(parsed.type, testDataWithoutResource.type);
    assertEquals(parsed.version, testDataWithoutResource.version);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelGet JSON includes resource when present", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testDataWithResource, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.resource.id, "660e8400-e29b-41d4-a716-446655440001");
    assertEquals(parsed.resource.createdAt, "2024-01-15T10:30:00.000Z");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelGet JSON includes tags and attributes", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testDataWithoutResource, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.tags.env, "test");
    assertEquals(parsed.tags.project, "demo");
    assertEquals(parsed.attributes.message, "Hello World");
  } finally {
    console.log = originalLog;
  }
});
